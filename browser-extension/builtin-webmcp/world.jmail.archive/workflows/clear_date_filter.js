export default {
  inputSchema: {
    type: "object",
    properties: {},
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
const el=document.querySelector('button[aria-label="Filter by date range"]');
return el && Object.keys(el).some(key => key.startsWith('__reactProps$')) ? {active:el.classList.contains('date-filter-active') || /[?&](after|before)=/.test(location.search)} : null;
}`.replace("__INPUT__", () => JSON.stringify(input));
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
          if (!value) return false;
          state.active = value.active;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          if (state.active) {
            const action = await tools.bash({
              command:
                "browser click --tab=" +
                target.tabId +
                " -- " +
                "'" +
                'button[aria-label="Filter by date range"]'.replace(
                  /'/g,
                  "'\"'\"'",
                ) +
                "'",
              timeout: 15000,
            });
            if (action.truncated)
              throw new Error("Browser output was truncated");
            if (action.exitCode !== 0) throw new Error(action.stderr);
          }
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
if(!args.active) return true;
const el=document.querySelector('.date-filter-clear'); return !!el && !!el.getClientRects().length;
}`.replace("__INPUT__", () => JSON.stringify({ active: state.active }));
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
          if (state.active) {
            const action = await tools.bash({
              command:
                "browser click --tab=" +
                target.tabId +
                " -- " +
                "'" +
                ".date-filter-clear".replace(/'/g, "'\"'\"'") +
                "'",
              timeout: 15000,
            });
            if (action.truncated)
              throw new Error("Browser output was truncated");
            if (action.exitCode !== 0) throw new Error(action.stderr);
          }
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
if(!args.active) return {cleared:false,note:'No date filter is currently active.'};
if(/[?&](after|before)=/.test(location.search)) return null;
const rows=readRows(5); if(!rows.length && readTotalCount() !== '0') return null;
return {cleared:true,url:location.pathname+location.search,page_title:document.title,total:readTotalCount(),latest:rows,note:'Date filter cleared; full inbox restored. (On a thread page, call go_home first.)'};
}`.replace("__INPUT__", () => JSON.stringify({ active: state.active }));
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
