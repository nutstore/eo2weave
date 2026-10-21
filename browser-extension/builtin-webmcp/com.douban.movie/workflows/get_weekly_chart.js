export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "integer", minimum: 1 },
            title: { type: "string" },
            rating: { type: "string" },
            url: { type: "string" },
            subject_id: { type: ["string", "null"] },
          },
          required: ["rank", "title", "rating", "url", "subject_id"],
          additionalProperties: false,
        },
      },
    },
    required: ["count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Open the list page",
        async run({ input, state, target }) {
          await browser.goto("https://movie.douban.com/", {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the requested movie list",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            { limit: input.limit || 10 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.path !== "/") return false;
          const results = page.weekly;
          if (!results?.length) return false;
          state.result = { count: results.length, results };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
