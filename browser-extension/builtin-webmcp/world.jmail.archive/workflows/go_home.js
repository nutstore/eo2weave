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
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const action = await tools.bash({
            command: `browser goto --tab=${target.tabId} --wait-until=domcontentloaded -- 'https://jmail.world/'`,
            timeout: 15000,
          });
          if (action.truncated) throw new Error("Browser output was truncated");
          if (action.exitCode !== 0) throw new Error(action.stderr);
          return "success";
        },
      },
      {
        type: "wait",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target, packageRoot }) {
          const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
if (location.pathname !== '/') return null;
const rows = readRows(5);
return rows.length ? {url:location.pathname,page_title:document.title,inbox_count:readTotalCount(),latest:rows,hint:'Inbox loaded. Use search_emails or open_result to explore.'} : null;
}`.replace("__INPUT__", () => JSON.stringify(input));
          const output = await tools.bash({
            command: `reader=$(cat '${packageRoot}readers/dom.js') || exit 1
page_source='${source.replace(/'/g, "'\"'\"'")}'
browser eval --tab=${target.tabId} "() => {
$reader
return ($page_source)();
}"`,
            timeout: 15000,
          });
          if (output.truncated) throw new Error("Browser output was truncated");
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (!value) return false;
          state.result = value;
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
