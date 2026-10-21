export default {
  inputSchema: {
    type: "object",
    properties: {
      person: {
        type: "string",
        description: "Person slug from list_conversations (e.g. steve-bannon)",
      },
    },
    required: ["person"],
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      message: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 4000 },
          time: { type: ["string", "null"] },
        },
        required: ["text", "time"],
        additionalProperties: false,
      },
    },
    properties: {
      url: { type: "string", minLength: 1 },
      person: { type: "string", minLength: 1 },
      slug: { type: "string", minLength: 1 },
      message_count: { type: ["integer", "null"], minimum: 0 },
      visible_messages: {
        type: "array",
        items: { $ref: "#/definitions/message" },
      },
      note: {
        const: "Newest messages render first; use load_older_messages for earlier history.",
      },
    },
    required: ["url", "person", "slug", "message_count", "visible_messages", "note"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Find the requested conversation",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            { limit: 100 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (!page.conversations.length) return false;
          const slug = input.person.trim();
          const row = page.conversations.find((row) => row.slug === slug);
          if (!row)
            throw new Error("No conversation for " + slug + "; call list_conversations first");
          if (!row.interactive) return false;
          state.selector = row.selector;
          state.slug = slug;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the conversation",
        async run({ input, state, target }) {
          const selector = state.selector;
          await browser.click(selector, undefined, { tab: target.tabId, activate: true, timeout: 15000 });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for this conversation and its messages",
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
          if (
            page.conversation?.slug !== state.slug ||
            (!page.conversation.visible_messages.length &&
              page.conversation.message_count !== 0)
          )
            return false;
          state.result = {
            ...page.conversation,
            note: "Newest messages render first; use load_older_messages for earlier history.",
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
