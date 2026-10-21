export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    properties: {
      url: { type: "string" },
      page_title: { type: "string" },
      is_subject_page: { type: "boolean" },
      text: { type: "string" },
      title: { type: "string" },
      year: { type: "string" },
      rating: { type: "string" },
      rating_people: { type: "string" },
      star_distribution: {
        type: "array",
        maxItems: 5,
        items: { $ref: "#/definitions/starDistribution" },
      },
      info: { type: "object", additionalProperties: { type: "string" } },
      summary: { type: "string" },
      hot_comments: {
        type: "array",
        maxItems: 10,
        items: { $ref: "#/definitions/hotComment" },
      },
      is_celebrity_page: { type: "boolean" },
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
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        maxItems: 10,
        items: { $ref: "#/definitions/searchResult" },
      },
    },
    required: ["url", "page_title"],
    oneOf: [
      {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_subject_page: { const: false },
          text: { type: "string" },
        },
        required: ["url", "page_title", "is_subject_page", "text"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_subject_page: { const: true },
          title: { type: "string" },
          year: { type: "string" },
          rating: { type: "string" },
          rating_people: { type: "string" },
          star_distribution: {
            type: "array",
            maxItems: 5,
            items: { $ref: "#/definitions/starDistribution" },
          },
          info: { type: "object", additionalProperties: { type: "string" } },
          summary: { type: "string" },
          hot_comments: {
            type: "array",
            maxItems: 10,
            items: { $ref: "#/definitions/hotComment" },
          },
        },
        required: [
          "url",
          "page_title",
          "is_subject_page",
          "title",
          "year",
          "rating",
          "rating_people",
          "star_distribution",
          "info",
          "summary",
          "hot_comments",
        ],
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
      {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          count: { type: "integer", minimum: 0 },
          results: {
            type: "array",
            maxItems: 10,
            items: { $ref: "#/definitions/searchResult" },
          },
        },
        required: ["url", "page_title", "count", "results"],
        additionalProperties: false,
      },
    ],
    definitions: {
      searchResult: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          title: { type: "string" },
          rating: { type: "string" },
          url: { type: "string" },
          subject_id: { type: ["string", "null"] },
          detail: { type: "string" },
        },
        required: ["index", "title", "rating", "url", "subject_id", "detail"],
        additionalProperties: false,
      },
      starDistribution: {
        type: "object",
        properties: {
          stars: { type: "string" },
          percent: { type: "string" },
        },
        required: ["stars", "percent"],
        additionalProperties: false,
      },
      hotComment: {
        type: "object",
        properties: {
          author: { type: "string" },
          date: { type: "string" },
          stars: { type: "string" },
          votes: { type: "string" },
          text: { type: "string" },
        },
        required: ["author", "date", "stars", "votes", "text"],
        additionalProperties: false,
      },
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
    type: "wait",
    description: "Read the current view",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "com.douban.movie.read_page",
        {},
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      state.result = page.view || {
        url: page.path,
        page_title: page.page_title,
        count: page.results?.length || 0,
        results: page.results || [],
      };
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
