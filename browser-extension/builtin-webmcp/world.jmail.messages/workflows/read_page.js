export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 10,
        description: "Maximum rows per collection",
      },
      query: {
        type: "string",
        description: "When supplied, only read search results for this exact query",
      },
      search_started_at: {
        type: "number",
        minimum: 0,
        description: "Page performance.now() recorded before submitting this search",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      conversation: {
        type: "object",
        properties: {
          slug: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          last_message: { type: "string", maxLength: 200 },
          selector: { type: "string", pattern: "^body > " },
          interactive: { type: "boolean" },
          date: { type: "string", pattern: "\\b\\d{2}\\/\\d{2}\\/\\d{2}\\b" },
        },
        required: ["slug", "name", "last_message", "selector", "interactive", "date"],
        additionalProperties: false,
      },
      searchResult: {
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
      message: {
        type: "object",
        properties: {
          text: { type: "string", minLength: 1, maxLength: 4000 },
          time: { type: ["string", "null"] },
        },
        required: ["text", "time"],
        additionalProperties: false,
      },
      activeConversation: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1 },
          person: { type: "string", minLength: 1 },
          slug: { type: "string", minLength: 1 },
          message_count: { type: ["integer", "null"], minimum: 0 },
          visible_messages: {
            type: "array",
            items: { $ref: "#/definitions/message" },
          },
        },
        required: ["url", "person", "slug", "message_count", "visible_messages"],
        additionalProperties: false,
      },
      search: {
        type: "object",
        properties: {
          query: { type: "string" },
          total_matches: { type: ["integer", "null"], minimum: 0 },
          count: { type: "integer", minimum: 0, maximum: 25 },
          results: {
            type: "array",
            items: { $ref: "#/definitions/searchResult" },
            maxItems: 25,
          },
          response_finished_at: { type: ["number", "null"], minimum: 0 },
          results_ready: { type: "boolean" },
        },
        required: ["query", "total_matches", "count", "results", "response_finished_at", "results_ready"],
        additionalProperties: false,
      },
    },
    properties: {
      ready: { type: "boolean" },
      kind: { enum: ["list", "conversation"] },
      url: { type: "string", minLength: 1 },
      route: { type: "string", pattern: "^/messages" },
      path: { type: "string", pattern: "^/messages" },
      params: { type: "object", additionalProperties: { type: "string" } },
      page_title: { type: "string" },
      conversations: {
        type: "array",
        items: { $ref: "#/definitions/conversation" },
        maxItems: 100,
      },
      navigation: { type: ["string", "null"] },
      search_ready: { type: "boolean" },
      search: { $ref: "#/definitions/search" },
      conversation: {
        oneOf: [
          { type: "null" },
          { $ref: "#/definitions/activeConversation" },
        ],
      },
    },
    required: ["ready"],
    additionalProperties: false,
    oneOf: [
      {
        properties: {
          ready: { const: false },
        },
        required: ["ready"],
        maxProperties: 1,
        additionalProperties: false,
      },
      {
        properties: {
          ready: { const: true },
          kind: { const: "list" },
          conversation: { type: "null" },
        },
        required: [
          "ready",
          "kind",
          "url",
          "route",
          "path",
          "params",
          "page_title",
          "conversations",
          "navigation",
          "search_ready",
          "search",
          "conversation",
        ],
      },
      {
        properties: {
          ready: { const: true },
          kind: { const: "conversation" },
          conversation: { $ref: "#/definitions/activeConversation" },
        },
        required: [
          "ready",
          "kind",
          "url",
          "route",
          "path",
          "params",
          "page_title",
          "conversations",
          "navigation",
          "search_ready",
          "search",
          "conversation",
        ],
      },
    ],
  },
  tree: {
    type: "action",
    description: "Read a single page snapshot without interacting with the site",
    async run({ input, state, target }) {
      const source = `() => {
  const args = ${JSON.stringify(input)};

  if (document.readyState === "loading" || !document.body) return { ready: false };
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
  const base = {
    ready: true,
    url: location.href,
    route: location.pathname + location.search,
    params: Object.fromEntries(new URL(location.href).searchParams),
    path: location.pathname,
    page_title: document.title,
  };

  if (location.origin !== "https://jmail.world" || !location.pathname.startsWith("/messages"))
    return { ready: false };
  const ROW_DATE_RE = /\\b\\d{2}\\/\\d{2}\\/\\d{2}\\b/;

  function selectorFor(element) {
    if (!element) return null;
    const parts = [];
    while (element && element !== document.body) {
      if (!element.parentElement) return null;
      const index = Array.from(element.parentElement.children).indexOf(element) + 1;
      parts.unshift(element.tagName.toLowerCase() + ":nth-child(" + index + ")");
      element = element.parentElement;
    }
    return "body > " + parts.join(" > ");
  }

  function findConversationRows() {
    const anchors = Array.from(document.querySelectorAll('a[href^="/messages/"]'));
    return anchors.filter((a) => {
      if (!a.offsetParent) return false;
      return ROW_DATE_RE.test(a.innerText || "");
    });
  }

  function findSearchInput() {
    return document.querySelector('input[placeholder="Search"]');
  }

  function readConversationMeta() {
    const match = (document.querySelector('meta[name="description"]')?.content || "").match(
      /^iMessage conversation with (.+?)\\. (\\d+) messages\\.?$/,
    );
    return match ? { name: match[1], messageCount: Number(match[2]) } : null;
  }

  const TIME_LABEL_RE =
    /^(\\d{1,2}:\\d{2}\\s?(?:AM|PM)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*, [A-Z][a-z]{2} \\d{1,2}, \\d{4}(?: at [\\d:]+\\s?(?:AM|PM))?)$/;

  function readVisibleBubbles() {
    const pane = document.querySelector(".messages-container");
    if (pane) {
      const bounds = pane.getBoundingClientRect();
      return Array.from(pane.querySelectorAll('[id^="message-"]')).flatMap((row) => {
        const rect = row.getBoundingClientRect();
        if (rect.bottom <= bounds.top || rect.top >= bounds.bottom || !rect.height) return [];
        const text = row.querySelector(".break-words")?.innerText?.trim();
        if (!text) return [];
        const time =
          Array.from(row.querySelectorAll("div"))
            .map((el) => el.innerText.trim())
            .find((value) => TIME_LABEL_RE.test(value)) || null;
        return [{ text: text.slice(0, 4000), time }];
      });
    }
    return [];
  }

  function currentSlug() {
    const match = location.pathname.match(/^\\/messages\\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : null;
  }

  function parseConversationRow(a) {
    const slug = (a.getAttribute("href") || "").replace(/^\\/messages\\//, "").split(/[?#]/)[0];
    if (!slug) return null;
    const lines = (a.innerText || "")
      .split("\\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const dateLine = lines.find((l) => ROW_DATE_RE.test(l));
    if (!dateLine) return null;
    let name = lines[0];
    const nonDate = lines.filter((l) => l !== dateLine);
    const preview = nonDate.length > 1 ? nonDate[nonDate.length - 1] : "";
    return {
      slug,
      name,
      last_message: preview.slice(0, 200),
      selector: selectorFor(a),
      interactive: Object.keys(a).some((key) => key.startsWith("__reactProps$")),
      date: (dateLine.match(ROW_DATE_RE) || [""])[0],
    };
  }

  function readConversationRows(limit) {
    const seen = new Set();
    const out = [];
    for (const a of findConversationRows()) {
      const info = parseConversationRow(a);
      if (!info || seen.has(info.slug)) continue;
      seen.add(info.slug);
      out.push(info);
      if (out.length >= limit) break;
    }
    return out;
  }

  let searchBodiesMatchQuery = true;

  function readSearchResultRows(limit) {
    const main = document.querySelector("main") || document.body;
    const rows = [];
    const seen = new Set();
    for (const btn of Array.from(main.querySelectorAll("button"))) {
      if (!btn.offsetParent) continue;
      const text = (btn.innerText || "").trim();
      if (!text || !ROW_DATE_RE.test(text)) continue;
      const lines = text
        .split("\\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const dateLine = lines.find((l) => ROW_DATE_RE.test(l));
      if (!dateLine) continue;
      const idxDate = lines.indexOf(dateLine);
      const person = lines.slice(0, idxDate).join(" ").trim();
      const snippet = lines
        .slice(idxDate + 1)
        .join(" ")
        .trim();
      if (!person || !snippet) continue;
      const key = \`\${person}|\${dateLine}|\${snippet.slice(0, 80)}\`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Validate the full body of every visible hit, including rows beyond the output limit.
      if (args.query && !snippet.toLowerCase().includes(args.query.toLowerCase()))
        searchBodiesMatchQuery = false;
      if (rows.length >= limit) continue;
      rows.push({
        index: rows.length,
        selector: selectorFor(btn),
        interactive: Object.keys(btn).some((key) => key.startsWith("__reactProps$")),
        person,
        date: (dateLine.match(ROW_DATE_RE) || [""])[0],
        snippet: snippet.slice(0, 300),
        slug: slugFromRowImage(btn) || "",
      });
    }
    return rows;
  }

  function slugFromRowImage(row) {
    const img = row.querySelector('img[src*="people-thumbnails"]');
    if (!img) return null;
    const src = img.getAttribute("src") || "";
    const qm = src.match(/people-thumbnails(?:%2F|\\/)([^&]+?)(?:\\.\\w{2,5})?(?:$|&)/i);
    if (qm) {
      try {
        return decodeURIComponent(qm[1]);
      } catch {
        return qm[1];
      }
    }
    return null;
  }

  const control = findSearchInput();
  const query = control?.value || "";
  const main = document.querySelector("main") || document.body;
  const total = (main.innerText || "").match(/MESSAGES\\s*(\\d+)/i)?.[1];
  const noResults = /no results found|no results|没有找到|没有结果/i.test(main.innerText || "");
  // The input updates 300 ms before the site submits its debounced search.
  // Resource timing binds an empty result to a completed request for this invocation.
  let responseFinishedAt = null;
  const since = args.search_started_at ?? 0;
  const resources = typeof performance !== "undefined"
    ? performance.getEntriesByType("resource") : [];
  for (const entry of resources) {
    if (entry.initiatorType !== "fetch" || entry.startTime < since ||
        !entry.responseEnd || entry.responseStatus >= 400) continue;
    const url = new URL(entry.name, location.href);
    if (url.origin !== location.origin || url.pathname !== "/api/imessage/search" ||
        url.searchParams.get("q") !== query) continue;
    responseFinishedAt = Math.max(responseFinishedAt || 0, entry.responseEnd);
  }
  const searchResults =
    args.query !== undefined && args.query !== query
      ? []
      : readSearchResultRows(Math.min(25, limit));
  const conversations = readConversationRows(limit);
  const slug = currentSlug();
  const meta = readConversationMeta();
  const bubbles = readVisibleBubbles();
  const navigation = document.querySelector('.jmail-dock a[href="/messages"]');
  return {
    ...base,
    kind: slug ? "conversation" : "list",
    conversations,
    navigation: navigation?.href || null,
    search_ready:
      !!control && Object.keys(control).some((key) => key.startsWith("__reactProps$")),
    search: {
      query,
      total_matches: total === undefined ? null : Number(total),
      count: searchResults.length,
      results: searchResults,
      response_finished_at: responseFinishedAt,
      results_ready:
        (args.query === undefined || args.query === query) &&
        (searchResults.length > 0
          ? searchBodiesMatchQuery
          : !!query && responseFinishedAt !== null && (total === "0" || noResults)),
    },
    conversation: slug
      ? {
          url: location.pathname,
          person: meta?.name || slug,
          slug,
          message_count: meta?.messageCount ?? null,
          visible_messages: bubbles,
        }
      : null,
  };
}`;
      const page = await browser.eval(source, { tab: target.tabId, timeout: 15000 });
      if (page.tabId !== target.tabId) throw new Error("Browser returned another tab");
      state.result = page.result;
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
