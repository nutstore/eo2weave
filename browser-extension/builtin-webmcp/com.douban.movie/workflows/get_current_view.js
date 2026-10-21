export default {
  inputSchema: {
    type: "object",
    properties: {},
  },
  outputSchema: true,
  tree: {
    type: "wait",
    intervalMs: 200,
    timeoutMs: 10000,
    async inspect({ input, state, target, packageRoot }) {
      const source = `async () => {
if (!(location.origin === 'https://movie.douban.com') || document.readyState === 'loading' || !document.body) return {ready: false};

function readSubjectView() {
    const isSubject = /\\/subject\\/\\d+/.test(location.pathname);
    const main = document.querySelector('#content') || document.body;
    const base = {
        url: location.pathname + location.search,
        page_title: cleanText(document.title),
    };
    if (!isSubject) {
        return {
            ...base,
            is_subject_page: false,
            text: cleanText(main.innerText).slice(0, 6000),
        };
    }
    const h1 = document.querySelector('#content h1');
    const year = cleanText(h1?.querySelector('.year')?.textContent);
    const titleSpan = h1?.querySelector('span[property="v:itemreviewed"]') ||
        h1?.querySelector('span') || h1;
    const title = cleanText(titleSpan?.textContent).replace(/\\d{4}$/, '').trim();
    const info = {};
    const infoEl = document.querySelector('#info');
    if (infoEl) {
        let lastKey = '';
        for (const line of infoEl.innerText.split('\\n')) {
            const idx = line.indexOf(':');
            if (idx > 0 && idx < 12) {
                lastKey = line.slice(0, idx).trim();
                info[lastKey] = line.slice(idx + 1).trim();
            }
            else if (lastKey) {
                info[lastKey] += ' ' + line.trim();
            }
        }
        for (const k of Object.keys(info))
            info[k] = info[k].trim();
    }
    const ratingNum = cleanText(document.querySelector('strong.rating_num')?.textContent);
    const ratingPeople = cleanText(document.querySelector('a.rating_people span[property="v:votes"]')?.textContent ||
        document.querySelector('a.rating_people')?.textContent);
    const stars = Array.from(document.querySelectorAll('.rating_ind')).map((el, i) => {
        const per = el.parentElement?.querySelector('.rating_per');
        return { stars: \`\${5 - i}星\`, percent: cleanText(per?.textContent) };
    }).filter((s) => s.percent);
    const summary = cleanText(Array.from(document.querySelectorAll('span[property="v:summary"], .related-info .intro'))
        .map((el) => el.textContent || '')
        .join('\\n'));
    const comments = Array.from(document.querySelectorAll('#hot-comments .comment-item, #comments .comment-item'))
        .slice(0, 10)
        .map((c) => {
        const meta = cleanText(c.querySelector('.comment-info')?.textContent);
        const ratingEl = c.querySelector('.comment-info .rating');
        const starsTitle = ratingEl?.title || ratingEl?.className?.match(/allstar(\\d+)/)?.[1] || '';
        const votes = cleanText(c.querySelector('.vote-count')?.textContent);
        return {
            author: meta.replace(/\\s*\\d{4}-\\d{2}-\\d{2}.*$/, '').trim(),
            date: (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [''])[0],
            stars: String(starsTitle).replace('力荐', '5星').replace('推荐', '4星')
                .replace('还行', '3星').replace('较差', '2星').replace('很差', '1星'),
            votes: votes.replace(/(\\d+)\\s*有用/, '$1'),
            text: cleanText(c.querySelector('.short')?.textContent),
        };
    })
        .filter((c) => c.text);
    return {
        ...base,
        is_subject_page: true,
        title,
        year: year.replace(/[()]/g, ''),
        rating: ratingNum || '暂无评分',
        rating_people: ratingPeople,
        star_distribution: stars,
        info,
        summary: summary.slice(0, 3000),
        hot_comments: comments,
    };
}
const args = __INPUT__;
return {ready: true, result: await (async () => {
return readSubjectView();
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
