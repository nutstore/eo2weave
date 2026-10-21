export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: true,
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        intervalMs: 200,
        timeoutMs: 10000,
        async inspect({ input, target }) {
          const source =
            `() => (location.origin === 'https://movie.douban.com') && document.readyState !== 'loading' && !!document.body`.replace(
              "__INPUT__",
              () => JSON.stringify(input),
            );
          const output = await tools.bash({
            command:
              "browser eval --tab=" +
              target.tabId +
              " -- " +
              "'" +
              source.replace(/'/g, "'\"'\"'") +
              "'",
            timeout: 15000,
          });
          if (output.truncated) throw new Error("Browser output was truncated");
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          return value === true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const source = `async () => {
function softNavigate(url, note) {
    // Return a plan; the SW action performs and awaits browser navigation.
    return { navigated: true, url, note };
}

function readWeeklyChart() {
    const root = document.querySelector('#weekly') ||
        Array.from(document.querySelectorAll('div, section'))
            .find((el) => cleanText(el.textContent).startsWith('一周口碑榜') && el.querySelector('a[href*="/subject/"]'))
        || null;
    if (!root)
        return [];
    const out = [];
    for (const tr of Array.from(root.querySelectorAll('tr'))) {
        const link = tr.querySelector('a[href*="/subject/"]');
        const title = cleanText(link?.textContent);
        if (!link || !title)
            continue;
        const m = link.getAttribute('href')?.match(/subject\\/(\\d+)/);
        out.push({
            rank: out.length + 1,
            title,
            rating: cleanText(tr.querySelector('.rating_nums')?.textContent),
            url: link.href,
            subject_id: m ? m[1] : null,
        });
    }
    return out;
}
const args = __INPUT__;
const rows = readWeeklyChart();
if (rows.length === 0) {
    return softNavigate('https://movie.douban.com/', 'The weekly chart lives on the homepage. Navigating there — call get_weekly_chart again in a few seconds.');
}
return {
    count: rows.length,
    results: rows,
    hint: 'Use open_subject with subject_id to read a movie\\'s details.',
};
}`.replace("__INPUT__", () => JSON.stringify(input));
          const output = await tools.bash({
            command: `reader=$(cat '${packageRoot}readers/dom.js') || exit 1
page_source='${source.replace(/'/g, "'\"'\"'")}'
browser eval --tab=${target.tabId} "async () => {
$reader
return await ($page_source)();
}"`,
            timeout: 15000,
          });
          if (output.truncated) throw new Error("Browser output was truncated");
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (value && typeof value.error === "string")
            throw new Error(value.error);
          if (value?.navigated === true && typeof value.url === "string") {
            const url = "'" + value.url.replace(/'/g, "'\"'\"'") + "'";
            const navigation = await tools.bash({
              command:
                "browser goto --tab=" +
                target.tabId +
                " --wait-until=domcontentloaded -- " +
                url,
              timeout: 15000,
            });
            if (navigation.exitCode !== 0) throw new Error(navigation.stderr);
          }
          state.result = value;
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
