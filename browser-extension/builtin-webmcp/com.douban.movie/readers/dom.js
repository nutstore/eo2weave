// Pure DOM readers shared by this package. Bash supplies them to browser eval; no module loader.
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function readSubjectListRows(limit, rootSelector) {
  const root = rootSelector ? document.querySelector(rootSelector) : document;
  const out = [];
  const seen = new Set();
  const anchors = Array.from(
    (root || document).querySelectorAll('a[href*="subject/"]'),
  );
  for (const a of anchors) {
    const m = a.getAttribute("href")?.match(/subject\/(\d+)/);
    const id = m?.[1];
    const rawTitle = cleanText(a.textContent);
    if (!id || !rawTitle || seen.has(id)) continue;
    const title = rawTitle.replace(/\s*\(\d{4}\)\s*$/, "").trim() || rawTitle;
    const container =
      a.closest("table.item, .item, li, .ob, div") || a.parentElement;
    const rating = cleanText(
      container?.querySelector(".rating_nums")?.textContent,
    );
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
