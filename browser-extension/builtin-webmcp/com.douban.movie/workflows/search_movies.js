export default {
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search keywords (e.g. 肖申克的救赎 or Nolan)",
        minLength: 1,
        pattern: "\\S",
      },
      limit: {
        type: "number",
        description: "Max results to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
      tags: {
        type: "string",
        description:
          'Optional filter tags appended to the query, e.g. "美国 剧情" or "日本 动画 2020s". Combined with the search box keywords.',
      },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      count: { type: "integer", minimum: 0 },
      results: { type: "array", items: { type: "object" } },
    },
    required: ["query", "count", "results"],
    additionalProperties: true,
  },
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      // Running actions observe again; the submitted flag prevents repeated writes.
      state.deadline ??= Date.now() + 10000;
      if (Date.now() > state.deadline)
        throw new Error("Search timed out waiting for matching results");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      state.nextReadAt = Date.now() + 250;
      const query =
        input.query.trim() +
        (input.tags ? " " + String(input.tags).trim() : "");
      const source = `() => {
const args = __INPUT__;
if (!args.__submitted && location.origin !== 'https://movie.douban.com') return {pageReady:false};
if (document.readyState === 'loading' || !document.body) return {pageReady:false};

function readSearchResults(limit) {
    if (/搜索访问太频繁|搜索访问过于频繁|Too many requests/i.test(document.body?.innerText || '')) throw new Error('Douban search is rate-limited by the site');
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a.title-text[href*="/subject/"]'));
    for (const a of anchors) {
        const title = cleanText(a.textContent).replace(/\\s*\\(\\d{4}\\)\\s*$/, m => m);
        if (!title)
            continue;
        const moreurl = a.getAttribute('data-moreurl') || '';
        const id = moreurl.match(/subject_id:'(\\d+)'/)?.[1]
            || a.getAttribute('href')?.match(/subject\\/(\\d+)/)?.[1]
            || null;
        const item = a.closest('div[class*="item"], .result, [class*="subject"]') || a.parentElement?.parentElement || a;
        const ratingNum = item?.querySelector('.rating_nums')?.textContent?.trim();
        const rating = ratingNum
            ? \`\${ratingNum}（\${cleanText(item?.querySelector('.rating')?.textContent).replace(/^[\\d.]+/, '').replace(/[()（）]/g, '')}）\`
            : '暂无评分';
        const meta = cleanText(item?.querySelector('.subject-cast, .detail, [class*="cat"]')?.textContent);
        out.push({
            index: out.length,
            title,
            rating,
            url: a.href,
            subject_id: id,
            detail: meta,
        });
        if (out.length >= limit)
            break;
    }
    return out;
}

const query = String(args.query || '').trim();
const rows = readSearchResults(Math.max(1, Math.min(25, Number(args.limit) || 10)));
const params = new URL(location.href).searchParams;
const fullQuery = args.tags ? query + ' ' + String(args.tags).trim() : query;
const correctQuery = location.hostname === 'search.douban.com' && params.get('search_text') === fullQuery;
const empty = /没有找到|没找到|No results/i.test(document.body.innerText || '');
const searchInputCount = Array.from(document.querySelectorAll("input[name=\\"search_text\\"]")).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').length;
return {searchInputCount, ready: correctQuery && (rows.length > 0 || empty), result: {query: fullQuery, count: rows.length, results: rows}};
}`.replace("__INPUT__", () =>
        JSON.stringify({ ...input, __submitted: !!state.submitted }),
      );
      const output = await tools.bash({
        command: `reader=$(cat '${packageRoot}readers/dom.js') || exit 1
page_source='${source.replace(/'/g, "'\"'\"'")}'
browser eval --tab=${target.tabId} "async () => {
$reader
return await ($page_source)();
}"`,
        timeout: 15000,
      });
      if (output.truncated) throw new Error("Browser output was truncated");
      if (output.exitCode !== 0) {
        if (
          /execution context was destroyed|cannot find context with specified id|cannot find default execution context/i.test(
            output.stderr,
          )
        )
          return "running";
        throw new Error(output.stderr);
      }
      const page = JSON.parse(output.stdout);
      if (page.tabId !== target.tabId)
        throw new Error("Browser returned another tab");
      const observed = page.result;
      if (observed.pageReady === false) return "running";
      if (observed.ready) {
        state.result = observed.result;
        return "success";
      }
      if (!state.submitted) {
        if (observed.searchInputCount > 1)
          throw new Error("Search input is ambiguous");
        let command;
        if (observed.searchInputCount === 0) {
          const url =
            "https://search.douban.com/movie/subject_search?search_text=" +
            encodeURIComponent(query) +
            "&cat=1002";
          command =
            "browser goto --tab=" +
            target.tabId +
            " --wait-until=domcontentloaded -- " +
            "'" +
            url.replace(/'/g, "'\"'\"'") +
            "'";
        } else {
          const text = "'" + query.replace(/'/g, "'\"'\"'") + "'";
          command =
            "browser fill --tab=" +
            target.tabId +
            " -- " +
            "'input[name=\"search_text\"]'" +
            " " +
            text +
            " && browser press --tab=" +
            target.tabId +
            " -- Enter";
        }
        const action = await tools.bash({ command, timeout: 15000 });
        if (action.exitCode !== 0) throw new Error(action.stderr);
        if (action.truncated) throw new Error("Browser output was truncated");
        state.submitted = true;
        state.deadline = Date.now() + 20000;
      }
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
