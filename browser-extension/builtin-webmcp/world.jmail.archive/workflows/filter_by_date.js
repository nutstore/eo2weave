export default {
  inputSchema: {
    type: "object",
    properties: {
      after: {
        type: "string",
        description: "Only emails on/after this date (YYYY-MM-DD)",
      },
      before: {
        type: "string",
        description: "Only emails on/before this date (YYYY-MM-DD)",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
    },
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
      url: { type: "string" },
      page_title: { type: "string" },
      total: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        items: { $ref: "#/definitions/email_row" },
      },
    },
    required: ["url", "page_title", "total", "count", "results"],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        description: "Validate the requested date range",
        async run({ input, state, target }) {
          state.after = (input.after || "").trim();
          state.before = (input.before || "").trim();
          if (!state.after && !state.before)
            throw new Error("Provide after or before (YYYY-MM-DD)");
          for (const date of [state.after, state.before])
            if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date))
              throw new Error("Dates must use YYYY-MM-DD");
          if (state.after && state.before && state.after > state.before)
            throw new Error("after must not be later than before");
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the current list URL",
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
          if (page.kind !== "list")
            throw new Error("Open an email list before filtering by date");
          state.listUrl = page.url;
          state.params = page.params;
          return true;
        },
      },
      {
        type: "action",
        description: "Apply the requested range through the list URL",
        async run({ input, state, target }) {
          const params = { ...state.params };
          for (const key of ["after", "before"]) {
            if (state[key]) params[key] = state[key];
            else delete params[key];
          }
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
          return "success";
        },
      },
      {
        type: "wait",
        description: "Wait for the requested range and matching rows",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.read_page",
            { limit: input.limit || 10 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          const params = page.params;
          if (
            (state.after && params.after !== state.after) ||
            (state.before && params.before !== state.before) ||
            !page.results_ready
          )
            return false;
          const withinRange = page.results.every((row) => {
            const date = new Date(row.date);
            if (!Number.isFinite(date.getTime())) return false;
            const iso = [
              date.getFullYear(),
              String(date.getMonth() + 1).padStart(2, "0"),
              String(date.getDate()).padStart(2, "0"),
            ].join("-");
            return (
              (!state.after || iso >= state.after) && (!state.before || iso <= state.before)
            );
          });
          if (!withinRange) return false;
          state.result = {
            url: page.route,
            page_title: page.page_title,
            total: page.total,
            count: page.results.length,
            results: page.results,
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
