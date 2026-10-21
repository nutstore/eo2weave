export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    type: "object",
    definitions: {
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
    },
    properties: {
      navigated: { const: true },
      url: { type: "string" },
      latest: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["navigated", "url", "latest"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Navigate to the requested application",
        async run({ input, state, target }) {
          await browser.goto("https://jmail.world/", {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          state.result = { navigated: true, url: "https://jmail.world/" };
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the inbox",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            { limit: 5 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready || page.path !== "/" || !page.results_ready) return false;
          state.result = { ...state.result, latest: page.results };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
