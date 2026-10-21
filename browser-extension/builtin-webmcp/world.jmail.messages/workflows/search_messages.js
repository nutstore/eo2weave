export default {
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords",
        minLength: 1,
        pattern: "\\S",
      },
      limit: {
        type: "number",
        description: "Max messages to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
    },
    required: ["query"],
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      result: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0 },
          selector: { type: "string", pattern: "^body > " },
          interactive: { type: "boolean" },
          person: { type: "string", minLength: 1 },
          date: { type: "string", pattern: "\\b\\d{2}\\/\\d{2}\\/\\d{2}\\b" },
          snippet: { type: "string", minLength: 1, maxLength: 300 },
          slug: { type: "string" },
        },
        required: ["index", "selector", "interactive", "person", "date", "snippet", "slug"],
        additionalProperties: false,
      },
    },
    properties: {
      query: { type: "string", minLength: 1 },
      total_matches: { type: ["integer", "null"], minimum: 0 },
      count: { type: "integer", minimum: 0, maximum: 25 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/result" },
        maxItems: 25,
      },
    },
    required: ["query", "total_matches", "count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Wait for the message search control",
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
          return page.search_ready;
        },
      },
      {
        type: "action",
        description: "Search all messages",
        async run({ input, state, target }) {
          state.query = input.query.trim();
          await browser.fill('input[placeholder="Search"]', state.query, {
            tab: target.tabId,
            timeout: 15000,
          });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for search results for this query",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.messages.read_page",
            { limit: input.limit || 10, query: state.query },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.search.query !== state.query || !page.search.results_ready) return false;
          state.result = {
            query: state.query,
            total_matches: page.search.total_matches,
            count: page.search.count,
            results: page.search.results,
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
