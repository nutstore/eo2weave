// Pure DOM readers shared by this package. Bash supplies them to browser eval; no module loader.
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function readSearchResults(limit) {
  if (
    /搜索访问太频繁|搜索访问过于频繁|Too many requests/i.test(
      document.body?.innerText || "",
    )
  )
    throw new Error("Douban search is rate-limited by the site");
  const out = [];
  const anchors = Array.from(
    document.querySelectorAll('a.title-text[href*="/subject/"]'),
  );
  for (const a of anchors) {
    const title = cleanText(a.textContent).replace(
      /\s*\(\d{4}\)\s*$/,
      (m) => m,
    );
    if (!title) continue;
    const moreurl = a.getAttribute("data-moreurl") || "";
    const id =
      moreurl.match(/subject_id:'(\d+)'/)?.[1] ||
      a.getAttribute("href")?.match(/subject\/(\d+)/)?.[1] ||
      null;
    const item =
      a.closest('div[class*="item"], .result, [class*="subject"]') ||
      a.parentElement?.parentElement ||
      a;
    const ratingNum = item?.querySelector(".rating_nums")?.textContent?.trim();
    const rating = ratingNum
      ? `${ratingNum}（${cleanText(item?.querySelector(".rating")?.textContent)
          .replace(/^[\d.]+/, "")
          .replace(/[()（）]/g, "")}）`
      : "暂无评分";
    const meta = cleanText(
      item?.querySelector('.subject-cast, .detail, [class*="cat"]')
        ?.textContent,
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
