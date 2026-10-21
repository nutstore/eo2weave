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
if (!(location.origin === 'https://jmail.world' && !location.pathname.startsWith('/messages')) || document.readyState === 'loading' || !document.body) return {ready: false};

const args = __INPUT__;
return {ready: true, result: await (async () => {
const links = Array.from(document.querySelectorAll('a[href^="/topic/"]'));
const seen = new Set();
const topics = [];
for (const a of links) {
    const slug = (a.getAttribute('href') || '').replace(/^\\/topic\\//, '');
    if (!slug || seen.has(slug))
        continue;
    seen.add(slug);
    topics.push({ slug, label: filterIconNoise(a.innerText || '').trim() });
}
return { count: topics.length, topics };
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
