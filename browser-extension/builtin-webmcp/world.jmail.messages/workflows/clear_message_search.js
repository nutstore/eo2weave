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
const el=findSearchInput(); return el && Object.keys(el).some(key => key.startsWith('__reactProps$')) ? {active:!!el.value} : null;
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
          state.active = value.active;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          if (state.active) {
            const action = await tools.bash({
              command: `browser fill --tab=${target.tabId} -- 'input[placeholder="Search"]' ''`,
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
const el=findSearchInput(); return el && !el.value && (!args.active || findConversationRows().length) ? {cleared:!!args.active,note:args.active ? 'Search cleared; the conversation list is restored.' : 'No search is currently active.'} : null;
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
