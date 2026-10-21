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
const el=document.querySelector(".jmail-dock a[href=\\"/messages\\"]"); return el ? {href:el.href,already:location.pathname === "/messages"} : null;
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
          state.navigation = value;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          // The dock can be outside the app viewport; follow its actual href explicitly.
          if (!state.navigation.already) {
            const url =
              "'" + state.navigation.href.replace(/'/g, "'\"'\"'") + "'";
            const action = await tools.bash({
              command:
                "browser goto --tab=" +
                target.tabId +
                " --wait-until=domcontentloaded -- " +
                url,
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
if(location.pathname !== "/messages") return null;
if(args.already) return {navigated:true,url:location.pathname,note:'Already on the conversation list.'};
const rows=readConversationRows(5); return rows.length ? {navigated:true,url:location.pathname,page_title:document.title,latest:rows,hint:'Conversation list restored. Use open_conversation or search_messages to continue.'} : null;
}`.replace("__INPUT__", () => JSON.stringify(state.navigation));
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
