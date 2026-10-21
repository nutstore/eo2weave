export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        description: "Max comments to return (default 10, max 20)",
        minimum: 1,
        maximum: 20,
      },
      start: {
        type: "number",
        description:
          "0-based comment offset for paging through /comments (multiple of 20). Navigates to the comments page when set.",
        minimum: 0,
      },
      sort: {
        type: "string",
        enum: ["hot", "latest"],
        description: "hot = 最热门 (default), latest = 最新",
      },
      score: {
        type: "string",
        enum: ["1", "2", "3", "4", "5"],
        description: "Filter by star rating (1=很差 … 5=力荐). Requires start-based paging.",
      },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      subject: { type: "string" },
      total_comments: { type: ["string", "null"] },
      count: { type: "integer", minimum: 0 },
      comments: {
        type: "array",
        items: {
          type: "object",
          properties: {
            author: { type: "string" },
            date: { type: "string" },
            stars: { type: "string" },
            location: { type: "string" },
            votes: { type: "string" },
            text: { type: "string" },
          },
          required: ["author", "date", "stars", "location", "votes", "text"],
          additionalProperties: false,
        },
      },
      start: { type: "number", minimum: 0 },
      sort: { type: "string", enum: ["hot", "latest"] },
      score: { type: ["string", "null"], enum: ["1", "2", "3", "4", "5", null] },
      next_start: { type: ["number", "null"], minimum: 0 },
    },
    required: [
      "subject",
      "total_comments",
      "count",
      "comments",
      "start",
      "sort",
      "score",
      "next_start",
    ],
    additionalProperties: false,
  },
  tree: {
    type: "sequence",
    children: [
      {
        type: "wait",
        description: "Identify the current movie or TV subject",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            {},
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (page.kind !== "subject") throw new Error("Open a movie or TV detail page first");
          state.subject = page.subject_id;
          return true;
        },
      },
      {
        type: "action",
        description: "Open the requested comments page when paging or filtering",
        async run({ input, state, target }) {
          if (input.start !== undefined || input.score || input.sort) {
            const start = Number(input.start) || 0;
            const sort = input.sort === "latest" ? "new_score" : "T";
            state.commentsPath = "/subject/" + state.subject + "/comments";
            const url =
              "https://movie.douban.com" +
              state.commentsPath +
              "?start=" +
              start +
              "&status=P&sort=" +
              sort +
              (input.score ? "&score=" + input.score : "");
            await browser.goto(url, {
              tab: target.tabId,
              "wait-until": "domcontentloaded",
              timeout: 15000,
            });
          }
          return "success";
        },
      },
      {
        type: "wait",
        description: "Read the requested comments",
        intervalMs: 250,
        timeoutMs: 15000,
        async inspect({ input, state, target }) {
          const response = await browser.webmcp.exec(
            "com.douban.movie.read_page",
            { limit: input.limit || 10 },
            { tab: target.tabId, timeout: 15000 },
          );
          if (response.result.status !== "success")
            throw new Error("Page reader did not succeed");
          const page = response.result.result;
          if (!page.ready) return false;
          if (
            page.kind !== "subject" ||
            page.subject_id !== state.subject ||
            (state.commentsPath &&
              page.path !== state.commentsPath &&
              page.path !== state.commentsPath + "/")
          )
            return false;
          state.result = {
            subject: page.view.title,
            total_comments: page.total_comments,
            count: page.comments.length,
            comments: page.comments,
            start: input.start || 0,
            sort: input.sort || "hot",
            score: input.score || null,
            next_start:
              page.comments.length === (input.limit || 10)
                ? (input.start || 0) + page.comments.length
                : null,
          };
          return true;
        },
      },
    ],
  },
  result({ state }) {
    return state.result;
  },
};
