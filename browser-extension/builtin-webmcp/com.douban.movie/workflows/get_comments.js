export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max comments to return (default 10, max 20)",
        minimum: 1,
        maximum: 20,
      },
      start: {
        type: "number",
        description:
          "0-based comment offset for paging through /comments (multiple of 20). Navigates to the comments page when set.",
        minimum: 0,
      },
      sort: {
        type: "string",
        enum: ["hot", "latest"],
        description: "hot = 最热门 (default), latest = 最新",
      },
      score: {
        type: "string",
        enum: ["1", "2", "3", "4", "5"],
        description:
          "Filter by star rating (1=很差 … 5=力荐). Requires start-based paging.",
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        intervalMs: 200,
        timeoutMs: 10000,
        async inspect({ input, target }) {
          const source =
            `() => (location.origin === 'https://movie.douban.com') && document.readyState !== 'loading' && !!document.body`.replace(
              "__INPUT__",
              () => JSON.stringify(input),
            );
          const output = await tools.bash({
            command:
              "browser eval --tab=" +
              target.tabId +
              " -- " +
              "'" +
              source.replace(/'/g, "'\"'\"'") +
              "'",
            timeout: 15000,
          });
          if (output.truncated) throw new Error("Browser output was truncated");
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          return value === true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const source = `async () => {
function softNavigate(url, note) {
    // Return a plan; the SW action performs and awaits browser navigation.
    return { navigated: true, url, note };
}

function starClassToText(el) {
    if (!el)
        return '';
    const title = el.getAttribute('title');
    if (title)
        return title;
    const m = el.className.match(/allstar(\\d)0/);
    if (m) {
        const map = { '5': '力荐', '4': '推荐', '3': '还行', '2': '较差', '1': '很差' };
        return map[m[1]] || \`\${m[1]}星\`;
    }
    return '';
}
function readComments(limit) {
    return Array.from(document.querySelectorAll('#hot-comments .comment-item, #comments .comment-item'))
        .slice(0, limit)
        .map((c) => {
        const el = c;
        const meta = cleanText(el.querySelector('.comment-info')?.textContent);
        const date = (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [''])[0];
        const author = meta.replace(/\\s*(看过|想看|听过|在看).*$/, '').replace(/\\d{4}-\\d{2}-\\d{2}.*$/, '').trim();
        return {
            author,
            date,
            stars: starClassToText(el.querySelector('.comment-info .rating')),
            location: (meta.match(/\\d{2}:\\d{2}:?\\d*\\s*([^\\s]+)$/) || [])[1] || '',
            votes: cleanText(el.querySelector('.votes, .vote-count')?.textContent),
            text: cleanText(el.querySelector('.short')?.textContent),
        };
    })
        .filter((x) => x.text);
}
const args = __INPUT__;
const onSubjectPage = /movie\\.douban\\.com/.test(location.host) && /\\/subject\\/\\d+/.test(location.pathname);
const onCommentsPage = /movie\\.douban\\.com/.test(location.host) && /\\/subject\\/\\d+\\/comments/.test(location.pathname);
const start = Math.max(0, Number(args?.start) || 0);
const sort = args?.sort === 'latest' ? 'latest' : 'hot';
const score = ['1', '2', '3', '4', '5'].includes(String(args?.score)) ? String(args?.score) : null;
if (start > 0 || score) {
    const m = location.pathname.match(/\\/subject\\/(\\d+)/);
    if (!m)
        return { error: 'Not on a movie/TV detail page. Call open_subject first, then get_comments.' };
    const commentsUrl = \`https://movie.douban.com/subject/\${m[1]}/comments?start=\${start}&status=P&sort=\${sort === 'latest' ? 'new_score' : 'T'}\${score ? \`&score=\${score}\` : ''}\`;
    if (!onCommentsPage) {
        return softNavigate(commentsUrl, 'Navigating to the comments page. Call get_comments with the same start/score again in a few seconds to read it.');
    }
    const limitPaged = Math.max(1, Math.min(20, Number(args?.limit) || 20));
    const rows = readComments(limitPaged);
    const total = document.body.innerHTML.match(/全部\\s*([\\d,]+)\\s*条/)?.[1] || null;
    return {
        subject: cleanText(document.querySelector('#content h1 a')?.textContent),
        start,
        sort,
        score,
        total_comments: total,
        count: rows.length,
        comments: rows,
        next_start: rows.length >= limitPaged ? start + limitPaged : null,
    };
}
if (!onSubjectPage) {
    return {
        error: 'Not on a movie/TV detail page. Call open_subject (subject_id) first, then get_comments.',
    };
}
const limit = Math.max(1, Math.min(20, Number(args?.limit) || 10));
const comments = readComments(limit);
const h2 = document.querySelector('#hot-comments h2, .mod-hd h2');
const total = h2?.textContent?.match(/全部\\s*([\\d,]+)\\s*条/)?.[1];
return {
    subject: cleanText(document.querySelector('#content h1 span[property="v:itemreviewed"]')?.textContent),
    total_comments: total || null,
    count: comments.length,
    comments,
    note: comments.length === 0
        ? 'No comments rendered (login-gated or still loading) — try get_current_view.'
        : 'Paging / star filtering: call get_comments with start (0, 20, 40…) and optional sort=latest / score=1..5.',
};
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
          if (value && typeof value.error === "string")
            throw new Error(value.error);
          if (value?.navigated === true && typeof value.url === "string") {
            const url = "'" + value.url.replace(/'/g, "'\"'\"'") + "'";
            const navigation = await tools.bash({
              command:
                "browser goto --tab=" +
                target.tabId +
                " --wait-until=domcontentloaded -- " +
                url,
              timeout: 15000,
            });
            if (navigation.exitCode !== 0) throw new Error(navigation.stderr);
          }
          state.result = value;
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
