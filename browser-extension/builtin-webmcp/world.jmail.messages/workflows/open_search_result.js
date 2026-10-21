export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from search_messages results",
        minimum: 0,
      },
    },
    required: ["index"],
  },
  outputSchema: true,
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target, packageRoot }) {
          const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
const index=Number(args.index);
if(!Number.isInteger(index)||index<0) throw new Error('index must be a non-negative integer (0-based row from search_messages results)');
const rows=readSearchResultRows(index+1);
if(!rows.length) return null;
if(!rows[index]) throw new Error('No search-result row at index '+index+'. Run search_messages again first — opening a result clears the list (or the search was cleared).');
return rows[index];
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
          if (!value) return false;
          state.hit = value;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const source = `() => {
const args = __INPUT__;
const norm=s=>s.replace(/\\s+/g,' ').trim();
const btn=Array.from((document.querySelector('main')||document.body).querySelectorAll('button')).find(el=> {
const text=norm(el.innerText||''); return el.offsetParent && text.includes(args.date) && text.startsWith(norm(args.person)) && (!args.snippet || text.includes(norm(args.snippet).slice(0,40)));
});
if(!btn) throw new Error('Could not relocate the on-screen search row. Run search_messages again.');
btn.click(); return true;
}`.replace("__INPUT__", () => JSON.stringify(state.hit));
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
          return "success";
        },
      },
      {
        type: "wait",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target, packageRoot }) {
          const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
const slug=currentSlug(); const bubbles=readVisibleBubbles();
if(!slug || !bubbles.length) return null;
const meta=readConversationMeta();
return {url:location.pathname,person:meta?.name || args.person,slug,message_count:meta?.messageCount ?? null,matched_message_date:args.date,matched_snippet:args.snippet,visible_messages:bubbles,note:'The conversation renders from the NEWEST message; the hit may be older — use load_older_messages to page back toward its date.'};
}`.replace("__INPUT__", () => JSON.stringify(state.hit));
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
          if (!value) return false;
          state.result = value;
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
