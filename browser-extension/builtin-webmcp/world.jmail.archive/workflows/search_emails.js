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
    definitions: {
      email_row: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          sender: { type: "string" },
          subject: { type: "string" },
          date: { type: "string" },
          preview: { type: "string" },
          doc_id: { type: ["string", "null"] },
          selector: { type: ["string", "null"] },
          interactive: { type: "boolean" },
        },
        required: [
          "index",
          "sender",
          "subject",
          "date",
          "preview",
          "doc_id",
          "selector",
          "interactive",
        ],
        additionalProperties: false,
      },
    },
    properties: {
      query: { type: "string" },
      total_matches: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["query", "total_matches", "count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Wait for the archive search control",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          return page.search_ready;
        },
      },
      {
        type: "action",
        description: "Submit the email search",
        async run({ input, state, target }) {
          state.query = input.query.trim();
          await browser.fill('input[name="q"]', state.query, {
            tab: target.tabId,
            timeout: 15000,
          });
          await browser.press("Enter", { tab: target.tabId, timeout: 15000 });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for results belonging to this query",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            { limit: input.limit || 10, query: state.query },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.path !== "/search" || page.query !== state.query || !page.results_ready)
            return false;
          state.result = {
            query: page.query,
            total_matches: page.total,
            count: page.results.length,
            results: page.results,
          };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
