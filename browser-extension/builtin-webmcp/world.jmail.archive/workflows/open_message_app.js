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
      await browser.goto("https://jmail.world/messages", {
        tab: target.tabId,
        "wait-until": "domcontentloaded",
        timeout: 15000,
      });
      state.result = { navigated: true, url: "https://jmail.world/messages" };
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
