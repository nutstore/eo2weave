// Pure DOM readers shared by this package. Bash supplies them to browser eval; no module loader.
const ROW_DATE_RE = /\b\d{2}\/\d{2}\/\d{2}\b/;

function findConversationRows() {
  const anchors = Array.from(
    document.querySelectorAll('a[href^="/messages/"]'),
  );
  return anchors.filter((a) => {
    if (!a.offsetParent) return false;
    return ROW_DATE_RE.test(a.innerText || "");
  });
}

function findSearchInput() {
  return document.querySelector('input[placeholder="Search"]');
}

function readConversationMeta() {
  const match = (
    document.querySelector('meta[name="description"]')?.content || ""
  ).match(/^iMessage conversation with (.+?)\. (\d+) messages\.?$/);
  return match ? { name: match[1], messageCount: Number(match[2]) } : null;
}

const TIME_LABEL_RE =
  /^(\d{1,2}:\d{2}\s?(?:AM|PM)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*, [A-Z][a-z]{2} \d{1,2}, \d{4}(?: at [\d:]+\s?(?:AM|PM))?)$/;

function readVisibleBubbles() {
  const pane = document.querySelector(".messages-container");
  if (pane) {
    const bounds = pane.getBoundingClientRect();
    return Array.from(pane.querySelectorAll('[id^="message-"]')).flatMap(
      (row) => {
        const rect = row.getBoundingClientRect();
        if (
          rect.bottom <= bounds.top ||
          rect.top >= bounds.bottom ||
          !rect.height
        )
          return [];
        const text = row.querySelector(".break-words")?.innerText?.trim();
        if (!text) return [];
        const time =
          Array.from(row.querySelectorAll("div"))
            .map((el) => el.innerText.trim())
            .find((value) => TIME_LABEL_RE.test(value)) || null;
        return [{ text: text.slice(0, 4000), time }];
      },
    );
  }
  return [];
}

function currentSlug() {
  const match = location.pathname.match(/^\/messages\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function parseConversationRow(a) {
  const slug = (a.getAttribute("href") || "")
    .replace(/^\/messages\//, "")
    .split(/[?#]/)[0];
  if (!slug) return null;
  const lines = (a.innerText || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const dateLine = lines.find((l) => ROW_DATE_RE.test(l));
  if (!dateLine) return null;
  let name = lines[0];
  const nonDate = lines.filter((l) => l !== dateLine);
  const preview = nonDate.length > 1 ? nonDate[nonDate.length - 1] : "";
  return {
    slug,
    name,
    last_message: preview.slice(0, 200),
    date: (dateLine.match(ROW_DATE_RE) || [""])[0],
  };
}

function readConversationRows(limit) {
  const seen = new Set();
  const out = [];
  for (const a of findConversationRows()) {
    const info = parseConversationRow(a);
    if (!info || seen.has(info.slug)) continue;
    seen.add(info.slug);
    out.push(info);
    if (out.length >= limit) break;
  }
  return out;
}

function readSearchResultRows(limit) {
  const main = document.querySelector("main") || document.body;
  const rows = [];
  const seen = new Set();
  for (const btn of Array.from(main.querySelectorAll("button"))) {
    if (!btn.offsetParent) continue;
    const text = (btn.innerText || "").trim();
    if (!text || !ROW_DATE_RE.test(text)) continue;
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const dateLine = lines.find((l) => ROW_DATE_RE.test(l));
    if (!dateLine) continue;
    const idxDate = lines.indexOf(dateLine);
    const person = lines.slice(0, idxDate).join(" ").trim();
    const snippet = lines
      .slice(idxDate + 1)
      .join(" ")
      .trim();
    if (!person || !snippet) continue;
    const key = `${person}|${dateLine}|${snippet.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      index: rows.length,
      person,
      date: (dateLine.match(ROW_DATE_RE) || [""])[0],
      snippet: snippet.slice(0, 300),
      slug: slugFromRowImage(btn) || "",
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function slugFromRowImage(row) {
  const img = row.querySelector('img[src*="people-thumbnails"]');
  if (!img) return null;
  const src = img.getAttribute("src") || "";
  const qm = src.match(
    /people-thumbnails(?:%2F|\/)([^&]+?)(?:\.\w{2,5})?(?:$|&)/i,
  );
  if (qm) {
    try {
      return decodeURIComponent(qm[1]);
    } catch {
      return qm[1];
    }
  }
  return null;
}
