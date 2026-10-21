export default {
  inputSchema: {
    type: "object",
    properties: {
      section: {
        type: "string",
        enum: [
          "home",
          "nowplaying",
          "coming",
          "explore",
          "tv",
          "chart",
          "reviews",
        ],
        description: "Section to open",
      },
    },
    required: ["section"],
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
        async run({ input, state, target }) {
          const source = `async () => {
function softNavigate(url, note) {
    // Return a plan; the SW action performs and awaits browser navigation.
    return { navigated: true, url, note };
}
const args = __INPUT__;
const SECTIONS = {
    home: 'https://movie.douban.com/',
    nowplaying: 'https://movie.douban.com/cinema/nowplaying/',
    coming: 'https://movie.douban.com/cinema/later/',
    explore: 'https://movie.douban.com/explore',
    tv: 'https://movie.douban.com/tv/',
    chart: 'https://movie.douban.com/chart',
    reviews: 'https://movie.douban.com/review/best/',
};
const section = String(args.section || '').trim().toLowerCase();
const url = SECTIONS[section];
if (!url) {
    return {
        navigated: false,
        error: \`Unknown section "\${section}". Available: \${Object.keys(SECTIONS).join(', ')}.\`,
    };
}
return softNavigate(url, \`Navigating to "\${section}". Call get_current_view in a few seconds to read it.\`);
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
