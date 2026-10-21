export default {
  inputSchema: {
    type: "object",
    properties: {
      start: {
        type: "number",
        description: "0-based row offset, multiple of 25 (default 0)",
        minimum: 0,
        maximum: 225,
      },
    },
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
            `() => (location.origin === 'https://movie.douban.com') && document.readyState !== 'loading' && !!document.body`.replace(
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
const start = Math.max(0, Math.min(225, Number(args?.start) || 0));
if (!/\\/top250/.test(location.pathname)) {
    return softNavigate(\`https://movie.douban.com/top250?start=\${start}\`, \`Navigating to Top 250 (rows \${start + 1}–\${start + 25}). Call get_top250 with the same start again in a few seconds to read it.\`);
}
const rows = readSubjectListRows(25, '#content');
return {
    range: { from: start + 1, to: start + rows.length },
    count: rows.length,
    results: rows,
    next_start: start + rows.length < 250 ? start + 25 : null,
    hint: 'Use open_subject with a subject_id to read a movie\\'s details.',
};
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
