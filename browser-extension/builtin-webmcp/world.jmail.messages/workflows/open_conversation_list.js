export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      conversation: {
        type: "object",
        properties: {
          slug: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          last_message: { type: "string", maxLength: 200 },
          selector: { type: "string", pattern: "^body > " },
          interactive: { type: "boolean" },
          date: { type: "string", pattern: "\\b\\d{2}\\/\\d{2}\\/\\d{2}\\b" },
        },
        required: ["slug", "name", "last_message", "selector", "interactive", "date"],
        additionalProperties: false,
      },
    },
    properties: {
      navigated: { const: true },
      url: { const: "/messages" },
      page_title: { type: "string" },
      latest: {
        type: "array",
        items: { $ref: "#/definitions/conversation" },
        minItems: 1,
        maxItems: 5,
      },
    },
    required: ["navigated", "url", "page_title", "latest"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Open the conversation list",
        async run({ input, state, target }) {
          await browser.goto("https://jmail.world/messages", {
            tab: target.tabId,
            "wait-until": "domcontentloaded",
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the conversation list",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            { limit: 5 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.path !== "/messages" || !page.conversations.length) return false;
          state.result = {
            navigated: true,
            url: page.path,
            page_title: page.page_title,
            latest: page.conversations,
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
