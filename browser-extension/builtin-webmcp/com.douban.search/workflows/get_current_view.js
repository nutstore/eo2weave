export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max rows to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "wait",
    intervalMs: 200,
    timeoutMs: 10000,
    async inspect({ input, state, target, packageRoot }) {
      const source = `async () => {
if (!(location.origin === 'https://search.douban.com') || document.readyState === 'loading' || !document.body) return {ready: false};

const args = __INPUT__;
return {ready: true, result: await (async () => {
const limit = Math.max(1, Math.min(25, Number(args?.limit) || 10));
const rows = readSearchResults(limit);
return {
    url: location.pathname + location.search,
    page_title: cleanText(document.title),
    query: (new URLSearchParams(location.search).get('search_text')) || null,
    count: rows.length,
    results: rows,
    hint: rows.length
        ? 'Use open_result with the row index (or open_subject with subject_id) to open a movie.'
        : 'No result rows rendered — if the page is still loading, call get_current_view again in a few seconds.',
};
})()};
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
      if (!value.ready) return false;
      if (value.result && typeof value.result.error === "string")
        throw new Error(value.result.error);
      state.result = value.result;
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
