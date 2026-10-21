export default {
  inputSchema: {
    type: "object",
    properties: {
      doc_id: {
        type: "string",
        description: "Thread doc id from search_emails results (e.g. HOUSE_OVERSIGHT_016203)",
      },
    },
    required: ["doc_id"],
  },
  outputSchema: {
    type: "object",
    properties: {
      doc_id: {
        type: "string",
        pattern: "^[A-Za-z0-9_.-]+$",
      },
      navigated: { const: true },
      url: { type: "string" },
    },
    required: ["doc_id", "navigated", "url"],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Open a thread by document ID",
    async run({ input, state, target }) {
      const id = input.doc_id.trim();
      if (!/^[A-Za-z0-9_\-.]+$/.test(id)) throw new Error("Invalid doc_id");
      const url = "https://jmail.world/thread/" + encodeURIComponent(id) + "?view=inbox";
      await browser.goto(url, {
        tab: target.tabId,
        "wait-until": "domcontentloaded",
        timeout: 15000,
      });
      state.result = { doc_id: id, navigated: true, url };
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
