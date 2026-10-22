export default {
  inputSchema: {
    type: "object",
    properties: {
      times: {
        type: "number",
        description: "How many scroll loads to perform (default 3, max 10)",
        minimum: 1,
        maximum: 10,
      },
    },
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
      person: { type: "string", minLength: 1 },
      slug: { type: "string", minLength: 1 },
      loads_performed: { type: "integer", minimum: 1, maximum: 10 },
      messages_before: { type: "integer", minimum: 0 },
      messages_after: { type: "integer", minimum: 0 },
      newly_visible: {
        type: "array",
        items: { $ref: "#/definitions/message" },
      },
      visible_messages: {
        type: "array",
        items: { $ref: "#/definitions/message" },
      },
    },
    required: [
      "person",
      "slug",
      "loads_performed",
      "messages_before",
      "messages_after",
      "newly_visible",
      "visible_messages",
    ],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Load older history and read it through the shared page tool",
    async run({ input, state, target }) {
      state.requested ??= Math.max(1, Math.min(10, Math.floor(input.times || 3)));
      state.loads ??= 0;
      state.deadline ??= Date.now() + 20000;
      if (Date.now() > state.deadline) throw new Error("Older message loading timed out");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      const response = await browser.webmcp.exec(
        "world.jmail.messages.read_page",
        {},
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready) return "running";
      if (!page.conversation) throw new Error("Open a conversation first");
      state.slug ??= page.conversation.slug;
      if (page.conversation.slug !== state.slug)
        throw new Error("The conversation changed while loading history");
      const bubbles = page.conversation.visible_messages;
      if (!bubbles.length && page.conversation.message_count !== 0) return "running";
      state.before ??= bubbles;
      if (state.loads >= state.requested) {
        state.result = {
          person: page.conversation.person,
          slug: page.conversation.slug,
          loads_performed: state.loads,
          messages_before: state.before.length,
          messages_after: bubbles.length,
          newly_visible: bubbles.filter(
            (message) =>
              !state.before.some(
                (before) => before.text === message.text && before.time === message.time,
              ),
          ),
          visible_messages: bubbles,
        };
        return "success";
      }
      await browser.eval(
        '() => {const pane=document.querySelector(".messages-container"); if(!pane) throw new Error("No transcript pane"); const reverse=getComputedStyle(pane).flexDirection === "column-reverse"; pane.scrollTo({top:reverse ? -(pane.scrollHeight-pane.clientHeight) : 0,behavior:"auto"}); pane.dispatchEvent(new Event("scroll",{bubbles:true}));}',
        { tab: target.tabId, timeout: 15000 },
      );
      state.loads++;
      state.nextReadAt = Date.now() + 600;
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
