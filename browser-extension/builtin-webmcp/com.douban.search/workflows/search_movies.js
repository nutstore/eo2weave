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
        description: "Max results to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
    },
    required: ["query"],
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      query: { type: "string", minLength: 1 },
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
    required: ["query", "count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Submit the requested movie search",
        async run({ input, state, target }) {
          state.query =
            input.query.trim() + (input.tags?.trim() ? " " + input.tags.trim() : "");
          const url =
            "https://search.douban.com/movie/subject_search?search_text=" +
            encodeURIComponent(state.query) +
            "&cat=1002";
          await browser.goto(url, {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for results of this exact query",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.search.read_page",
            { limit: input.limit || 10, query: state.query },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.kind !== "search" || page.query !== state.query || !page.results_ready)
            return false;
          state.result = {
            query: page.query,
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
