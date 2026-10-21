export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from search_messages results",
        minimum: 0,
      },
    },
    required: ["index"],
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
        minItems: 1,
      },
      matched_message_date: {
        type: "string",
        pattern: "\\b\\d{2}\\/\\d{2}\\/\\d{2}\\b",
      },
      matched_snippet: { type: "string", minLength: 1, maxLength: 300 },
    },
    required: [
      "url",
      "person",
      "slug",
      "message_count",
      "visible_messages",
      "matched_message_date",
      "matched_snippet",
    ],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Select a message search hit",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            { limit: 25 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          const index = Number(input.index);
          if (!Number.isInteger(index) || index < 0)
            throw new Error("index must be a non-negative integer");
          if (!page.search.results_ready) return false;
          const hit = page.search.results[index];
          if (!hit) throw new Error("No search result at index " + index);
          if (!hit.interactive) return false;
          state.hit = hit;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the matching message search row",
        async run({ input, state, target }) {
          await browser.click(state.hit.selector, undefined, {
            tab: target.tabId,
            activate: true,
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the opened conversation",
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
            !page.conversation ||
            (state.hit.slug && page.conversation.slug !== state.hit.slug) ||
            !page.conversation.visible_messages.length
          )
            return false;
          state.result = {
            ...page.conversation,
            matched_message_date: state.hit.date,
            matched_snippet: state.hit.snippet,
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
