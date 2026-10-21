export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max reviews to return (default 5, max 10)",
        minimum: 1,
        maximum: 10,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "wait",
    intervalMs: 200,
    timeoutMs: 10000,
    async inspect({ input, state, target, packageRoot }) {
      const source = `async () => {
if (!(location.origin === 'https://movie.douban.com') || document.readyState === 'loading' || !document.body) return {ready: false};

function readReviews(limit) {
    return Array.from(document.querySelectorAll('.review-item'))
        .slice(0, limit)
        .map((r) => {
        const el = r;
        const link = el.querySelector('h2 a[href*="/review/"]');
        const metaEl = el.querySelector('.header-meta, .meta, .byline');
        let meta = cleanText(metaEl?.textContent);
        if (!meta) {
            for (const d of Array.from(el.querySelectorAll('div'))) {
                const t = cleanText(d.textContent);
                if (/\\d{4}-\\d{2}-\\d{2}/.test(t) && t.length < 80) {
                    meta = t;
                    break;
                }
            }
        }
        const excerptRaw = cleanText(el.querySelector('.short-content')?.textContent);
        const spoiler = excerptRaw.includes('剧透');
        const excerpt = excerptRaw
            .replace(/^这篇影评可能有剧透\\s*/, '')
            .replace(/\\(展开\\)?$/, '')
            .slice(0, 300);
        return {
            review_id: el.id || (link?.getAttribute('href')?.match(/review\\/(\\d+)/)?.[1] ?? null),
            title: cleanText(link?.textContent),
            author: meta.split(/\\d{4}-/)[0].trim(),
            date: (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [''])[0],
            spoiler,
            excerpt,
            url: link?.href || null,
        };
    })
        .filter((x) => x.title);
}
const args = __INPUT__;
return {ready: true, result: await (async () => {
if (!/movie\\.douban\\.com/.test(location.host) || !/\\/subject\\/\\d+/.test(location.pathname)) {
    return {
        error: 'Not on a movie/TV detail page. Call open_subject (subject_id) first, then get_reviews.',
    };
}
const limit = Math.max(1, Math.min(10, Number(args?.limit) || 5));
const reviews = readReviews(limit);
return {
    subject: cleanText(document.querySelector('#content h1 span[property="v:itemreviewed"]')?.textContent),
    count: reviews.length,
    reviews,
    hint: 'Use the url field (web_fetch or browser navigation) to read a full review.',
};
})()};
}`.replace("__INPUT__", () => JSON.stringify(input));
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
      if (output.exitCode !== 0) throw new Error(output.stderr);
      const page = JSON.parse(output.stdout);
      if (page.tabId !== target.tabId)
        throw new Error("Browser returned another tab");
      const value = page.result;
      if (!value.ready) return false;
      if (value.result && typeof value.result.error === "string")
        throw new Error(value.result.error);
      state.result = value.result;
      return true;
    },
  },
  result({ state }) {
    return state.result;
  },
};
