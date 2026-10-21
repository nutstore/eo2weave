export default {
  inputSchema: {
    type: "object",
    properties: {
      after: {
        type: "string",
        description: "Only emails on/after this date (YYYY-MM-DD)",
      },
      before: {
        type: "string",
        description: "Only emails on/before this date (YYYY-MM-DD)",
      },
      limit: {
        type: "number",
        description: "Max rows to return (default 10, max 25)",
        minimum: 1,
        maximum: 25,
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
            `() => (location.origin === 'https://jmail.world' && !location.pathname.startsWith('/messages')) && document.readyState !== 'loading' && !!document.body`.replace(
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
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
async function waitFor(fn, { timeoutMs = 8000, pollMs = 120 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const v = fn();
        if (v != null)
            return v;
        if (Date.now() > deadline)
            throw new Error('Timed out waiting for a page element to appear');
        await sleep(pollMs);
    }
}

const args = __INPUT__;
const after = typeof args.after === 'string' ? args.after.trim() : '';
const before = typeof args.before === 'string' ? args.before.trim() : '';
const limit = Math.max(1, Math.min(25, Number(args.limit) || 10));
if (!after && !before)
    throw new Error('Provide at least one of after / before (YYYY-MM-DD)');
const DATE_FMT = /^\\d{4}-\\d{2}-\\d{2}$/;
if (after && !DATE_FMT.test(after))
    throw new Error('after must be YYYY-MM-DD');
if (before && !DATE_FMT.test(before))
    throw new Error('before must be YYYY-MM-DD');
const trigger = await waitFor(() => document.querySelector('button[aria-label="Filter by date range"]'), { timeoutMs: 8000 });
trigger.click();
let panel = await waitFor(() => document.querySelector('.date-filter-dropdown[data-state="open"]'), { timeoutMs: 5000 });
if (trigger.classList.contains('date-filter-active') || location.search.includes('after=') || location.search.includes('before=')) {
    const clear = panel.querySelector('.date-filter-clear');
    if (clear) {
        clear.click();
        await sleep(500);
        trigger.click();
        panel = await waitFor(() => document.querySelector('.date-filter-dropdown[data-state="open"]'), { timeoutMs: 5000 });
    }
}
const fillDate = (label, value) => {
    const fields = Array.from(panel.querySelectorAll('.date-filter-field'));
    const field = fields.find((f) => (f.innerText || '').toLowerCase().includes(label));
    const input = field?.querySelector('input[type="date"]');
    if (!input)
        throw new Error(\`"\${label}" date input not found in the filter panel\`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter)
        setter.call(input, value);
    else
        input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
};
if (after)
    fillDate('after', after);
if (before)
    fillDate('before', before);
const apply = panel.querySelector('.date-filter-apply');
if (!apply)
    throw new Error('Apply button not found in the filter panel');
apply.click();
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const parseRowDate = (s) => {
    const m = s.trim().match(/^([A-Za-z]{3}) (\\d{1,2}), (\\d{4})$/);
    if (!m)
        return NaN;
    const mo = MONTHS.indexOf(m[1].toLowerCase());
    return mo < 0 ? NaN : new Date(Number(m[3]), mo, Number(m[2])).getTime();
};
const afterTs = after ? new Date(after + 'T00:00:00').getTime() : -Infinity;
const beforeTs = before ? new Date(before + 'T23:59:59').getTime() : Infinity;
await waitFor(() => {
    const hasParam = after
        ? location.search.includes(\`after=\${after}\`)
        : location.search.includes(\`before=\${before}\`);
    if (!hasParam)
        return null;
    const rows = readRows(3);
    if (rows.length === 0)
        return readTotalCount() === '0' || /no emails found|no results found/i.test(document.querySelector('main')?.innerText || '') ? {} : null;
    const first = parseRowDate(rows[0].date);
    return Number.isFinite(first) && first >= afterTs && first <= beforeTs ? {} : null;
}, { timeoutMs: 15000 });
const rows = readRows(limit);
return {
    url: location.pathname + location.search,
    page_title: document.title,
    total: readTotalCount(),
    count: rows.length,
    results: rows,
    note: rows.length === 0
        ? 'No emails in this date range. Call go_home or filter_by_date with a wider range.'
        : undefined,
};
}`.replace("__INPUT__", () => JSON.stringify(input));
          const output = await tools.bash({
            command: `reader=$(cat '${packageRoot}readers/dom.js') || exit 1
page_source='${source.replace(/'/g, "'\"'\"'")}'
browser eval --tab=${target.tabId} --timeout=30000 "async () => {
$reader
return await ($page_source)();
}"`,
            timeout: 35000,
          });
          if (output.truncated) throw new Error("Browser output was truncated");
          if (output.exitCode !== 0) throw new Error(output.stderr);
          const page = JSON.parse(output.stdout);
          if (page.tabId !== target.tabId)
            throw new Error("Browser returned another tab");
          const value = page.result;
          if (value && typeof value.error === "string")
            throw new Error(value.error);

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
