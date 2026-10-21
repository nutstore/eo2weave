export default {
  inputSchema: {
    type: "object",
    properties: {
      episode_limit: {
        type: "number",
        description: "Max episodes to return (default 30)",
        minimum: 1,
        maximum: 100,
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

function readTvInfo(episodeLimit) {
    if (!/\\/subject\\/\\d+/.test(location.pathname)) {
        return { error: 'Not on a movie/TV detail page. Call open_subject (subject_id) first, then get_tv_info.' };
    }
    const currentId = location.pathname.match(/subject\\/(\\d+)/)?.[1];
    const currentTitle = cleanText(document.querySelector('#content h1 span[property="v:itemreviewed"]')?.textContent);
    const seen = new Set();
    const seasonList = Array.from(document.querySelectorAll('#season a[href*="/subject/"], .seasons a[href*="/subject/"], #content a[href*="/subject/"] img[src*="poster"], .subject-item a[href*="/subject/"]'))
        .map((el) => (el instanceof HTMLImageElement ? el.closest('a') : el))
        .filter((a) => !!a?.getAttribute('href')?.match(/subject\\/(\\d+)/))
        .map((a) => {
        const m = a.getAttribute('href')?.match(/subject\\/(\\d+)/);
        return {
            season: cleanText(a.getAttribute('title') || a.querySelector('img')?.getAttribute('alt') || a.textContent).replace(/\\s*\\(\\d{4}\\)\\s*$/, ''),
            subject_id: m?.[1] || '',
        };
    })
        .filter((s) => s.season && s.subject_id && s.subject_id !== currentId && !seen.has(s.subject_id) && seen.add(s.subject_id));
    const seriesLink = document.querySelector('a[href*="/series/"]');
    const series = seriesLink
        ? { key: seriesLink.getAttribute('href')?.match(/series\\/([A-Z0-9]+)/)?.[1] || null, url: seriesLink.href }
        : null;
    const episodes = Array.from(document.querySelectorAll('#eps-table tr')).slice(0, episodeLimit).map((tr) => {
        const el = tr;
        const link = el.querySelector('a');
        return {
            episode: cleanText(el.querySelector('.episode')?.textContent),
            title: cleanText(link?.textContent),
            rating: cleanText(el.querySelector('.rating_nums')?.textContent),
            url: link?.href || null,
        };
    }).filter((e) => e.title || e.episode);
    return {
        subject: currentTitle,
        episode_count: cleanText(document.querySelector('span[property="v:total-episodes"]')?.textContent) ||
            (document.querySelector('#info')?.innerText.match(/集数:\\s*(\\d+)/)?.[1]) ||
            (document.body.innerHTML.match(/<span[^>]*property="v:total-episodes"[^>]*>(\\d+)</)?.[1] ?? null),
        series,
        seasons: seasonList.length ? seasonList : undefined,
        episodes: episodes.length ? episodes : undefined,
        note: episodes.length === 0 && seasonList.length === 0 && !series
            ? 'No seasons/episodes found — this may be a movie, or episode data is login-gated.'
            : episodes.length === 0
                ? 'Episode-level data requires login; use the seasons/series fields to navigate between entries.'
                : undefined,
    };
}
const args = __INPUT__;
return {ready: true, result: await (async () => {
const episodeLimit = Math.max(1, Math.min(100, Number(args?.episode_limit) || 30));
if (!/\\/subject\\/\\d+/.test(location.pathname)) {
    return { error: 'Not on a movie/TV detail page. Call open_subject (subject_id) first, then get_tv_info.' };
}
return readTvInfo(episodeLimit);
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
