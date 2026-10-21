export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      navigated: { const: true },
      url: { const: "https://jmail.world/" },
    },
    required: ["navigated", "url"],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Navigate to the requested application",
    async run({ input, state, target }) {
      await browser.goto("https://jmail.world/", {
        tab: target.tabId,
        "wait-until": "domcontentloaded",
        timeout: 15000,
      });
      state.result = { navigated: true, url: "https://jmail.world/" };
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
