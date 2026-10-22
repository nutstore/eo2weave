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
          state.listUrl = page.url;
          state.params = page.params;
          return true;
        },
      },
      {
        type: "action",
        description: "Remove the active range from the list URL",
        async run({ input, state, target }) {
          if (state.active) {
            const params = { ...state.params };
            delete params.after;
            delete params.before;
            const query = Object.entries(params)
              .map(
                ([key, value]) =>
                  encodeURIComponent(key) + "=" + encodeURIComponent(String(value)),
              )
              .join("&");
            const url = state.listUrl.split(/[?#]/)[0] + (query ? "?" + query : "");
            await browser.goto(url, {
              tab: target.tabId,
              "wait-until": "domcontentloaded",
              timeout: 15000,
            });
          }
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
