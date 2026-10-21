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
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
      ready: { type: "boolean" },
      kind: { const: "search" },
      url: { type: "string" },
      route: { type: "string" },
      path: { type: "string" },
      params: { type: "object", additionalProperties: { type: "string" } },
      page_title: { type: "string" },
      query: { type: "string" },
      results_ready: { type: "boolean" },
      count: { type: "integer", minimum: 0 },
      results: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          properties: {
            index: { type: "integer", minimum: 0, maximum: 24 },
            title: { type: "string", minLength: 1 },
            rating: { type: "string", minLength: 1 },
            url: { type: "string", minLength: 1 },
            subject_id: {
              type: ["string", "null"],
              pattern: "^\\d+$",
            },
            detail: { type: "string" },
          },
          required: ["index", "title", "rating", "url", "subject_id", "detail"],
          additionalProperties: false,
        },
      },
    },
    required: ["ready"],
    allOf: [
      {
        if: { properties: { ready: { const: true } }, required: ["ready"] },
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
            "results_ready",
            "count",
            "results",
          ],
        },
      },
      {
        if: { properties: { ready: { const: false } }, required: ["ready"] },
        then: { maxProperties: 1 },
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
  if (location.origin !== "https://search.douban.com") return { ready: false };
  function cleanText(s) {
    return (s || "").replace(/\\s+/g, " ").trim();
  }

  function readSearchResults(limit) {
    if (
      /搜索访问太频繁|搜索访问过于频繁|Too many requests/i.test(document.body?.innerText || "")
    )
      throw new Error("Douban search is rate-limited by the site");
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a.title-text[href*="/subject/"]'));
    for (const a of anchors) {
      const title = cleanText(a.textContent).replace(/\\s*\\(\\d{4}\\)\\s*$/, (m) => m);
      if (!title) continue;
      const moreurl = a.getAttribute("data-moreurl") || "";
      const id =
        moreurl.match(/subject_id:'(\\d+)'/)?.[1] ||
        a.getAttribute("href")?.match(/subject\\/(\\d+)/)?.[1] ||
        null;
      const item =
        a.closest('div[class*="item"], .result, [class*="subject"]') ||
        a.parentElement?.parentElement ||
        a;
      const ratingNum = item?.querySelector(".rating_nums")?.textContent?.trim();
      const rating = ratingNum
        ? \`\${ratingNum}（\${cleanText(item?.querySelector(".rating")?.textContent)
            .replace(/^[\\d.]+/, "")
            .replace(/[()（）]/g, "")}）\`
        : "暂无评分";
      const meta = cleanText(
        item?.querySelector('.subject-cast, .detail, [class*="cat"]')?.textContent,
      );
      out.push({
        index: out.length,
        title,
        rating,
        url: a.href,
        subject_id: id,
        detail: meta,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  const query = new URL(location.href).searchParams.get("search_text") || "";
  if (args.query !== undefined && query !== args.query)
    return {
      ...base,
      kind: "search",
      query,
      count: 0,
      results: [],
      results_ready: false,
    };
  const results = readSearchResults(Math.min(25, limit));
  const empty = /没有找到|没找到|No results/i.test(document.body.innerText || "");
  return {
    ...base,
    kind: "search",
    query,
    count: results.length,
    results,
    results_ready: results.length > 0 || empty,
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
