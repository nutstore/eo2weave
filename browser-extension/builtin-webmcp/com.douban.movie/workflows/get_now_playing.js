export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max movies to return (default 10, max 30)",
        minimum: 1,
        maximum: 30,
      },
    },
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

function readNowPlaying(limit) {
    const items = Array.from(document.querySelectorAll('#screening li.ui-slide-item'));
    const out = [];
    for (const li of items) {
        const d = li.dataset || {};
        const title = cleanText(d.title);
        if (!title)
            continue;
        const link = li.querySelector('a.title[href*="/subject/"]');
        const m = link?.getAttribute('href')?.match(/subject\\/(\\d+)/);
        out.push({
            index: out.length,
            title,
            rating: cleanText(d.rating) || '暂无评分',
            subject_id: m ? m[1] : null,
            url: link?.href || null,
            release: cleanText(d.release),
            region: cleanText(d.region),
            director: cleanText(d.director),
            actors: cleanText(d.actors),
        });
        if (out.length >= limit)
            break;
    }
    return out;
}
const args = __INPUT__;
const limit = Math.max(1, Math.min(30, Number(args?.limit) || 10));
const rows = readNowPlaying(limit);
if (rows.length === 0) {
    return softNavigate('https://movie.douban.com/', 'Navigating to the homepage. Call get_now_playing again in a few seconds.');
}
return {
    count: rows.length,
    results: rows,
    hint: 'Use open_subject with subject_id to read a movie\\'s details and comments.',
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
