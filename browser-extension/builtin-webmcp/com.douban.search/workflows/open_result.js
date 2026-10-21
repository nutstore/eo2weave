export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        description: "0-based row index from the results list",
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
        intervalMs: 200,
        timeoutMs: 10000,
        async inspect({ input, target }) {
          const source =
            `() => (location.origin === 'https://search.douban.com') && document.readyState !== 'loading' && !!document.body`.replace(
              "__INPUT__",
              () => JSON.stringify(input),
            );
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
          const source = `async () => {
function softNavigate(url, note) {
    // Return a plan; the SW action performs and awaits browser navigation.
    return { navigated: true, url, note };
}

const args = __INPUT__;
const index = Number(args.index);
if (!Number.isInteger(index) || index < 0)
    throw new Error('index must be a non-negative integer');
const rows = readSearchResults(25);
const row = rows[index];
if (!row?.url)
    throw new Error(\`No result row at index \${index} (0-based; found \${rows.length} rows)\`);
return softNavigate(row.url, \`Opening "\${row.title}". Call get_current_view in a few seconds to read the movie details.\`);
}`.replace("__INPUT__", () => JSON.stringify(input));
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
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (value && typeof value.error === "string")
            throw new Error(value.error);
          if (value?.navigated === true && typeof value.url === "string") {
            const url = "'" + value.url.replace(/'/g, "'\"'\"'") + "'";
            const navigation = await tools.bash({
              command:
                "browser goto --tab=" +
                target.tabId +
                " --wait-until=domcontentloaded -- " +
                url,
              timeout: 15000,
            });
            if (navigation.exitCode !== 0) throw new Error(navigation.stderr);
          }
          state.result = value;
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
