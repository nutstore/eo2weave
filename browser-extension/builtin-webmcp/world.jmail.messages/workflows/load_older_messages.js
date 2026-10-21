export default {
  inputSchema: {
    type: "object",
    properties: {
      times: {
        type: "number",
        description: "How many scroll loads to perform (default 3, max 10)",
        minimum: 1,
        maximum: 10,
      },
    },
  },
  outputSchema: true,
  tree: {
    type: "action",
    async run({ input, state, target, packageRoot }) {
      state.requested ??= Math.max(1, Math.min(10, Number(input.times) || 3));
      state.loads ??= 0;
      state.deadline ??= Date.now() + 15000;
      if (Date.now() < (state.nextReadAt || 0)) return "running";
      const source = `() => {
const args = __INPUT__;
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading') return null;
if(!currentSlug()) return {loaded:false,note:'Not on a JMessage conversation view. Call open_conversation first.'};
const pane=document.querySelector('.messages-container') || Array.from(document.querySelectorAll('main div')).filter(el=>el.scrollHeight>el.clientHeight+50).sort((a,b)=>b.scrollHeight-a.scrollHeight)[0];
if(!pane) return null;
const bubbles=readVisibleBubbles();
if(args.loads < args.requested) {
const reverse=getComputedStyle(pane).flexDirection === 'column-reverse';
pane.scrollTo({top:reverse ? -(pane.scrollHeight-pane.clientHeight) : 0,behavior:'auto'});
pane.dispatchEvent(new Event('scroll',{bubbles:true}));
}
return {bubbles};
}`.replace("__INPUT__", () =>
        JSON.stringify({ loads: state.loads, requested: state.requested }),
      );
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
      if (!value) {
        if (Date.now() > state.deadline) {
          state.result = {
            loaded: false,
            note: "No scrollable transcript pane found on this view.",
          };
          return "success";
        }
        return "running";
      }
      if (value.loaded === false) {
        state.result = value;
        return "success";
      }
      state.before ??= value.bubbles.length;
      state.previous ??= value.bubbles;
      if (state.loads === state.requested) {
        state.result = {
          loads_performed: state.loads,
          messages_before: state.before,
          messages_after: value.bubbles.length,
          newly_visible: value.bubbles.filter(
            (message) =>
              !state.previous.some(
                (before) =>
                  before.text === message.text && before.time === message.time,
              ),
          ),
          visible_messages: value.bubbles,
        };
        return "success";
      }
      state.loads++;
      state.nextReadAt = Date.now() + 600;
      return "running";
    },
  },
  result({ state }) {
    return state.result;
  },
};
