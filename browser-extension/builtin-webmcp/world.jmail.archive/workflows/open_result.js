export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from search_emails results",
        minimum: 0,
      },
    },
    required: ["index"],
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
    },
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
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Select an email from the current results",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            { limit: 100 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          const index = Number(input.index);
          if (!Number.isInteger(index) || index < 0)
            throw new Error("index must be a non-negative integer");
          if (!page.results_ready) return false;
          const row = page.results.find((row) => row.index === index);
          if (!row) throw new Error("No result row at index " + index);
          if (!row.interactive) return false;
          state.selector = row.selector;
          state.docId = row.doc_id;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the selected email",
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
        description: "Wait for the selected thread",
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
          if (
            page.kind !== "thread" ||
            (state.docId && page.thread.doc_id !== state.docId) ||
            !page.thread.text.trim()
          )
            return false;
          state.result = page.thread;
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
