export default {
  inputSchema: {
    type: "object",
    properties: {
      celebrity_id: {
        type: "string",
        description: "Numeric celebrity id (e.g. 1274297 from a subject page link)",
      },
    },
    required: ["celebrity_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      navigated: { const: true },
      url: { type: "string" },
      page_title: { type: "string" },
      is_celebrity_page: { const: true },
      name: { type: "string" },
      photo: { type: ["string", "null"] },
      bio: { type: "string" },
      filmography: {
        type: "object",
        additionalProperties: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: { $ref: "#/definitions/celebrityWorkRow" },
        },
      },
      awards: { type: "string" },
    },
    required: ["url"],
    oneOf: [
      {
        type: "object",
        properties: {
          navigated: { const: true },
          url: { type: "string" },
        },
        required: ["navigated", "url"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_celebrity_page: { const: true },
          name: { type: "string" },
          photo: { type: ["string", "null"] },
          bio: { type: "string" },
          filmography: {
            type: "object",
            additionalProperties: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: { $ref: "#/definitions/celebrityWorkRow" },
            },
          },
          awards: { type: "string" },
        },
        required: [
          "url",
          "page_title",
          "is_celebrity_page",
          "name",
          "photo",
          "bio",
          "filmography",
        ],
        additionalProperties: false,
      },
    ],
    definitions: {
      celebrityWorkRow: {
        type: "object",
        properties: {
          title: { type: "string" },
          rating: { type: "string" },
          subject_id: { type: "string" },
        },
        required: ["title", "rating", "subject_id"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Open the celebrity page",
        async run({ input, state, target }) {
          const id = String(input.celebrity_id).trim();
          if (!/^\d+$/.test(id)) throw new Error("celebrity_id must be numeric");
          state.path = "/celebrity/" + id + "/";
          state.navigation = await browser.goto("https://movie.douban.com" + state.path, {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the celebrity profile",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const personagePath = state.navigation.url.match(
            /^https:\/\/www\.douban\.com(\/personage\/\d+\/)(?:[?#]|$)/,
          )?.[1];
          if (personagePath) state.path = personagePath;
          // Verification and other unsupported redirects have no profile to read.
          if (!personagePath && !state.navigation.url.startsWith("https://movie.douban.com/")) {
            state.result = { navigated: true, url: state.navigation.url };
            return true;
          }
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.kind !== "celebrity" || page.path !== state.path || !page.view.name)
            return false;
          state.result = page.view;
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
