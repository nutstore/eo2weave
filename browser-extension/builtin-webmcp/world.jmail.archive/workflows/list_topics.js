export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 0 },
      topics: {
        type: "array",
        items: {
          type: "object",
          properties: {
            slug: { type: "string" },
            label: { type: "string" },
          },
          required: ["slug", "label"],
          additionalProperties: false,
        },
      },
    },
    required: ["count", "topics"],
    additionalProperties: false,
  },
  tree: {
    type: "wait",
    description: "Read available topics",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "world.jmail.archive.read_page",
        {},
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      state.result = {
        count: page.topics.length,
        topics: page.topics.map(({ slug, label }) => ({ slug, label })),
      };
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
