export default {
  inputSchema: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        enum: ["inbox", "starred", "unredactions", "sent", "attachments", "activity"],
        description: "Folder to open",
      },
    },
    required: ["folder"],
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
      view: {
        type: "object",
        properties: {
          doc_id: { type: ["string", "null"] },
          text: { type: "string" },
          structured: {
            anyOf: [{ $ref: "#/definitions/structured" }, { type: "null" }],
          },
        },
        required: ["doc_id", "text", "structured"],
        additionalProperties: false,
      },
    },
    properties: {
      kind: { type: "string", enum: ["list", "view"] },
      url: { type: "string" },
      page_title: { type: "string" },
      total: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
      view: {
        anyOf: [{ $ref: "#/definitions/view" }, { type: "null" }],
      },
    },
    required: ["kind", "url", "page_title", "total", "count", "results", "view"],
    allOf: [
      {
        if: {
          properties: { kind: { const: "list" } },
          required: ["kind"],
        },
        then: {
          properties: { view: { type: "null" } },
        },
      },
      {
        if: {
          properties: { kind: { const: "view" } },
          required: ["kind"],
        },
        then: {
          properties: {
            count: { const: 0 },
            results: { type: "array", maxItems: 0 },
            view: { $ref: "#/definitions/view" },
          },
        },
      },
    ],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Find the requested folder",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          const paths = {
            inbox: "/",
            starred: "/starred",
            unredactions: "/unredactions",
            sent: "/sent",
            attachments: "/attachments",
            activity: "/activity/2014",
          };
          state.path = paths[input.folder];
          state.selector = 'nav a.nav-item[href="' + state.path + '"]';
          return true;
        },
      },
      {
        type: "action",
        description: "Open the folder",
        async run({ input, state, target }) {
          await browser.click(state.selector, undefined, {
            tab: target.tabId,
            activate: true,
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the selected archive view",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.path !== state.path) return false;
          if (page.kind === "view") {
            if (!page.view.text.trim()) return false;
            state.result = {
              kind: "view",
              url: page.route,
              page_title: page.page_title,
              total: page.total,
              count: 0,
              results: [],
              view: {
                doc_id: page.view.doc_id,
                text: page.view.text,
                structured: page.view.structured,
              },
            };
            return true;
          }
          if (page.kind !== "list" || !page.results_ready) return false;
          state.result = {
            kind: "list",
            url: page.route,
            page_title: page.page_title,
            total: page.total,
            count: page.results.length,
            results: page.results,
            view: null,
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
