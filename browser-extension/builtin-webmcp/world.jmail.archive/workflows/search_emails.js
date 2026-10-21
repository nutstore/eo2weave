export default {
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords",
        minLength: 1,
        pattern: "\\S",
      },
      limit: {
        type: "number",
        description: "Max threads to return (default 10)",
        minimum: 1,
        maximum: 25,
      },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer", minimum: 0 },
      results: { type: "array", items: { type: "object" } },
    },
    required: ["query", "count", "results"],
    additionalProperties: true,
  },
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      // Running actions observe again; the submitted flag prevents repeated writes.
      state.deadline ??= Date.now() + 10000;
      if (Date.now() > state.deadline)
        throw new Error("Search timed out waiting for matching results");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      state.nextReadAt = Date.now() + 250;
      const query =
        input.query.trim() +
        (input.tags ? " " + String(input.tags).trim() : "");
      const source = `() => {
const args = __INPUT__;
if (!args.__submitted && location.origin !== 'https://jmail.world') return {pageReady:false};
if (document.readyState === 'loading' || !document.body) return {pageReady:false};
const control=document.querySelector('input[name="q"]');
if (!control || !Object.keys(control).some(key => key.startsWith('__reactProps$'))) return {pageReady:false};

const query = String(args.query || '').trim();
const rows = readRows(Math.max(1, Math.min(25, Number(args.limit) || 10)));
const total = readTotalCount();
const correctQuery = location.pathname === '/search' && new URL(location.href).searchParams.get('q') === query;
const searchInputCount = Array.from(document.querySelectorAll("input[name=\\"q\\"]")).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').length;
return {searchInputCount, ready: correctQuery && (rows.length > 0 || total === '0'), result: {query, total_matches: total, count: rows.length, results: rows}};
}`.replace("__INPUT__", () =>
        JSON.stringify({ ...input, __submitted: !!state.submitted }),
      );
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
      if (output.exitCode !== 0) {
        if (
          /execution context was destroyed|cannot find context with specified id|cannot find default execution context/i.test(
            output.stderr,
          )
        )
          return "running";
        throw new Error(output.stderr);
      }
      const page = JSON.parse(output.stdout);
      if (page.tabId !== target.tabId)
        throw new Error("Browser returned another tab");
      const observed = page.result;
      if (observed.pageReady === false) return "running";
      if (observed.ready) {
        state.result = observed.result;
        return "success";
      }
      if (!state.submitted) {
        if (observed.searchInputCount > 1)
          throw new Error("Search input is ambiguous");
        let command;
        if (observed.searchInputCount === 0) return "running";
        {
          const text = "'" + query.replace(/'/g, "'\"'\"'") + "'";
          command =
            "browser fill --tab=" +
            target.tabId +
            " -- " +
            "'input[name=\"q\"]'" +
            " " +
            text +
            " && browser press --tab=" +
            target.tabId +
            " -- Enter";
        }
        const action = await tools.bash({ command, timeout: 15000 });
        if (action.exitCode !== 0) throw new Error(action.stderr);
        if (action.truncated) throw new Error("Browser output was truncated");
        state.submitted = true;
        state.deadline = Date.now() + 20000;
      }
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
