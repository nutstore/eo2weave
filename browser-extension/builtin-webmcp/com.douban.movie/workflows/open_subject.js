export default {
  inputSchema: {
    type: "object",
    properties: {
      subject_id: {
        type: "string",
        description:
          "Numeric subject id from search/now_playing/weekly results (e.g. 1292052)",
      },
    },
    required: ["subject_id"],
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
