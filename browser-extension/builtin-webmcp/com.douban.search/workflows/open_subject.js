export default {
  inputSchema: {
    type: "object",
    properties: {
      subject_id: {
        type: "string",
        description: "Numeric subject id from the results (e.g. 38581618)",
      },
    },
    required: ["subject_id"],
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      navigated: { type: "boolean", const: true },
      url: {
        type: "string",
        pattern: "^https://movie\\.douban\\.com/subject/\\d+/$",
      },
    },
    required: ["navigated", "url"],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Open the movie or TV detail page",
    async run({ input, state, target }) {
      const id = String(input.subject_id).trim();
      if (!/^\d+$/.test(id)) throw new Error("subject_id must be numeric");
      const url = "https://movie.douban.com/subject/" + id + "/";
      await browser.goto(url, {
        tab: target.tabId,
        "wait-until": "domcontentloaded",
        timeout: 15000,
      });
      state.result = { navigated: true, url };
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
