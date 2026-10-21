export default {
  inputSchema: {
    type: "object",
    properties: {
      start: {
        type: "number",
        description: "0-based row offset, multiple of 25 (default 0)",
        minimum: 0,
        maximum: 225,
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      range: {
        type: "object",
        properties: {
          from: { type: "integer", minimum: 1 },
          to: { type: "integer", minimum: 0 },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: {
          type: "object",
          properties: {
            rank: { type: "integer", minimum: 1 },
            title: { type: "string" },
            rating: { type: "string" },
            url: { type: "string" },
            subject_id: { type: "string" },
            detail: { type: "string" },
          },
          required: ["rank", "title", "rating", "url", "subject_id"],
          additionalProperties: false,
        },
      },
      next_start: { type: ["integer", "null"], minimum: 0 },
    },
    required: ["range", "count", "results", "next_start"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Open the requested Top 250 page",
        async run({ input, state, target }) {
          state.start = Number(input.start) || 0;
          if (!Number.isInteger(state.start) || state.start % 25)
            throw new Error("start must be a multiple of 25");
          await browser.goto("https://movie.douban.com/top250?start=" + state.start, {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read this page of Top 250",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            { limit: 25 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.kind !== "top250" || page.start !== state.start || !page.results_ready)
            return false;
          state.result = {
            range: { from: state.start + 1, to: state.start + page.results.length },
            count: page.results.length,
            results: page.results,
            next_start: state.start + 25 < 250 ? state.start + 25 : null,
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
