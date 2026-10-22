export default {
  inputSchema: {
    type: "object",
    properties: {
      list_id: {
        type: "string",
        description: "Numeric doulist id (e.g. 240962)",
      },
      start: {
        type: "number",
        description: "0-based item offset, multiple of 25 (default 0)",
        minimum: 0,
      },
    },
    required: ["list_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      navigated: { const: true },
      url: { type: "string" },
      list_id: { type: "string" },
      title: { type: "string" },
      description: { type: "string" },
      start: { type: "integer", minimum: 0 },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/subjectListRow" },
      },
      next_start: { type: ["integer", "null"], minimum: 0 },
    },
    required: [],
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
          list_id: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          start: { type: "integer", minimum: 0 },
          count: { type: "integer", minimum: 0 },
          results: {
            type: "array",
            items: { $ref: "#/definitions/subjectListRow" },
          },
          next_start: { type: ["integer", "null"], minimum: 0 },
        },
        required: ["list_id", "title", "description", "start", "count", "results", "next_start"],
        additionalProperties: false,
      },
    ],
    definitions: {
      subjectListRow: {
        type: "object",
        properties: {
          rank: { type: "integer", minimum: 1 },
          title: { type: "string" },
          rating: { type: "string" },
          url: { type: "string" },
          subject_id: { type: "string" },
          detail: { type: "string" },
        },
        required: ["rank", "title", "rating", "url", "subject_id"],
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
        description: "Open the requested doulist page",
        async run({ input, state, target }) {
          const id = String(input.list_id).trim();
          if (!/^\d+$/.test(id)) throw new Error("list_id must be numeric");
          state.id = id;
          state.start = Number(input.start) || 0;
          if (!Number.isInteger(state.start)) throw new Error("start must be an integer");
          state.navigation = await browser.goto(
            "https://movie.douban.com/doulist/" + id + "/?start=" + state.start,
            { tab: target.tabId, "wait-until": "domcontentloaded", timeout: 15000 },
          );
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the requested doulist",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          // Legacy movie.douban.com doulists redirect to www.douban.com.
          if (!/^https:\/\/(?:movie|www)\.douban\.com\/doulist\//.test(state.navigation.url)) {
            state.result = { navigated: true, url: state.navigation.url };
            return true;
          }
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            { limit: 25 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (
            page.kind !== "doulist" ||
            page.path !== "/doulist/" + state.id + "/" ||
            page.start !== state.start ||
            !page.results_ready
          )
            return false;
          state.result = {
            list_id: state.id,
            title: page.title,
            description: page.description,
            start: state.start,
            count: page.results.length,
            results: page.results,
            next_start: page.results.length === 25 ? state.start + 25 : null,
          };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
