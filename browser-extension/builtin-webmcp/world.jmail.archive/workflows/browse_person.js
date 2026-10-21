export default {
  inputSchema: {
    type: "object",
    properties: {
      person: {
        type: "string",
        description: "Person slug from list_people (e.g. ghislaine-maxwell)",
      },
    },
    required: ["person"],
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
          page_title: { type: "string" },
          total: { type: ["string", "null"] },
          results: {
            type: "array",
            items: { $ref: "#/definitions/email_row" },
          },
        },
        required: ["url", "page_title", "total", "results"],
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
      results: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["url", "page_title"],
    oneOf: [
      { $ref: "#/definitions/thread_view" },
      { $ref: "#/definitions/list_view" },
    ],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Find the requested person",
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
          const slug = input.person.trim();
          const link = page.people.find((link) => link.slug === slug);
          if (!link) throw new Error("No person link for " + slug);
          state.path = link.path;
          state.selector = link.selector;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the person",
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
          if (page.kind !== "thread" && !page.results_ready) return false;
          state.result =
            page.kind === "thread"
              ? page.thread
              : {
                  url: page.route,
                  page_title: page.page_title,
                  total: page.total,
                  results: page.results,
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
