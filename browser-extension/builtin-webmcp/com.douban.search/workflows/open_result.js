export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from the results list",
        minimum: 0,
      },
    },
    required: ["index"],
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      navigated: { type: "boolean", const: true },
      url: { type: "string", minLength: 1 },
      title: { type: "string", minLength: 1 },
    },
    required: ["navigated", "url", "title"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Read the ordered results",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.search.read_page",
            { limit: 25 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.kind !== "search" || !page.results_ready) return false;
          const index = Number(input.index);
          if (!Number.isInteger(index) || index < 0)
            throw new Error("index must be a non-negative integer");
          const row = page.results[index];
          if (!row?.url) throw new Error("No result row at index " + index);
          state.selection = row;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the selected result",
        async run({ input, state, target }) {
          await browser.goto(state.selection.url, {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          state.result = {
            navigated: true,
            url: state.selection.url,
            title: state.selection.title,
          };
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
