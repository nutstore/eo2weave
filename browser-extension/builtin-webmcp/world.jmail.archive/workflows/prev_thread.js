export default {
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "number",
        description: "How many emails to go back (default 1, max 49)",
        minimum: 1,
        maximum: 49,
      },
    },
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
      steps_moved: { type: "integer", minimum: 0, maximum: 49 },
      steps_requested: { type: "integer", minimum: 1, maximum: 49 },
    },
    required: [
      "url",
      "doc_id",
      "page_title",
      "text",
      "structured",
      "steps_moved",
      "steps_requested",
    ],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Advance through threads without repeating a pending click",
    async run({ input, state, target }) {
      state.requested ??= Math.max(1, Math.min(49, Math.floor(input.steps || 1)));
      state.moved ??= 0;
      state.deadline ??= Date.now() + 45000;
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      state.nextReadAt = Date.now() + 250;
      if (Date.now() > state.deadline) throw new Error("Thread pager timed out");
      const response = await browser.webmcp.exec(
        "world.jmail.archive.read_page",
        {},
        { tab: target.tabId, timeout: 15000 },
      );
      if (response.result.status !== "success") throw new Error("Page reader did not succeed");
      const page = response.result.result;
      if (!page.ready || page.kind !== "thread" || !page.thread.text.trim()) return "running";
      if (state.awaiting && page.path !== state.awaiting) return "running";
      state.awaiting = null;
      const next = page.pager.previous;
      if (state.moved >= state.requested || (!next?.href && state.moved)) {
        state.result = {
          ...page.thread,
          steps_moved: state.moved,
          steps_requested: state.requested,
        };
        return "success";
      }
      if (!next?.href) throw new Error("No previous thread control on this page");
      if (!next.interactive) return "running";
      state.awaiting = next.path;
      await browser.click('a[aria-label="Previous thread"]', undefined, {
        tab: target.tabId,
        activate: true,
        timeout: 15000,
      });
      state.moved++;
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
