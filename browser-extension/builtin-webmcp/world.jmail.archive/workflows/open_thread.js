// Browser actions use Bash browser commands scoped to the adapter target tab.
export default {
  inputSchema: {
    type: "object",
    properties: {
      doc_id: {
        type: "string",
        description:
          "Thread doc id from search_emails results (e.g. HOUSE_OVERSIGHT_016203)",
      },
    },
    required: ["doc_id"],
  },
  outputSchema: true,
  tree: {
    type: "sequence",
    children: [
      {
        type: "action",
        async run({ input, state, target }) {
          const docId = String(input.doc_id || "").trim();
          if (!docId || !/^[A-Za-z0-9_\-.]+$/.test(docId))
            throw new Error("doc_id is required (letters, digits, _ - . only)");
          const url =
            "https://jmail.world/thread/" +
            encodeURIComponent(docId) +
            "?view=inbox";
          const output = await tools.bash({
            command: `browser goto --tab=${target.tabId} --wait-until=domcontentloaded -- '${url}'`,
            timeout: 15000,
          });
          if (output.exitCode !== 0) throw new Error(output.stderr);
          if (output.truncated) throw new Error("Browser output was truncated");
          if (JSON.parse(output.stdout).tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          state.result = { doc_id: docId, navigated: true, url };
          return "success";
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
