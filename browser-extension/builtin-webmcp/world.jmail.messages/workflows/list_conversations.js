export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max conversations to return (default 15, max 50)",
        minimum: 1,
        maximum: 50,
      },
    },
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
      count: { type: "integer", minimum: 1 },
      conversations: {
        type: "array",
        items: { $ref: "#/definitions/conversation" },
        minItems: 1,
      },
    },
    required: ["count", "conversations"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Restore the conversation list when search has replaced it",
        async run({ target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (page.ready && !page.conversations.length)
            await browser.goto(page.navigation || "https://jmail.world/messages", {
              tab: target.tabId,
              "wait-until": "domcontentloaded",
              timeout: 15000,
            });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the visible conversation list",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            { limit: input.limit || 15 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (!page.conversations.length) return false;
          state.result = {
            count: page.conversations.length,
            conversations: page.conversations,
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
