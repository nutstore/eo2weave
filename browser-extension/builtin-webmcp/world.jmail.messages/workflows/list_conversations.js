export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max conversations to return (default 15, max 50)",
        minimum: 1,
        maximum: 50,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      state.deadline ??= Date.now() + 15000;
      if (Date.now() > state.deadline)
        throw new Error("Conversation list did not become ready");
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      state.nextReadAt = Date.now() + 250;
      const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
const rows=readConversationRows(Math.max(1,Math.min(50,Number(args.limit)||15)));
const el=document.querySelector('.jmail-dock a[href="/messages"], a[href="/messages"]');
return {rows, canNavigate: !!el && Object.keys(el).some(key => key.startsWith('__reactProps$'))};
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
      if (value.rows.length) {
        state.result = {
          count: value.rows.length,
          conversations: value.rows,
          hint: "Use open_conversation with a slug to read the messages.",
        };
        return "success";
      }
      if (!state.navigated && value.canNavigate) {
        const action = await tools.bash({
          command:
            "browser click --tab=" +
            target.tabId +
            " -- " +
            "'" +
            ' .jmail-dock a[href="/messages"], a[href="/messages"]'.replace(
              /'/g,
              "'\"'\"'",
            ) +
            "'",
          timeout: 15000,
        });
        if (action.truncated) throw new Error("Browser output was truncated");
        if (action.exitCode !== 0) throw new Error(action.stderr);
        state.navigated = true;
      }
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
