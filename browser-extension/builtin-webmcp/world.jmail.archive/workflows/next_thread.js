export default {
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "number",
        description: "How many emails to advance (default 1, max 49)",
        minimum: 1,
        maximum: 49,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      state.requested ??= Math.max(1, Math.min(49, Number(input.steps) || 1));
      state.moved ??= 0;
      state.deadline ??= Date.now() + 45000;
      if (Date.now() > state.deadline)
        throw new Error("Thread pager timed out");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
const view=readThreadView();
const el=document.querySelector('a[aria-label="Next thread"]');
return {view,href:el?.getAttribute('href') || null,interactive: !!el && Object.keys(el).some(key => key.startsWith('__reactProps$'))};
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
      if (!value || !value.view.text?.trim()) return "running";
      if (
        state.awaiting &&
        value.view.url.split("?")[0] !== state.awaiting.split("?")[0]
      )
        return "running";
      state.awaiting = null;
      if (state.moved >= state.requested || (!value.href && state.moved)) {
        state.result = {
          ...value.view,
          steps_moved: state.moved,
          steps_requested: state.requested,
        };
        return "success";
      }
      if (!value.href)
        throw new Error(
          'No "next" control on the current view (thread pager only exists on /thread/*, person/topic links on list views).',
        );
      if (!value.interactive) return "running";
      const action = await tools.bash({
        command:
          "browser click --tab=" +
          target.tabId +
          " -- " +
          "'" +
          'a[aria-label="Next thread"]'.replace(/'/g, "'\"'\"'") +
          "'",
        timeout: 15000,
      });
      if (action.truncated) throw new Error("Browser output was truncated");
      if (action.exitCode !== 0) throw new Error(action.stderr);
      state.awaiting = value.href;
      state.moved++;
      state.nextReadAt =
        Date.now() + (state.moved === state.requested ? 600 : 350);
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
