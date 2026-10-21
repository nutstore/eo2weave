export default {
  inputSchema: {
    type: "object",
    properties: {
      index: {
        type: "number",
        minimum: 0,
        description: "0-based row index from search_movies results",
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
        async inspect({ state, target }) {
          // Observe readiness and ordered results in the same page snapshot.
          const output = await tools.bash({
            command: String.raw`browser eval --tab=${target.tabId} <<'PAGE'
() => {
  if (location.origin !== "https://movie.douban.com" || document.readyState === "loading" || !document.body) return null;
  return Array.from(document.querySelectorAll('a.title-text[href*="/subject/"]'), a => ({
    title: (a.textContent || "").replace(/\s+/g, " ").trim(), url: a.href
  })).filter(row => row.title).slice(0, 25);
}
PAGE`,
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
          const rows = page.result;
          if (rows === null) return false;
          state.rows = rows;
          return true;
        },
      },
      {
        type: "action",
        async run({ input, state, target }) {
          const index = Number(input.index);
          if (!Number.isInteger(index) || index < 0)
            throw new Error("index must be a non-negative integer");
          const row = state.rows[index];
          if (!row?.url)
            throw new Error(
              `No result row at index ${index} (0-based; found ${state.rows.length} rows)`,
            );
          // URLs come from the page, so quote them as shell data.
          const url = "'" + row.url.replace(/'/g, "'\"'\"'") + "'";
          const output = await tools.bash({
            command: `browser goto --tab=${target.tabId} --wait-until=domcontentloaded -- ${url}`,
            timeout: 15000,
          });
          if (output.exitCode !== 0) throw new Error(output.stderr);
          if (output.truncated) throw new Error("Browser output was truncated");
          if (JSON.parse(output.stdout).tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          state.result = {
            navigated: true,
            url: row.url,
            note: `Opening "${row.title}". Call get_current_view in a few seconds to read the movie details.`,
          };
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
