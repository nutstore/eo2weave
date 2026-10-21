export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max rows to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      state.deadline ??= Date.now() + 15000;
      if (Date.now() > state.deadline)
        throw new Error("Douban chart did not become ready");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      state.nextReadAt = Date.now() + 250;
      const source = `() => {
const args = __INPUT__;
if(location.origin !== 'https://movie.douban.com' || document.readyState === 'loading') return null;
function readChartPage(limit) {
    const out = [];
    for (const table of Array.from(document.querySelectorAll('table.item, table:has(tr.item)'))) {
        const link = table.querySelector('td.title a, .pl2 > a[href*="/subject/"]') || table.querySelector('a[href*="/subject/"]');
        const title = cleanText(link?.textContent);
        if (!link || !title)
            continue;
        const m = link.getAttribute('href')?.match(/subject\\/(\\d+)/);
        out.push({
            rank: out.length + 1,
            title,
            rating: cleanText(table.querySelector('.rating_nums')?.textContent),
            url: link.href,
            subject_id: m ? m[1] : null,
        });
        if (out.length >= limit)
            break;
    }
    return out;
}
if(location.pathname !== '/chart') return {navigated:true,url:'https://movie.douban.com/chart',note:'Navigating to the ranked chart page. Call browse_chart again in a few seconds to read it.'};
const rows=readChartPage(Math.max(1,Math.min(25,Number(args.limit)||10))); return rows.length ? {count:rows.length,results:rows} : null;
}`.replace("__INPUT__", () => JSON.stringify(input));
      const output = await tools.bash({
        command: `reader=$(cat '${packageRoot}readers/dom.js') || exit 1
page_source='${source.replace(/'/g, "'\"'\"'")}'
browser eval --tab=${target.tabId} "() => {
$reader
return ($page_source)();
}"`,
        timeout: 15000,
      });
      if (output.truncated) throw new Error("Browser output was truncated");
      if (output.exitCode !== 0) throw new Error(output.stderr);
      const page = JSON.parse(output.stdout);
      if (page.tabId !== target.tabId)
        throw new Error("Browser returned another tab");
      const value = page.result;
      if (!value) return "running";
      if (value.navigated) {
        const action = await tools.bash({
          command: `browser goto --tab=${target.tabId} --wait-until=domcontentloaded -- '${value.url}'`,
          timeout: 15000,
        });
        if (action.truncated) throw new Error("Browser output was truncated");
        if (action.exitCode !== 0) throw new Error(action.stderr);
      }
      state.result = value;
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
