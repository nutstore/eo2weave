export default {
  inputSchema: {
    type: "object",
    properties: {
      celebrity_id: {
        type: "string",
        description:
          "Numeric celebrity id (e.g. 1274297 from a subject page link)",
      },
    },
    required: ["celebrity_id"],
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

function readCelebrityView() {
    const isCelebrity = /\\/celebrity\\/\\d+/.test(location.pathname);
    const base = {
        url: location.pathname + location.search,
        page_title: cleanText(document.title),
    };
    if (!isCelebrity) {
        const main = document.querySelector('#content') || document.body;
        return { ...base, is_celebrity_page: false, text: cleanText(main.innerText).slice(0, 4000) };
    }
    const name = cleanText(document.querySelector('#content h1')?.textContent);
    const bio = cleanText(Array.from(document.querySelectorAll('#intro p')).map((p) => p.textContent || '').join('\\n'));
    const works = {};
    for (const mod of Array.from(document.querySelectorAll('#content .mod'))) {
        const heading = cleanText(mod.querySelector('h2')?.textContent);
        if (!heading)
            continue;
        const rows = Array.from(mod.querySelectorAll('a[href*="/subject/"]')).slice(0, 10).map((a) => {
            const m = a.getAttribute('href')?.match(/subject\\/(\\d+)/);
            const container = a.closest('.ob, li, div') || a.parentElement;
            return {
                title: cleanText(a.textContent).replace(/\\s*\\(\\d{4}\\)\\s*$/, '').trim(),
                rating: cleanText(container?.querySelector('.rating_nums')?.textContent),
                subject_id: m?.[1] || '',
            };
        }).filter((r) => r.title && r.subject_id);
        if (rows.length)
            works[heading] = rows;
    }
    const awards = cleanText(Array.from(document.querySelectorAll('#award-block, [data-category="awards"]')).map((el) => el.innerText || '').join('\\n')).slice(0, 1500);
    const photo = document.querySelector('#mainpic img, #content .avatar')?.src || null;
    return {
        ...base,
        is_celebrity_page: true,
        name,
        photo,
        bio: bio.slice(0, 2500),
        filmography: works,
        awards: awards || undefined,
    };
}
const args = __INPUT__;
const raw = String(args.celebrity_id || args.url || '').trim();
const id = raw.match(/(\\d{3,})/)?.[1];
if (!id)
    throw new Error('celebrity_id is required (numeric id, e.g. 1274297)');
if (location.pathname === \`/celebrity/\${id}/\`) {
    return readCelebrityView();
}
return softNavigate(\`https://movie.douban.com/celebrity/\${id}/\`, 'Opening the celebrity page. Call open_celebrity with the same id again in a few seconds to read it (name, bio, filmography, awards).');
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
