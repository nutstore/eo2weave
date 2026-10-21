export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    definitions: {
      structured: {
        type: "object",
        properties: {
          headline: { type: "string" },
          author: { type: "string" },
          datePublished: { type: "string" },
          description: { type: "string" },
        },
        minProperties: 1,
        additionalProperties: false,
      },
      email_row: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          sender: { type: "string" },
          subject: { type: "string" },
          date: { type: "string" },
          preview: { type: "string" },
          doc_id: { type: ["string", "null"] },
          selector: { type: ["string", "null"] },
          interactive: { type: "boolean" },
        },
        required: [
          "index",
          "sender",
          "subject",
          "date",
          "preview",
          "doc_id",
          "selector",
          "interactive",
        ],
        additionalProperties: false,
      },
      thread_view: {
        type: "object",
        properties: {
          url: { type: "string" },
          doc_id: { type: ["string", "null"] },
          page_title: { type: "string" },
          text: { type: "string" },
          structured: {
            anyOf: [{ $ref: "#/definitions/structured" }, { type: "null" }],
          },
        },
        required: ["url", "doc_id", "page_title", "text", "structured"],
        additionalProperties: false,
      },
      list_view: {
        type: "object",
        properties: {
          url: { type: "string" },
          doc_id: { type: ["string", "null"] },
          page_title: { type: "string" },
          text: { type: "string" },
          structured: {
            anyOf: [{ $ref: "#/definitions/structured" }, { type: "null" }],
          },
          total: { type: ["string", "null"] },
          count: { type: "integer", minimum: 0 },
          results: {
            type: "array",
            items: { $ref: "#/definitions/email_row" },
          },
        },
        required: [
          "url",
          "doc_id",
          "page_title",
          "text",
          "structured",
          "total",
          "count",
          "results",
        ],
        additionalProperties: false,
      },
    },
    properties: {
      url: { type: "string" },
      doc_id: { type: ["string", "null"] },
      page_title: { type: "string" },
      text: { type: "string" },
      structured: {
        anyOf: [{ $ref: "#/definitions/structured" }, { type: "null" }],
      },
      total: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["url", "doc_id", "page_title", "text", "structured"],
    oneOf: [
      { $ref: "#/definitions/thread_view" },
      { $ref: "#/definitions/list_view" },
    ],
    additionalProperties: false,
  },
  tree: {
    type: "wait",
    description: "Read the current view",
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
      state.result =
        page.kind === "thread"
          ? page.thread
          : {
              ...page.view,
              url: page.route,
              page_title: page.page_title,
              total: page.total,
              count: page.results.length,
              results: page.results,
            };
      return page.kind === "thread"
        ? !!page.thread.text.trim()
        : page.kind === "view"
          ? !!page.view.text.trim()
          : page.results_ready;
    },
  },
  result({ state }) {
    return state.result;
  },
};
