export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    properties: {
      navigated: { const: true },
      url: { type: "string" },
    },
    required: ["navigated", "url"],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Navigate to the requested application",
    async run({ input, state, target }) {
      await browser.goto("https://movie.douban.com/", {
        tab: target.tabId,
        "wait-until": "domcontentloaded",
        timeout: 15000,
      });
      state.result = { navigated: true, url: "https://movie.douban.com/" };
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
