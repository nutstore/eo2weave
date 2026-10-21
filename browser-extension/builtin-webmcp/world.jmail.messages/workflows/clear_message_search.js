export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      cleared: { type: "boolean" },
      note: { const: "Conversation list restored." },
    },
    required: ["cleared", "note"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Inspect the message search",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (!page.search_ready) return false;
          state.active = !!page.search.query;
          return true;
        },
      },
      {
        type: "action",
        description: "Clear the active search",
        async run({ input, state, target }) {
          if (state.active)
            await browser.fill('input[placeholder="Search"]', "", {
              tab: target.tabId,
              timeout: 15000,
            });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the conversation list to return",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.search.query || !page.conversations.length) return false;
          state.result = { cleared: state.active, note: "Conversation list restored." };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
