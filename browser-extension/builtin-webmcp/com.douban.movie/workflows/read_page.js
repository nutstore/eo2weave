export default {
  inputSchema: {
    type: "object",
    properties: {
      limit: {
        type: "number",
        minimum: 1,
        maximum: 100,
        default: 10,
        description: "Maximum rows per collection",
      },
      query: {
        type: "string",
        description: "When supplied, only read search results for this exact query",
      },
    },
    additionalProperties: false,
  },
  outputSchema: {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    definitions: {
      genericView: {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_subject_page: { const: false },
          text: { type: "string" },
        },
        required: ["url", "page_title", "is_subject_page", "text"],
        additionalProperties: false,
      },
      subjectView: {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_subject_page: { const: true },
          title: { type: "string" },
          year: { type: "string" },
          rating: { type: "string" },
          rating_people: { type: "string" },
          star_distribution: {
            type: "array",
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                stars: { type: "string" },
                percent: { type: "string" },
              },
              required: ["stars", "percent"],
              additionalProperties: false,
            },
          },
          info: { type: "object", additionalProperties: { type: "string" } },
          summary: { type: "string" },
          hot_comments: {
            type: "array",
            maxItems: 10,
            items: {
              type: "object",
              properties: {
                author: { type: "string" },
                date: { type: "string" },
                stars: { type: "string" },
                votes: { type: "string" },
                text: { type: "string" },
              },
              required: ["author", "date", "stars", "votes", "text"],
              additionalProperties: false,
            },
          },
        },
        required: [
          "url",
          "page_title",
          "is_subject_page",
          "title",
          "year",
          "rating",
          "rating_people",
          "star_distribution",
          "info",
          "summary",
          "hot_comments",
        ],
        additionalProperties: false,
      },
      celebrityView: {
        type: "object",
        properties: {
          url: { type: "string" },
          page_title: { type: "string" },
          is_celebrity_page: { const: true },
          name: { type: "string" },
          photo: { type: ["string", "null"] },
          bio: { type: "string" },
          filmography: {
            type: "object",
            additionalProperties: {
              type: "array",
              minItems: 1,
              maxItems: 10,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  rating: { type: "string" },
                  subject_id: { type: "string" },
                },
                required: ["title", "rating", "subject_id"],
                additionalProperties: false,
              },
            },
          },
          awards: { type: "string" },
        },
        required: ["url", "page_title", "is_celebrity_page", "name", "photo", "bio", "filmography"],
        additionalProperties: false,
      },
      searchResult: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0, maximum: 24 },
          title: { type: "string", minLength: 1 },
          rating: { type: "string", minLength: 1 },
          url: { type: "string", minLength: 1 },
          subject_id: { type: ["string", "null"], pattern: "^\\d+$" },
          detail: { type: "string" },
        },
        required: ["index", "title", "rating", "url", "subject_id", "detail"],
        additionalProperties: false,
      },
      subjectListRow: {
        type: "object",
        properties: {
          rank: { type: "integer", minimum: 1 },
          title: { type: "string" },
          rating: { type: "string" },
          url: { type: "string" },
          subject_id: { type: "string", pattern: "^\\d+$" },
          detail: { type: "string" },
        },
        required: ["rank", "title", "rating", "url", "subject_id"],
        additionalProperties: false,
      },
      chartRow: {
        type: "object",
        properties: {
          rank: { type: "integer", minimum: 1 },
          title: { type: "string" },
          rating: { type: "string" },
          url: { type: "string" },
          subject_id: { type: ["string", "null"], pattern: "^\\d+$" },
        },
        required: ["rank", "title", "rating", "url", "subject_id"],
        additionalProperties: false,
      },
      comment: {
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
      review: {
        type: "object",
        properties: {
          review_id: { type: ["string", "null"] },
          title: { type: "string" },
          author: { type: "string" },
          date: { type: "string" },
          spoiler: { type: "boolean" },
          excerpt: { type: "string" },
          url: { type: ["string", "null"] },
        },
        required: ["review_id", "title", "author", "date", "spoiler", "excerpt", "url"],
        additionalProperties: false,
      },
      tv: {
        type: "object",
        properties: {
          subject: { type: "string" },
          episode_count: { type: ["string", "null"] },
          series: {
            type: ["object", "null"],
            properties: {
              key: { type: ["string", "null"] },
              url: { type: "string" },
            },
            required: ["key", "url"],
            additionalProperties: false,
          },
          seasons: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                season: { type: "string" },
                subject_id: { type: "string", pattern: "^\\d+$" },
              },
              required: ["season", "subject_id"],
              additionalProperties: false,
            },
          },
          episodes: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                episode: { type: "string" },
                title: { type: "string" },
                rating: { type: "string" },
                url: { type: ["string", "null"] },
              },
              required: ["episode", "title", "rating", "url"],
              additionalProperties: false,
            },
          },
          note: { type: "string" },
        },
        required: ["subject", "episode_count", "series"],
        additionalProperties: false,
      },
      nowPlayingRow: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0, maximum: 29 },
          title: { type: "string" },
          rating: { type: "string" },
          subject_id: { type: ["string", "null"], pattern: "^\\d+$" },
          url: { type: ["string", "null"] },
          release: { type: "string" },
          region: { type: "string" },
          director: { type: "string" },
          actors: { type: "string" },
        },
        required: ["index", "title", "rating", "subject_id", "url", "release", "region", "director", "actors"],
        additionalProperties: false,
      },
    },
    properties: {
      ready: { type: "boolean" },
      kind: { enum: ["search", "subject", "celebrity", "chart", "top250", "doulist", "home"] },
      url: { type: "string" },
      route: { type: "string" },
      path: { type: "string" },
      params: { type: "object", additionalProperties: { type: "string" } },
      page_title: { type: "string" },
      query: { type: "string" },
      results_ready: { type: "boolean" },
      count: { type: "integer", minimum: 0, maximum: 25 },
      results: {
        type: "array",
        maxItems: 25,
        items: {
          anyOf: [
            { $ref: "#/definitions/searchResult" },
            { $ref: "#/definitions/subjectListRow" },
            { $ref: "#/definitions/chartRow" },
          ],
        },
      },
      view: {
        oneOf: [
          { $ref: "#/definitions/genericView" },
          { $ref: "#/definitions/subjectView" },
          { $ref: "#/definitions/celebrityView" },
        ],
      },
      subject_id: { type: "string", pattern: "^\\d+$" },
      comments: { type: "array", maxItems: 20, items: { $ref: "#/definitions/comment" } },
      reviews: { type: "array", maxItems: 10, items: { $ref: "#/definitions/review" } },
      total_comments: { type: ["string", "null"] },
      tv: { $ref: "#/definitions/tv" },
      start: { type: "number", minimum: 0 },
      title: { type: "string" },
      description: { type: "string" },
      now_playing: {
        type: "array",
        maxItems: 30,
        items: { $ref: "#/definitions/nowPlayingRow" },
      },
      weekly: { type: "array", items: { $ref: "#/definitions/chartRow" } },
    },
    required: ["ready"],
    allOf: [
      {
        if: { properties: { ready: { const: true } }, required: ["ready"] },
        then: {
          required: ["ready", "kind", "url", "route", "path", "params", "page_title"],
        },
      },
      {
        if: { properties: { ready: { const: false } }, required: ["ready"] },
        then: { maxProperties: 1 },
      },
      {
        if: {
          properties: { kind: { const: "search" } },
          required: ["kind"],
        },
        then: {
          required: ["query", "count", "results", "results_ready"],
          properties: { results: { type: "array", maxItems: 25, items: { $ref: "#/definitions/searchResult" } } },
        },
      },
      {
        if: {
          properties: { kind: { const: "subject" } },
          required: ["kind"],
        },
        then: {
          required: ["subject_id", "comments", "reviews", "total_comments", "tv", "view"],
          properties: { view: { $ref: "#/definitions/subjectView" } },
        },
      },
      {
        if: {
          properties: { kind: { const: "celebrity" } },
          required: ["kind"],
        },
        then: {
          required: ["view"],
          properties: { view: { $ref: "#/definitions/celebrityView" } },
        },
      },
      {
        if: {
          properties: { kind: { const: "chart" } },
          required: ["kind"],
        },
        then: {
          required: ["view", "results", "results_ready"],
          properties: {
            view: { $ref: "#/definitions/genericView" },
            results: { type: "array", maxItems: 25, items: { $ref: "#/definitions/chartRow" } },
          },
        },
      },
      {
        if: {
          properties: { kind: { enum: ["top250", "doulist"] } },
          required: ["kind"],
        },
        then: {
          required: ["view", "results", "start", "title", "description", "results_ready"],
          properties: {
            view: { $ref: "#/definitions/genericView" },
            results: { type: "array", maxItems: 25, items: { $ref: "#/definitions/subjectListRow" } },
          },
        },
      },
      {
        if: {
          properties: { kind: { const: "home" } },
          required: ["kind"],
        },
        then: {
          required: ["view", "now_playing", "weekly"],
          properties: {
            view: { $ref: "#/definitions/genericView" },
            now_playing: { type: "array", maxItems: 30, items: { $ref: "#/definitions/nowPlayingRow" } },
            weekly: { type: "array", items: { $ref: "#/definitions/chartRow" } },
          },
        },
      },
    ],
    additionalProperties: false,
  },
  tree: {
    type: "action",
    description: "Read a single page snapshot without interacting with the site",
    async run({ input, state, target }) {
      const source = `() => {
  const args = ${JSON.stringify(input)};

  if (document.readyState === "loading" || !document.body) return { ready: false };
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 10));
  const base = {
    ready: true,
    url: location.href,
    route: location.pathname + location.search,
    params: Object.fromEntries(new URL(location.href).searchParams),
    path: location.pathname,
    page_title: document.title,
  };
  function cleanText(s) {
    return (s || "").replace(/\\s+/g, " ").trim();
  }

  function readSubjectListRows(limit, rootSelector) {
    const root = rootSelector ? document.querySelector(rootSelector) : document;
    const out = [];
    const seen = new Set();
    const anchors = Array.from((root || document).querySelectorAll('a[href*="subject/"]'));
    for (const a of anchors) {
      const m = a.getAttribute("href")?.match(/subject\\/(\\d+)/);
      const id = m?.[1];
      const rawTitle = cleanText(a.textContent);
      if (!id || !rawTitle || seen.has(id)) continue;
      const title = rawTitle.replace(/\\s*\\(\\d{4}\\)\\s*$/, "").trim() || rawTitle;
      const container = a.closest("table.item, .item, li, .ob, div") || a.parentElement;
      const rating = cleanText(container?.querySelector(".rating_nums")?.textContent);
      const detail = cleanText(
        container?.querySelector(".pl, .subject-cast, .detail")?.textContent,
      );
      seen.add(id);
      out.push({
        rank: out.length + 1,
        title,
        rating,
        url: a.href,
        subject_id: id,
        detail: detail || undefined,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function readSearchResults(limit) {
    if (
      /搜索访问太频繁|搜索访问过于频繁|Too many requests/i.test(document.body?.innerText || "")
    )
      throw new Error("Douban search is rate-limited by the site");
    const out = [];
    const anchors = Array.from(document.querySelectorAll('a.title-text[href*="/subject/"]'));
    for (const a of anchors) {
      const title = cleanText(a.textContent).replace(/\\s*\\(\\d{4}\\)\\s*$/, (m) => m);
      if (!title) continue;
      const moreurl = a.getAttribute("data-moreurl") || "";
      const id =
        moreurl.match(/subject_id:'(\\d+)'/)?.[1] ||
        a.getAttribute("href")?.match(/subject\\/(\\d+)/)?.[1] ||
        null;
      const item =
        a.closest('div[class*="item"], .result, [class*="subject"]') ||
        a.parentElement?.parentElement ||
        a;
      const ratingNum = item?.querySelector(".rating_nums")?.textContent?.trim();
      const rating = ratingNum
        ? \`\${ratingNum}（\${cleanText(item?.querySelector(".rating")?.textContent)
            .replace(/^[\\d.]+/, "")
            .replace(/[()（）]/g, "")}）\`
        : "暂无评分";
      const meta = cleanText(
        item?.querySelector('.subject-cast, .detail, [class*="cat"]')?.textContent,
      );
      out.push({
        index: out.length,
        title,
        rating,
        url: a.href,
        subject_id: id,
        detail: meta,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function readChartPage(limit) {
    const out = [];
    for (const table of Array.from(
      document.querySelectorAll("table.item, table:has(tr.item)"),
    )) {
      const link =
        table.querySelector('td.title a, .pl2 > a[href*="/subject/"]') ||
        table.querySelector('a[href*="/subject/"]');
      const title = cleanText(link?.textContent);
      if (!link || !title) continue;
      const m = link.getAttribute("href")?.match(/subject\\/(\\d+)/);
      out.push({
        rank: out.length + 1,
        title,
        rating: cleanText(table.querySelector(".rating_nums")?.textContent),
        url: link.href,
        subject_id: m ? m[1] : null,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function readNowPlaying(limit) {
    const items = Array.from(document.querySelectorAll("#screening li.ui-slide-item"));
    const out = [];
    for (const li of items) {
      const d = li.dataset || {};
      const title = cleanText(d.title);
      if (!title) continue;
      const link = li.querySelector('a.title[href*="/subject/"]');
      const m = link?.getAttribute("href")?.match(/subject\\/(\\d+)/);
      out.push({
        index: out.length,
        title,
        rating: cleanText(d.rating) || "暂无评分",
        subject_id: m ? m[1] : null,
        url: link?.href || null,
        release: cleanText(d.release),
        region: cleanText(d.region),
        director: cleanText(d.director),
        actors: cleanText(d.actors),
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  function readWeeklyChart() {
    const root =
      document.querySelector("#weekly") ||
      Array.from(document.querySelectorAll("div, section")).find(
        (el) =>
          cleanText(el.textContent).startsWith("一周口碑榜") &&
          el.querySelector('a[href*="/subject/"]'),
      ) ||
      null;
    if (!root) return [];
    const out = [];
    for (const tr of Array.from(root.querySelectorAll("tr"))) {
      const link = tr.querySelector('a[href*="/subject/"]');
      const title = cleanText(link?.textContent);
      if (!link || !title) continue;
      const m = link.getAttribute("href")?.match(/subject\\/(\\d+)/);
      out.push({
        rank: out.length + 1,
        title,
        rating: cleanText(tr.querySelector(".rating_nums")?.textContent),
        url: link.href,
        subject_id: m ? m[1] : null,
      });
    }
    return out;
  }

  function readSubjectView() {
    const isSubject = /\\/subject\\/\\d+/.test(location.pathname);
    const main = document.querySelector("#content") || document.body;
    const base = {
      url: location.pathname + location.search,
      page_title: cleanText(document.title),
    };
    if (!isSubject) {
      return {
        ...base,
        is_subject_page: false,
        text: cleanText(main.innerText).slice(0, 6000),
      };
    }
    const h1 = document.querySelector("#content h1");
    const year = cleanText(h1?.querySelector(".year")?.textContent);
    const titleSpan =
      h1?.querySelector('span[property="v:itemreviewed"]') || h1?.querySelector("span") || h1;
    const title = cleanText(titleSpan?.textContent)
      .replace(/\\d{4}$/, "")
      .trim();
    const info = {};
    const infoEl = document.querySelector("#info");
    if (infoEl) {
      let lastKey = "";
      for (const line of infoEl.innerText.split("\\n")) {
        const idx = line.indexOf(":");
        if (idx > 0 && idx < 12) {
          lastKey = line.slice(0, idx).trim();
          info[lastKey] = line.slice(idx + 1).trim();
        } else if (lastKey) {
          info[lastKey] += " " + line.trim();
        }
      }
      for (const k of Object.keys(info)) info[k] = info[k].trim();
    }
    const ratingNum = cleanText(document.querySelector("strong.rating_num")?.textContent);
    const ratingPeople = cleanText(
      document.querySelector('a.rating_people span[property="v:votes"]')?.textContent ||
        document.querySelector("a.rating_people")?.textContent,
    );
    const stars = Array.from(document.querySelectorAll(".rating_ind"))
      .map((el, i) => {
        const per = el.parentElement?.querySelector(".rating_per");
        return { stars: \`\${5 - i}星\`, percent: cleanText(per?.textContent) };
      })
      .filter((s) => s.percent);
    const summary = cleanText(
      Array.from(document.querySelectorAll('span[property="v:summary"], .related-info .intro'))
        .map((el) => el.textContent || "")
        .join("\\n"),
    );
    const comments = Array.from(
      document.querySelectorAll("#hot-comments .comment-item, #comments .comment-item"),
    )
      .slice(0, 10)
      .map((c) => {
        const meta = cleanText(c.querySelector(".comment-info")?.textContent);
        const ratingEl = c.querySelector(".comment-info .rating");
        const starsTitle =
          ratingEl?.title || ratingEl?.className?.match(/allstar(\\d+)/)?.[1] || "";
        const votes = cleanText(c.querySelector(".vote-count")?.textContent);
        return {
          author: meta.replace(/\\s*\\d{4}-\\d{2}-\\d{2}.*$/, "").trim(),
          date: (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [""])[0],
          stars: String(starsTitle)
            .replace("力荐", "5星")
            .replace("推荐", "4星")
            .replace("还行", "3星")
            .replace("较差", "2星")
            .replace("很差", "1星"),
          votes: votes.replace(/(\\d+)\\s*有用/, "$1"),
          text: cleanText(c.querySelector(".short")?.textContent),
        };
      })
      .filter((c) => c.text);
    return {
      ...base,
      is_subject_page: true,
      title,
      year: year.replace(/[()]/g, ""),
      rating: ratingNum || "暂无评分",
      rating_people: ratingPeople,
      star_distribution: stars,
      info,
      summary: summary.slice(0, 3000),
      hot_comments: comments,
    };
  }

  function starClassToText(el) {
    if (!el) return "";
    const title = el.getAttribute("title");
    if (title) return title;
    const m = el.className.match(/allstar(\\d)0/);
    if (m) {
      const map = { 5: "力荐", 4: "推荐", 3: "还行", 2: "较差", 1: "很差" };
      return map[m[1]] || \`\${m[1]}星\`;
    }
    return "";
  }

  function readComments(limit) {
    return Array.from(
      document.querySelectorAll("#hot-comments .comment-item, #comments .comment-item"),
    )
      .slice(0, limit)
      .map((c) => {
        const el = c;
        const meta = cleanText(el.querySelector(".comment-info")?.textContent);
        const date = (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [""])[0];
        const author = meta
          .replace(/\\s*(看过|想看|听过|在看).*$/, "")
          .replace(/\\d{4}-\\d{2}-\\d{2}.*$/, "")
          .trim();
        return {
          author,
          date,
          stars: starClassToText(el.querySelector(".comment-info .rating")),
          location: (meta.match(/\\d{2}:\\d{2}:?\\d*\\s*([^\\s]+)$/) || [])[1] || "",
          votes: cleanText(el.querySelector(".votes, .vote-count")?.textContent),
          text: cleanText(el.querySelector(".short")?.textContent),
        };
      })
      .filter((x) => x.text);
  }

  function readReviews(limit) {
    return Array.from(document.querySelectorAll(".review-item"))
      .slice(0, limit)
      .map((r) => {
        const el = r;
        const link = el.querySelector('h2 a[href*="/review/"]');
        const metaEl = el.querySelector(".header-meta, .meta, .byline");
        let meta = cleanText(metaEl?.textContent);
        if (!meta) {
          for (const d of Array.from(el.querySelectorAll("div"))) {
            const t = cleanText(d.textContent);
            if (/\\d{4}-\\d{2}-\\d{2}/.test(t) && t.length < 80) {
              meta = t;
              break;
            }
          }
        }
        const excerptRaw = cleanText(el.querySelector(".short-content")?.textContent);
        const spoiler = excerptRaw.includes("剧透");
        const excerpt = excerptRaw
          .replace(/^这篇影评可能有剧透\\s*/, "")
          .replace(/\\(展开\\)?$/, "")
          .slice(0, 300);
        return {
          review_id:
            el.id || (link?.getAttribute("href")?.match(/review\\/(\\d+)/)?.[1] ?? null),
          title: cleanText(link?.textContent),
          author: meta.split(/\\d{4}-/)[0].trim(),
          date: (meta.match(/\\d{4}-\\d{2}-\\d{2}/) || [""])[0],
          spoiler,
          excerpt,
          url: link?.href || null,
        };
      })
      .filter((x) => x.title);
  }

  function readTvInfo(episodeLimit) {
    if (!/\\/subject\\/\\d+/.test(location.pathname)) {
      return {
        error:
          "Not on a movie/TV detail page. Call open_subject (subject_id) first, then get_tv_info.",
      };
    }
    const currentId = location.pathname.match(/subject\\/(\\d+)/)?.[1];
    const currentTitle = cleanText(
      document.querySelector('#content h1 span[property="v:itemreviewed"]')?.textContent,
    );
    const seen = new Set();
    const seasonList = Array.from(
      document.querySelectorAll(
        '#season a[href*="/subject/"], .seasons a[href*="/subject/"], #content a[href*="/subject/"] img[src*="poster"], .subject-item a[href*="/subject/"]',
      ),
    )
      .map((el) => (el instanceof HTMLImageElement ? el.closest("a") : el))
      .filter((a) => !!a?.getAttribute("href")?.match(/subject\\/(\\d+)/))
      .map((a) => {
        const m = a.getAttribute("href")?.match(/subject\\/(\\d+)/);
        return {
          season: cleanText(
            a.getAttribute("title") ||
              a.querySelector("img")?.getAttribute("alt") ||
              a.textContent,
          ).replace(/\\s*\\(\\d{4}\\)\\s*$/, ""),
          subject_id: m?.[1] || "",
        };
      })
      .filter(
        (s) =>
          s.season &&
          s.subject_id &&
          s.subject_id !== currentId &&
          !seen.has(s.subject_id) &&
          seen.add(s.subject_id),
      );
    const seriesLink = document.querySelector('a[href*="/series/"]');
    const series = seriesLink
      ? {
          key: seriesLink.getAttribute("href")?.match(/series\\/([A-Z0-9]+)/)?.[1] || null,
          url: seriesLink.href,
        }
      : null;
    const episodes = Array.from(document.querySelectorAll("#eps-table tr"))
      .slice(0, episodeLimit)
      .map((tr) => {
        const el = tr;
        const link = el.querySelector("a");
        return {
          episode: cleanText(el.querySelector(".episode")?.textContent),
          title: cleanText(link?.textContent),
          rating: cleanText(el.querySelector(".rating_nums")?.textContent),
          url: link?.href || null,
        };
      })
      .filter((e) => e.title || e.episode);
    return {
      subject: currentTitle,
      episode_count:
        cleanText(document.querySelector('span[property="v:total-episodes"]')?.textContent) ||
        document.querySelector("#info")?.innerText.match(/集数:\\s*(\\d+)/)?.[1] ||
        (document.body.innerHTML.match(
          /<span[^>]*property="v:total-episodes"[^>]*>(\\d+)</,
        )?.[1] ??
          null),
      series,
      seasons: seasonList.length ? seasonList : undefined,
      episodes: episodes.length ? episodes : undefined,
      note:
        episodes.length === 0 && seasonList.length === 0 && !series
          ? "No seasons/episodes found — this may be a movie, or episode data is login-gated."
          : episodes.length === 0
            ? "Episode-level data requires login; use the seasons/series fields to navigate between entries."
            : undefined,
    };
  }

  function readCelebrityView() {
    const isCelebrity = /\\/celebrity\\/\\d+/.test(location.pathname);
    const base = {
      url: location.pathname + location.search,
      page_title: cleanText(document.title),
    };
    if (!isCelebrity) {
      const main = document.querySelector("#content") || document.body;
      return {
        ...base,
        is_celebrity_page: false,
        text: cleanText(main.innerText).slice(0, 4000),
      };
    }
    const name = cleanText(document.querySelector("#content h1")?.textContent);
    const bio = cleanText(
      Array.from(document.querySelectorAll("#intro p"))
        .map((p) => p.textContent || "")
        .join("\\n"),
    );
    const works = {};
    for (const mod of Array.from(document.querySelectorAll("#content .mod"))) {
      const heading = cleanText(mod.querySelector("h2")?.textContent);
      if (!heading) continue;
      const rows = Array.from(mod.querySelectorAll('a[href*="/subject/"]'))
        .slice(0, 10)
        .map((a) => {
          const m = a.getAttribute("href")?.match(/subject\\/(\\d+)/);
          const container = a.closest(".ob, li, div") || a.parentElement;
          return {
            title: cleanText(a.textContent)
              .replace(/\\s*\\(\\d{4}\\)\\s*$/, "")
              .trim(),
            rating: cleanText(container?.querySelector(".rating_nums")?.textContent),
            subject_id: m?.[1] || "",
          };
        })
        .filter((r) => r.title && r.subject_id);
      if (rows.length) works[heading] = rows;
    }
    const awards = cleanText(
      Array.from(document.querySelectorAll('#award-block, [data-category="awards"]'))
        .map((el) => el.innerText || "")
        .join("\\n"),
    ).slice(0, 1500);
    const photo = document.querySelector("#mainpic img, #content .avatar")?.src || null;
    return {
      ...base,
      is_celebrity_page: true,
      name,
      photo,
      bio: bio.slice(0, 2500),
      filmography: works,
      awards: awards || undefined,
    };
  }
  if (
    location.origin === "https://search.douban.com" ||
    (location.origin === "https://movie.douban.com" && location.pathname === "/subject_search")
  ) {
    const query = new URL(location.href).searchParams.get("search_text") || "";
    if (args.query !== undefined && query !== args.query)
      return {
        ...base,
        kind: "search",
        query,
        count: 0,
        results: [],
        results_ready: false,
      };
    const results = readSearchResults(Math.min(25, limit));
    const empty = /没有找到|没找到|No results/i.test(document.body.innerText || "");
    return {
      ...base,
      kind: "search",
      query,
      count: results.length,
      results,
      results_ready: results.length > 0 || empty,
    };
  }
  if (location.origin !== "https://movie.douban.com") return { ready: false };
  const subject = location.pathname.match(/^\\/subject\\/(\\d+)/)?.[1] || null;
  if (subject) {
    const comments = readComments(Math.min(20, limit));
    const reviews = readReviews(Math.min(10, limit));
    return {
      ...base,
      kind: "subject",
      subject_id: subject,
      view: readSubjectView(),
      comments,
      reviews,
      total_comments: document.body.innerHTML.match(/全部\\s*([\\d,]+)\\s*条/)?.[1] || null,
      tv: readTvInfo(limit),
    };
  }
  if (/^\\/celebrity\\/\\d+/.test(location.pathname))
    return { ...base, kind: "celebrity", view: readCelebrityView() };
  if (location.pathname === "/chart") {
    const results = readChartPage(Math.min(25, limit));
    return {
      ...base,
      kind: "chart",
      view: readSubjectView(),
      results,
      results_ready: results.length > 0,
    };
  }
  if (/^\\/(top250|doulist)(?:\\/|$)/.test(location.pathname)) {
    const results = readSubjectListRows(Math.min(25, limit), "#content");
    return {
      ...base,
      kind: location.pathname.startsWith("/top250") ? "top250" : "doulist",
      view: readSubjectView(),
      results,
      start: Number(new URL(location.href).searchParams.get("start")) || 0,
      title: cleanText(document.querySelector("#content h1")?.textContent),
      description: cleanText(
        document.querySelector(".doulist-note, #content .intro")?.textContent,
      ),
      results_ready:
        results.length > 0 ||
        /没有|暂无|No results/i.test(document.querySelector("#content")?.innerText || ""),
    };
  }
  return {
    ...base,
    kind: "home",
    view: readSubjectView(),
    now_playing: readNowPlaying(Math.min(30, limit)),
    weekly: readWeeklyChart(),
  };
}`;
      const page = await browser.eval(source, { tab: target.tabId, timeout: 15000 });
      if (page.tabId !== target.tabId) throw new Error("Browser returned another tab");
      state.result = page.result;
      return "success";
    },
  },
  result({ state }) {
    return state.result;
  },
};
