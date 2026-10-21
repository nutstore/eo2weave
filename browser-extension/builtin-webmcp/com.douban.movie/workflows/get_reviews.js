export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max reviews to return (default 5, max 10)",
        minimum: 1,
        maximum: 10,
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      count: { type: "integer", minimum: 0 },
      reviews: {
        type: "array",
        items: {
          type: "object",
          properties: {
            review_id: { type: ["string", "null"] },
            title: { type: "string" },
            author: { type: "string" },
            date: { type: "string" },
            spoiler: { type: "boolean" },
            excerpt: { type: "string" },
            url: { type: ["string", "null"] },
          },
          required: ["review_id", "title", "author", "date", "spoiler", "excerpt", "url"],
          additionalProperties: false,
        },
      },
    },
    required: ["subject", "count", "reviews"],
    additionalProperties: false,
  },
  tree: {
    type: "wait",
    description: "Read reviews on the current subject",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "com.douban.movie.read_page",
        { limit: input.limit || 5 },
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      if (page.kind !== "subject") throw new Error("Open a movie or TV detail page first");
      state.result = {
        subject: page.view.title,
        count: page.reviews.length,
        reviews: page.reviews,
      };
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
