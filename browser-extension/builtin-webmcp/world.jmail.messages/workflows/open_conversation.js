export default {
  inputSchema: {
    type: "object",
    properties: {
      person: {
        type: "string",
        description: "Person slug from list_conversations (e.g. steve-bannon)",
      },
    },
    required: ["person"],
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
const slug=String(args.person||'').trim();
if(!slug || !/^[A-Za-z0-9_\\-.%]+$/.test(slug)) throw new Error('person is required (slug from list_conversations, e.g. steve-bannon)');
if(!findConversationRows().length) return null;
const el=document.querySelector('a[href="/messages/'+CSS.escape(slug)+'"][class~="mb-0.5"]');
if(!el) throw new Error('No conversation row for "'+slug+'". Call list_conversations for the available slugs.');
return Object.keys(el).some(key => key.startsWith('__reactProps$')) ? {selector:'a[href="/messages/'+CSS.escape(slug)+'"][class~="mb-0.5"]',slug} : null;
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
          state.selection = value;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const action = await tools.bash({
            command:
              "browser click --tab=" +
              target.tabId +
              " -- " +
              "'" +
              state.selection.selector.replace(/'/g, "'\"'\"'") +
              "'",
            timeout: 15000,
          });
          if (action.truncated) throw new Error("Browser output was truncated");
          if (action.exitCode !== 0) throw new Error(action.stderr);
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
if(currentSlug() !== args.slug) return null;
const bubbles=readVisibleBubbles(); if(!bubbles.length) return null;
const meta=readConversationMeta();
return {url:location.pathname,person:meta?.name || args.slug,slug:args.slug,message_count:meta?.messageCount ?? null,visible_messages:bubbles,note:'Newest messages render first. Long conversations lazy-load history — call load_older_messages to page back through time.'};
}`.replace("__INPUT__", () => JSON.stringify(state.selection));
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
