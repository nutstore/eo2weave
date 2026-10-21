export default {
  inputSchema: {
    type: "object",
    properties: {
      episode_limit: {
        type: "number",
        description: "Max episodes to return (default 30)",
        minimum: 1,
        maximum: 100,
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      episode_count: { type: ["string", "null"] },
      series: {
        type: ["object", "null"],
        properties: {
          key: { type: ["string", "null"] },
          url: { type: "string" },
        },
        required: ["key", "url"],
        additionalProperties: false,
      },
      seasons: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            season: { type: "string" },
            subject_id: { type: "string" },
          },
          required: ["season", "subject_id"],
          additionalProperties: false,
        },
      },
      episodes: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            episode: { type: "string" },
            title: { type: "string" },
            rating: { type: "string" },
            url: { type: ["string", "null"] },
          },
          required: ["episode", "title", "rating", "url"],
          additionalProperties: false,
        },
      },
      note: { type: "string" },
    },
    required: ["subject", "episode_count", "series"],
    additionalProperties: false,
  },
  tree: {
    type: "wait",
    description: "Read TV seasons and episodes",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "com.douban.movie.read_page",
        { limit: input.episode_limit || 30 },
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      if (page.kind !== "subject") throw new Error("Open a movie or TV detail page first");
      state.result = page.tv;
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
