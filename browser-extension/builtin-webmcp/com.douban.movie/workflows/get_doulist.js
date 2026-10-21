export default {
  inputSchema: {
    type: "object",
    properties: {
      list_id: {
        type: "string",
        description: "Numeric doulist id (e.g. 240962)",
      },
      start: {
        type: "number",
        description: "0-based item offset, multiple of 25 (default 0)",
        minimum: 0,
      },
    },
    required: ["list_id"],
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

const args = __INPUT__;
const raw = String(args.list_id || args.url || '').trim();
const id = raw.match(/(\\d{3,})/)?.[1];
if (!id)
    throw new Error('list_id is required (numeric doulist id, e.g. 240962)');
const start = Math.max(0, Number(args?.start) || 0);
if (!/\\/doulist\\//.test(location.pathname)) {
    return softNavigate(\`https://movie.douban.com/doulist/\${id}/?start=\${start}\`, 'Navigating to the doulist page. Call get_doulist with the same list_id/start again in a few seconds to read it.');
}
const title = cleanText(document.querySelector('#content h1')?.textContent);
const desc = cleanText(document.querySelector('.doulist-note, #content .intro')?.textContent);
const rows = readSubjectListRows(25, '#content');
return {
    list_id: id,
    title,
    description: desc || undefined,
    start,
    count: rows.length,
    results: rows,
    next_start: rows.length === 25 ? start + 25 : null,
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
