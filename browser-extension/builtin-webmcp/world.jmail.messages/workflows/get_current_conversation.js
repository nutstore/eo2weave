export default {
  inputSchema: {
    type: "object",
    properties: {},
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
      conversation: {
        type: "object",
        properties: {
          kind: { const: "conversation" },
          url: { type: "string", minLength: 1 },
          person: { type: "string", minLength: 1 },
          slug: { type: "string", minLength: 1 },
          message_count: { type: ["integer", "null"], minimum: 0 },
          visible_messages: {
            type: "array",
            items: { $ref: "#/definitions/message" },
          },
        },
        required: ["kind", "url", "person", "slug", "message_count", "visible_messages"],
        additionalProperties: false,
      },
      notOpen: {
        type: "object",
        properties: {
          kind: { const: "not_open" },
          on_messages_view: { const: false },
          note: { const: "Open a conversation first." },
        },
        required: ["kind", "on_messages_view", "note"],
        additionalProperties: false,
      },
    },
    properties: {
      kind: { enum: ["conversation", "not_open"] },
      url: { type: "string", minLength: 1 },
      person: { type: "string", minLength: 1 },
      slug: { type: "string", minLength: 1 },
      message_count: { type: ["integer", "null"], minimum: 0 },
      visible_messages: {
        type: "array",
        items: { $ref: "#/definitions/message" },
      },
      on_messages_view: { const: false },
      note: { const: "Open a conversation first." },
    },
    required: ["kind"],
    additionalProperties: false,
    oneOf: [
      { $ref: "#/definitions/conversation" },
      { $ref: "#/definitions/notOpen" },
    ],
  },
  tree: {
    type: "wait",
    description: "Read the current conversation",
    intervalMs: 250,
    timeoutMs: 15000,
    async inspect({ input, state, target }) {
      const response = await browser.webmcp.exec(
        "world.jmail.messages.read_page",
        {},
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return false;
      state.result = page.conversation
        ? { ...page.conversation, kind: "conversation" }
        : {
            kind: "not_open",
            on_messages_view: false,
            note: "Open a conversation first.",
          };
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
