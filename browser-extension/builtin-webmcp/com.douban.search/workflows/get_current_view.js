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
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      url: { type: "string", minLength: 1 },
      page_title: { type: "string" },
      query: { type: "string" },
      count: { type: "integer", minimum: 0, maximum: 25 },
      results: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 0, maximum: 24 },
            title: { type: "string", minLength: 1 },
            rating: { type: "string", minLength: 1 },
            url: { type: "string", minLength: 1 },
            subject_id: {
              type: ["string", "null"],
              pattern: "^\\d+$",
            },
            detail: { type: "string" },
          },
          required: ["index", "title", "rating", "url", "subject_id", "detail"],
          additionalProperties: false,
        },
      },
    },
    required: ["url", "page_title", "query", "count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "wait",
    description: "Read the current view",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "com.douban.search.read_page",
        { limit: input.limit || 10 },
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      if (!page.results_ready) return false;
      state.result = {
        url: page.route,
        page_title: page.page_title,
        query: page.query,
        count: page.results.length,
        results: page.results,
      };
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
