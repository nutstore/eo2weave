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
      cleared: { type: "boolean" },
      url: { type: "string" },
      total: { type: ["string", "null"] },
      latest: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["cleared", "url", "total", "latest"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Inspect the date filter",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          state.active = page.date_filter.active;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the active date filter",
        async run({ input, state, target }) {
          if (state.active)
            await browser.click('button[aria-label="Filter by date range"]', undefined, {
              tab: target.tabId,
              activate: true,
              timeout: 15000,
            });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the clear control",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          return !state.active || page.date_filter.can_clear;
        },
      },
      {
        type: "action",
        description: "Clear the date filter once",
        async run({ input, state, target }) {
          if (state.active)
            await browser.click(".date-filter-clear", undefined, {
              tab: target.tabId,
              activate: true,
              timeout: 15000,
            });
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the unfiltered results",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            { limit: 5 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (state.active && (page.date_filter.active || !page.results_ready)) return false;
          state.result = {
            cleared: state.active,
            url: page.route,
            total: page.total,
            latest: page.results,
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
