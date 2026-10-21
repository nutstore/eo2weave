export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from search_emails results",
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
if(!Number.isInteger(index)||index<0) throw new Error('index must be a non-negative integer');
const rows=findRowElements(); if(!rows.length) return null;
if(!rows[index]) throw new Error('No result row at index '+index+' (0-based; found '+rows.length+' rows)');
const el=rows[index]; return Object.keys(el).some(key => key.startsWith('__reactProps$')) ? true : null;
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
          return value === true;
        },
      },
      {
        type: "action",
        async run({ input, state, target, packageRoot }) {
          const source = `() => {
const args = __INPUT__;
const row=findRowElements()[Number(args.index)];
if(!row) throw new Error('The result row disappeared before opening');
const parsed=parseRow(row,Number(args.index));
const leaves=Array.from(row.querySelectorAll('div')).filter(el => !el.children.length && (el.innerText||'').trim());
const exact=parsed?.subject && leaves.find(el => el.innerText.trim() === parsed.subject);
const longest=leaves.sort((a,b)=>b.innerText.trim().length-a.innerText.trim().length)[0];
(exact || (parsed?.subject && longest) || row).click();
return true;
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
if(!location.pathname.startsWith('/thread/')) return null;
const view=readThreadView(); return view.text?.trim() ? view : null;
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
