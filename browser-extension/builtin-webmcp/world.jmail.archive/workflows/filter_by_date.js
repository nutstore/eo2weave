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
        type: "action",
        description: "Clear an existing range through the public tool",
        async run({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "world.jmail.archive.clear_date_filter",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Could not clear the previous date filter");
          return "success";
        },
      },
      {
        type: "action",
        description: "Open the date range controls",
        async run({ input, state, target }) {
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
        description: "Locate the date fields",
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
          if (
            !page.date_filter.open ||
            (state.after && !page.date_filter.after) ||
            (state.before && !page.date_filter.before)
          )
            return false;
          state.fields = page.date_filter;
          return true;
        },
      },
      {
        type: "action",
        description: "Fill and apply the requested range",
        async run({ input, state, target }) {
          // Native text insertion does not reliably edit Chromium date controls.
          for (const [field, value] of [
            [state.fields.after, state.after],
            [state.fields.before, state.before],
          ]) {
            if (!value) continue;
            const source =
              '(element) => { const value=__VALUE__; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set; setter.call(element,value); element.dispatchEvent(new Event("input",{bubbles:true})); element.dispatchEvent(new Event("change",{bubbles:true})); }'.replace(
                "__VALUE__",
                () => JSON.stringify(value),
              );
            await browser.evalElement(source, field, { tab: target.tabId, timeout: 15000 });
          }
          await browser.click(".date-filter-apply", undefined, {
            tab: target.tabId,
            activate: true,
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
