export default {
  inputSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: ["home", "nowplaying", "coming", "explore", "tv", "chart", "reviews"],
        description: "Section to open",
      },
    },
    required: ["section"],
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
    description: "Open the selected Douban section",
    async run({ input, state, target }) {
      const sections = {
        home: "/",
        nowplaying: "/cinema/nowplaying/",
        coming: "/cinema/later/",
        explore: "/explore",
        tv: "/tv/",
        chart: "/chart",
        reviews: "/review/best/",
      };
      const url = "https://movie.douban.com" + sections[input.section];
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
