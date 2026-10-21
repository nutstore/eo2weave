// Pure DOM readers shared by this package. Bash supplies them to browser eval; no module loader.
const ICON_NOISE = new Set([
  "arrow_back",
  "chevron_left",
  "chevron_right",
  "first_page",
  "last_page",
  "arrow_drop_down",
  "arrow_upward",
  "star_border",
  "star",
  "mystery",
  "link",
  "reply",
  "forward",
  "inbox",
  "send",
  "attach_file",
  "calendar_today",
  "edit",
  "question_answer",
  "handshake",
  "shield",
  "bakery_dining",
  "north_east",
  "folder_open",
  "date_range",
  "menu",
  "search",
  "person",
  "people",
  "close",
  "feedback",
  "help_outline",
  "settings",
  "visibility_off",
  "gavel",
  "mail",
  "markunread",
  "drafts",
  "schedule",
  "label",
  "delete",
  "share",
  "add",
  "open_in_full",
  "restart_alt",
  "view_sidebar",
  "science",
  "tune",
  "subdirectory_arrow_right",
  "verified",
  "local_offer",
  "unfold_more",
]);

function filterIconNoise(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !ICON_NOISE.has(line))
    .join("\n");
}

const DATE_RE = /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/;

function findRowElements() {
  const main = document.querySelector("main");
  if (!main) return [];
  const visible = Array.from(
    main.querySelectorAll(".email-row[data-doc-id]"),
  ).filter((row) => row.getClientRects().length);
  if (visible.length) return visible;
  const rows = [];
  for (const checkbox of main.querySelectorAll('input[type="checkbox"]')) {
    let row = checkbox;
    while (
      row.parentElement !== main &&
      main.contains(row.parentElement) &&
      row.parentElement.querySelectorAll('input[type="checkbox"]').length === 1
    )
      row = row.parentElement;
    if (
      row !== checkbox &&
      !rows.includes(row) &&
      Array.from(row.querySelectorAll("div, span, time")).some((el) =>
        DATE_RE.test((el.innerText || "").trim()),
      )
    )
      rows.push(row);
  }
  return rows;
}

function parseRow(row, index) {
  const dateNode = row.querySelector(".email-date");
  const senderNode = row.querySelector(".sender-name");
  const subjectNode = row.querySelector(".subject, .email-subject");
  if (dateNode && (senderNode || subjectNode)) {
    const subjectCopy = subjectNode?.cloneNode(true);
    subjectCopy
      ?.querySelectorAll(".source-badge")
      .forEach((badge) => badge.remove());
    const sender = (senderNode?.innerText || "").replace(/\s*\d+$/, "").trim();
    const subject = (subjectCopy?.textContent || "").trim().split("\n")[0];
    const preview = (
      row.querySelector(".preview, .email-preview")?.innerText || ""
    )
      .trim()
      .replace(/^-\s*/, "")
      .slice(0, 300);
    return sender || subject
      ? { index, sender, subject, date: dateNode.innerText.trim(), preview }
      : null;
  }
  let dateDiv = null;
  for (const el of row.querySelectorAll("div")) {
    if (
      DATE_RE.test((el.innerText || "").trim()) &&
      (!dateDiv || el.contains(dateDiv) || dateDiv.contains(el))
    )
      dateDiv = el;
  }
  if (!dateDiv?.parentElement) return null;
  let sender = "",
    subject = "",
    preview = "";
  const date = (dateDiv.innerText || "").trim();
  for (const el of dateDiv.parentElement.children) {
    if (el === dateDiv || el.querySelector('input[type="checkbox"], button'))
      continue;
    const text = (el.innerText || "").trim();
    if (!text) continue;
    const kids = Array.from(el.children);
    const previewKid = kids.find((child) =>
      (child.innerText || "").trim().startsWith("-"),
    );
    if (previewKid && !subject) {
      const candidates = kids
        .filter((child) => child !== previewKid)
        .map((child) => (child.innerText || "").trim().split("\n")[0])
        .filter(
          (text) => text && !/^DOJ \d+$/.test(text) && text !== "(no subject)",
        )
        .sort((a, b) => b.length - a.length);
      subject = candidates[0] || "(no subject)";
      preview = (previewKid.innerText || "")
        .trim()
        .replace(/^-\s*/, "")
        .slice(0, 300);
    } else if (!sender) sender = text.replace(/\s*\d+$/, "").trim();
  }
  return subject || sender ? { index, sender, subject, date, preview } : null;
}

function readRows(limit) {
  const output = [],
    rows = findRowElements();
  for (let i = 0; i < rows.length && output.length < limit; i++) {
    const row = parseRow(rows[i], i);
    if (row) output.push(row);
  }
  return output;
}

function readTotalCount() {
  return (
    document
      .querySelector("main")
      ?.innerText.match(/\d+\s*[-–—]\s*\d+\s+of\s+(\d+)/)?.[1] || null
  );
}

function readThreadView() {
  const main = document.querySelector("main") || document.body;
  const idMatch = location.pathname.match(/^\/thread\/([^?/]+)/);
  return {
    url: location.pathname + location.search,
    doc_id: idMatch ? decodeURIComponent(idMatch[1]) : null,
    page_title: document.title,
    text: filterIconNoise(main.innerText || "").slice(0, 12000),
    structured: readJsonLd(),
  };
}

function readJsonLd() {
  try {
    const data = JSON.parse(
      document.querySelector('script[type="application/ld+json"]')
        ?.textContent || "null",
    );
    const article = (
      Array.isArray(data?.["@graph"]) ? data["@graph"] : [data]
    ).find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item["@type"] === "Article" || item.headline),
    );
    if (!article) return null;
    return {
      headline:
        typeof article.headline === "string" ? article.headline : undefined,
      author:
        typeof article.author === "string"
          ? article.author
          : article.author?.name || undefined,
      datePublished: article.datePublished || undefined,
      description: article.description || undefined,
    };
  } catch {
    return null;
  }
}
