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
    },
    additionalProperties: false,
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
      link: {
        type: "object",
        properties: {
          slug: { type: "string" },
          label: { type: "string" },
          selector: { type: ["string", "null"] },
          path: { type: "string" },
        },
        required: ["slug", "label", "selector", "path"],
        additionalProperties: false,
      },
      view: {
        type: "object",
        properties: {
          url: { type: "string" },
          doc_id: { type: ["string", "null"] },
          page_title: { type: "string" },
          text: { type: "string" },
          structured: {
            anyOf: [{ $ref: "#/definitions/structured" }, { type: "null" }],
          },
        },
        required: ["url", "doc_id", "page_title", "text", "structured"],
        additionalProperties: false,
      },
      date_filter: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          open: { type: "boolean" },
          after: { type: ["string", "null"] },
          before: { type: ["string", "null"] },
          can_clear: { type: "boolean" },
        },
        required: ["active", "open", "after", "before", "can_clear"],
        additionalProperties: false,
      },
      pager_link: {
        type: "object",
        properties: {
          href: { type: ["string", "null"] },
          path: { type: "string" },
          interactive: { type: "boolean" },
        },
        required: ["href", "path", "interactive"],
        additionalProperties: false,
      },
      pager: {
        type: "object",
        properties: {
          next: {
            anyOf: [{ $ref: "#/definitions/pager_link" }, { type: "null" }],
          },
          previous: {
            anyOf: [{ $ref: "#/definitions/pager_link" }, { type: "null" }],
          },
        },
        required: ["next", "previous"],
        additionalProperties: false,
      },
    },
    properties: {
      ready: { type: "boolean" },
      kind: { type: "string", enum: ["thread", "list", "view"] },
      url: { type: "string" },
      route: { type: "string" },
      path: { type: "string" },
      params: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      page_title: { type: "string" },
      query: { type: "string" },
      total: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0, maximum: 100 },
      results: {
        type: "array",
        maxItems: 100,
        items: { $ref: "#/definitions/email_row" },
      },
      results_ready: { type: "boolean" },
      view: { $ref: "#/definitions/view" },
      thread: {
        anyOf: [{ $ref: "#/definitions/view" }, { type: "null" }],
      },
      people: {
        type: "array",
        items: { $ref: "#/definitions/link" },
      },
      topics: {
        type: "array",
        items: { $ref: "#/definitions/link" },
      },
      search_ready: { type: "boolean" },
      date_filter: { $ref: "#/definitions/date_filter" },
      pager: { $ref: "#/definitions/pager" },
    },
    required: ["ready"],
    allOf: [
      {
        if: {
          properties: { ready: { const: true } },
          required: ["ready"],
        },
        then: {
          required: [
            "ready",
            "kind",
            "url",
            "route",
            "path",
            "params",
            "page_title",
            "query",
            "total",
            "count",
            "results",
            "results_ready",
            "view",
            "thread",
            "people",
            "topics",
            "search_ready",
            "date_filter",
            "pager",
          ],
        },
      },
      {
        if: {
          properties: { ready: { const: false } },
          required: ["ready"],
        },
        then: { maxProperties: 1 },
      },
      {
        if: {
          properties: {
            ready: { const: true },
            kind: { const: "thread" },
          },
          required: ["ready", "kind"],
        },
        then: {
          properties: { thread: { $ref: "#/definitions/view" } },
        },
      },
      {
        if: {
          properties: {
            ready: { const: true },
            kind: { enum: ["list", "view"] },
          },
          required: ["ready", "kind"],
        },
        then: {
          properties: { thread: { type: "null" } },
        },
      },
    ],
    additionalProperties: false,
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

  if (location.origin !== "https://jmail.world" || location.pathname.startsWith("/messages"))
    return { ready: false };
  const ICON_NOISE = new Set([
    "arrow_back",
    "chevron_left",
    "chevron_right",
    "first_page",
    "last_page",
    "arrow_drop_down",
    "arrow_upward",
    "star_border",
    "star",
    "mystery",
    "link",
    "reply",
    "forward",
    "inbox",
    "send",
    "attach_file",
    "calendar_today",
    "edit",
    "question_answer",
    "handshake",
    "shield",
    "bakery_dining",
    "north_east",
    "folder_open",
    "date_range",
    "menu",
    "search",
    "person",
    "people",
    "close",
    "feedback",
    "help_outline",
    "settings",
    "visibility_off",
    "gavel",
    "mail",
    "markunread",
    "drafts",
    "schedule",
    "label",
    "delete",
    "share",
    "add",
    "open_in_full",
    "restart_alt",
    "view_sidebar",
    "science",
    "tune",
    "subdirectory_arrow_right",
    "verified",
    "local_offer",
    "unfold_more",
  ]);

  function filterIconNoise(text) {
    return text
      .split("\\n")
      .map((line) => line.trim())
      .filter((line) => line && !ICON_NOISE.has(line))
      .join("\\n");
  }

  const DATE_RE = /^[A-Z][a-z]{2} \\d{1,2}, \\d{4}$/;

  function findRowElements() {
    const main = document.querySelector("main");
    if (!main) return [];
    const visible = Array.from(main.querySelectorAll(".email-row[data-doc-id]")).filter(
      (row) => row.getClientRects().length,
    );
    if (visible.length) return visible;
    const rows = [];
    for (const checkbox of main.querySelectorAll('input[type="checkbox"]')) {
      let row = checkbox;
      while (
        row.parentElement !== main &&
        main.contains(row.parentElement) &&
        row.parentElement.querySelectorAll('input[type="checkbox"]').length === 1
      )
        row = row.parentElement;
      if (
        row !== checkbox &&
        !rows.includes(row) &&
        Array.from(row.querySelectorAll("div, span, time")).some((el) =>
          DATE_RE.test((el.innerText || "").trim()),
        )
      )
        rows.push(row);
    }
    return rows;
  }

  function parseRow(row, index) {
    const dateNode = row.querySelector(".email-date");
    const senderNode = row.querySelector(".sender-name");
    const subjectNode = row.querySelector(".subject, .email-subject");
    if (dateNode && (senderNode || subjectNode)) {
      const subjectCopy = subjectNode?.cloneNode(true);
      subjectCopy?.querySelectorAll(".source-badge").forEach((badge) => badge.remove());
      const sender = (senderNode?.innerText || "").replace(/\\s*\\d+$/, "").trim();
      const subject = (subjectCopy?.textContent || "").trim().split("\\n")[0];
      const preview = (row.querySelector(".preview, .email-preview")?.innerText || "")
        .trim()
        .replace(/^-\\s*/, "")
        .slice(0, 300);
      return sender || subject
        ? { index, sender, subject, date: dateNode.innerText.trim(), preview }
        : null;
    }
    let dateDiv = null;
    for (const el of row.querySelectorAll("div")) {
      if (
        DATE_RE.test((el.innerText || "").trim()) &&
        (!dateDiv || el.contains(dateDiv) || dateDiv.contains(el))
      )
        dateDiv = el;
    }
    if (!dateDiv?.parentElement) return null;
    let sender = "",
      subject = "",
      preview = "";
    const date = (dateDiv.innerText || "").trim();
    for (const el of dateDiv.parentElement.children) {
      if (el === dateDiv || el.querySelector('input[type="checkbox"], button')) continue;
      const text = (el.innerText || "").trim();
      if (!text) continue;
      const kids = Array.from(el.children);
      const previewKid = kids.find((child) => (child.innerText || "").trim().startsWith("-"));
      if (previewKid && !subject) {
        const candidates = kids
          .filter((child) => child !== previewKid)
          .map((child) => (child.innerText || "").trim().split("\\n")[0])
          .filter((text) => text && !/^DOJ \\d+$/.test(text) && text !== "(no subject)")
          .sort((a, b) => b.length - a.length);
        subject = candidates[0] || "(no subject)";
        preview = (previewKid.innerText || "").trim().replace(/^-\\s*/, "").slice(0, 300);
      } else if (!sender) sender = text.replace(/\\s*\\d+$/, "").trim();
    }
    return subject || sender ? { index, sender, subject, date, preview } : null;
  }

  function readTotalCount() {
    return (
      document.querySelector("main")?.innerText.match(/\\d+\\s*[-–—]\\s*\\d+\\s+of\\s+(\\d+)/)?.[1] ||
      null
    );
  }

  function readThreadView() {
    const main = document.querySelector("main") || document.body;
    const idMatch = location.pathname.match(/^\\/thread\\/([^?/]+)/);
    return {
      url: location.pathname + location.search,
      doc_id: idMatch ? decodeURIComponent(idMatch[1]) : null,
      page_title: document.title,
      text: filterIconNoise(main.innerText || "").slice(0, 12000),
      structured: readJsonLd(),
    };
  }

  function readJsonLd() {
    try {
      const data = JSON.parse(
        document.querySelector('script[type="application/ld+json"]')?.textContent || "null",
      );
      const article = (Array.isArray(data?.["@graph"]) ? data["@graph"] : [data]).find(
        (item) =>
          item && typeof item === "object" && (item["@type"] === "Article" || item.headline),
      );
      if (!article) return null;
      const fields = {
        headline: article.headline,
        author:
          typeof article.author === "string" ? article.author : article.author?.name,
        datePublished: article.datePublished,
        description: article.description,
      };
      const structured = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => typeof value === "string"),
      );
      return Object.keys(structured).length ? structured : null;
    } catch {
      return null;
    }
  }

  // Stable selectors let callers use native browser input without returning DOM nodes.
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
  function readLinks(selector, prefix) {
    const seen = new Set();
    return Array.from(document.querySelectorAll(selector)).flatMap((anchor) => {
      const slug = (anchor.getAttribute("href") || "").slice(prefix.length).split(/[?#]/)[0];
      if (!slug || seen.has(slug)) return [];
      seen.add(slug);
      return [
        {
          slug,
          label: filterIconNoise(anchor.innerText || "").trim(),
          selector: selectorFor(anchor),
          path: new URL(anchor.href).pathname,
        },
      ];
    });
  }
  const rows = findRowElements();
  const results = rows.slice(0, limit).flatMap((row, index) => {
    const data = parseRow(row, index);
    if (!data) return [];
    const leaves = Array.from(row.querySelectorAll("div")).filter(
      (el) => !el.children.length && (el.innerText || "").trim(),
    );
    const subject = data.subject && leaves.find((el) => el.innerText.trim() === data.subject);
    const longest = leaves.sort(
      (a, b) => b.innerText.trim().length - a.innerText.trim().length,
    )[0];
    return [
      {
        ...data,
        doc_id: row.getAttribute("data-doc-id") || null,
        selector: selectorFor(subject || (data.subject && longest) || row),
        interactive: Object.keys(row).some((key) => key.startsWith("__reactProps$")),
      },
    ];
  });
  const main = document.querySelector("main");
  const total = readTotalCount();
  const empty =
    total === "0" || /no emails found|no results found/i.test(main?.innerText || "");
  const searchInput = document.querySelector('input[name="q"]');
  const query = new URL(location.href).searchParams.get("q") || "";
  const filter = document.querySelector('button[aria-label="Filter by date range"]');
  const dropdown = document.querySelector('.date-filter-dropdown[data-state="open"]');
  const fields = Array.from(dropdown?.querySelectorAll(".date-filter-field") || []);
  const dateField = (label) =>
    selectorFor(
      fields
        .find((field) => (field.innerText || "").toLowerCase().includes(label))
        ?.querySelector('input[type="date"]'),
    );
  const pager = (label) => {
    const anchor = document.querySelector('a[aria-label="' + label + ' thread"]');
    return anchor
      ? {
          href: anchor.getAttribute("href"),
          path: new URL(anchor.href).pathname,
          interactive: Object.keys(anchor).some((key) => key.startsWith("__reactProps$")),
        }
      : null;
  };
  const view = readThreadView();
  const isThreadPath = location.pathname.startsWith("/thread/");
  const isViewPath =
    location.pathname === "/attachments" ||
    location.pathname.startsWith("/attachments/") ||
    location.pathname === "/activity" ||
    location.pathname.startsWith("/activity/");
  return {
    ...base,
    kind: isThreadPath ? "thread" : isViewPath ? "view" : "list",
    view,
    query,
    total,
    results,
    count: results.length,
    results_ready: results.length > 0 || empty,
    thread: isThreadPath ? view : null,
    people: readLinks('nav a[href^="/person/"]', "/person/"),
    topics: readLinks('a[href^="/topic/"]', "/topic/"),
    search_ready:
      !!searchInput && Object.keys(searchInput).some((key) => key.startsWith("__reactProps$")),
    date_filter: {
      active:
        !!filter &&
        (filter.classList.contains("date-filter-active") ||
          /[?&](after|before)=/.test(location.search)),
      open: !!dropdown,
      after: dateField("after"),
      before: dateField("before"),
      can_clear: !!dropdown?.querySelector(".date-filter-clear"),
    },
    pager: { next: pager("Next"), previous: pager("Previous") },
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
