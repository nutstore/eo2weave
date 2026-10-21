export default {
  inputSchema: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        enum: [
          "inbox",
          "starred",
          "unredactions",
          "sent",
          "attachments",
          "activity",
        ],
        description: "Folder to open",
      },
    },
    required: ["folder"],
  },
  outputSchema: true,
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        intervalMs: 200,
        timeoutMs: 10000,
        async inspect({ input, state, target }) {
          const source = `() => {
if (location.origin !== 'https://jmail.world' || document.readyState === 'loading' || !document.body) return null;
const args = __INPUT__;
const FOLDERS = {
            inbox: '/',
            starred: '/starred',
            unredactions: '/unredactions',
            sent: '/sent',
            attachments: '/attachments',
            activity: '/activity/2014',
        };
        const folder = String(args.folder || '')
            .trim()
            .toLowerCase();
        const href = FOLDERS[folder];
        if (!href) {
            return {
                navigated: false,
                error: \`Unknown folder "\${folder}". Available: \${Object.keys(FOLDERS).join(', ')}.\`,
            };
        }
const selector = \`nav a.nav-item[href="\${href}"]\`;
const anchor = document.querySelector(selector);
if (!anchor) throw new Error('No "' + \`folder:\${folder}\` + '" control on the current view (thread pager only exists on /thread/*, person/topic links on list views).');
return {selector, path: (anchor.getAttribute('href') || '').split('?')[0]};
}`
            .replace("__INPUT__", () => JSON.stringify(input))
            .replace("__STATE__", () => JSON.stringify(state));
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
          if (output.exitCode !== 0) {
            if (
              /execution context was destroyed|cannot find context with specified id|cannot find default execution context/i.test(
                output.stderr,
              )
            )
              return false;
            throw new Error(output.stderr);
          }
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (!value) return false;
          state.selector = value.selector;
          state.path = value.path;
          return true;
        },
      },
      {
        type: "action",
        async run({ state, target }) {
          const selector = "'" + state.selector.replace(/'/g, "'\"'\"'") + "'";
          const output = await tools.bash({
            command: "browser click --tab=" + target.tabId + " -- " + selector,
            timeout: 15000,
          });
          if (output.exitCode !== 0) throw new Error(output.stderr);
          state.readAfter = Date.now() + 2500;
          return "success";
        },
      },
      {
        type: "wait",
        intervalMs: 200,
        timeoutMs: 10000,
        async inspect({ input, state, target, packageRoot }) {
          const source = `() => {
const state = __STATE__;
if (!(location.pathname + location.search).startsWith(state.path)) return {ready: false};

const rows = readRows(10);
if (!rows.length && Date.now() < state.readAfter) return {ready: false};
return {ready:true, result: rows.length ? {url: location.pathname + location.search, page_title: document.title, total: readTotalCount(), results: rows, hint: 'Rows listed. open_result to open one; next_thread/prev_thread to page through.'} : readThreadView()};
}`
            .replace("__INPUT__", () => JSON.stringify(input))
            .replace("__STATE__", () => JSON.stringify(state));
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
          if (output.exitCode !== 0) {
            if (
              /execution context was destroyed|cannot find context with specified id|cannot find default execution context/i.test(
                output.stderr,
              )
            )
              return false;
            throw new Error(output.stderr);
          }
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (!value.ready) return false;
          state.result = value.result;
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
