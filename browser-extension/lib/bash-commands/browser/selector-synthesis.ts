// Adapted from agentic-sandbox browser automation.
import type { ElementLocator } from "./element-locator"
// Legacy kinds remain readable in persisted snapshots. New results are CSS only.
export type SelectorLocatorKind = "link_text" | "id" | "name" | "css"

export type SelectorLocator = ElementLocator

/** Single runtime implementation shared by snapshots, finder and picker.
 * Scores describe heuristic risk, not a guarantee across page revisions.
 * Shadow DOM locators include the CSS host path needed to reach their root.
 */
export function browserSelectorSynthesisSource(): string {
    return String.raw`
const synthesizeElementLocators = (() => {
  const MAX_QUERIES = 256; // Per query root, including the reserved fallback.
  const MAX_SHADOW_DEPTH = 8;
  const MAX_ANCESTORS = 12;
  const MAX_FRAGMENTS = 40;
  const attributes = ["data-testid", "data-test", "data-qa", "id", "name", "aria-label", "placeholder", "title", "alt", "role", "type"];
  const dynamic = (value) => /(?:[a-f0-9]{8,}|\d{5,}|^:r|^(?:ember|react|radix|headlessui)[-_:]|(?:^|[-_])(?:css|sc)[-_][a-z0-9]{5,})/i.test(value);
  const stateClass = (value) => /^(?:(?:is|has)-)?(?:active|selected|disabled|focused|hover|open|closed|loading|checked)$/i.test(value);
  const quote = (value) => '"' + value.replace(/[\0-\x1f\x7f"\\]/g, (char) => '\\' + char.charCodeAt(0).toString(16) + ' ') + '"';
  const compare = (a, b) => a.score - b.score || a.query.length - b.query.length || a.query.localeCompare(b.query);
  const fragments = (el) => {
    const tag = /^(f\d+)?e\d+$/.test(el.localName) ? ':is(' + el.localName + ')' : el.localName;
    const result = [];
    const attrs = [];
    for (const name of attributes) {
      const value = el.getAttribute(name);
      if (!value || value.length > 256) continue;
      const risk = dynamic(value) ? 400 : name.startsWith("data-") ? 0 : name === "id" ? 10 : 30;
      const query = '[' + name + '=' + quote(value) + ']';
      attrs.push({ query, score: risk, strategy: "attribute:" + name });
      result.push({ query, score: risk, strategy: "attribute:" + name });
      result.push({ query: tag + query, score: risk + 2, strategy: "tag_attribute:" + name });
    }
    // Bound combinations and prioritize low-risk attributes before truncating.
    attrs.sort(compare);
    for (let i = 0; i < Math.min(attrs.length, 6); i++) {
      for (let j = i + 1; j < Math.min(attrs.length, 6); j++) {
        result.push({ query: attrs[i].query + attrs[j].query, score: Math.max(attrs[i].score, attrs[j].score) + 8, strategy: "attribute_pair" });
      }
    }
    const classes = Array.from(el.classList).filter((value) => value.length <= 128)
      .map((value) => ({ query: '[class~=' + quote(value) + ']', score: dynamic(value) || stateClass(value) ? 450 : 100, strategy: "class" }))
      .sort(compare).slice(0, 6);
    for (let i = 0; i < classes.length; i++) {
      result.push(classes[i]);
      result.push({ ...classes[i], query: tag + classes[i].query, score: classes[i].score + 2 });
      for (let j = i + 1; j < classes.length; j++) {
        result.push({ query: classes[i].query + classes[j].query, score: Math.max(classes[i].score, classes[j].score) + 15, strategy: "class_pair" });
      }
    }
    result.push({ query: tag, score: 200, strategy: "tag" });
    return result.sort(compare).slice(0, MAX_FRAGMENTS);
  };
  const segment = (el) => {
    let index = 1;
    for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      if (sibling.localName === el.localName) index++;
    }
    return el.localName + ':nth-of-type(' + index + ')';
  };
  const synthesize = (el, shadowDepth = 0) => {
    if (shadowDepth > MAX_SHADOW_DEPTH) return [];
    if (!(el instanceof Element) || !el.isConnected || el.ownerDocument !== document || window !== window.top) return [];
    const selectorRoot = el.getRootNode();
    const cache = new Map();
    let queries = 0;
    const verify = (query, target, reserve = false) => {
      if (cache.has(query)) return cache.get(query) === target;
      if (queries >= MAX_QUERIES - (reserve ? 0 : 1)) return false;
      queries++;
      try {
        const matches = selectorRoot.querySelectorAll(query);
        const match = matches.length === 1 ? matches[0] : null;
        cache.set(query, match);
        return match === target;
      } catch {
        cache.set(query, null);
        return false;
      }
    };
    const candidates = new Map();
    const add = (candidate) => {
      const previous = candidates.get(candidate.query);
      if (!previous || compare(candidate, previous) < 0) candidates.set(candidate.query, candidate);
    };
    const own = fragments(el);
    own.forEach(add);
    let ancestor = el.parentElement;
    const relative = [segment(el)];
    for (let depth = 1; ancestor && depth <= MAX_ANCESTORS; depth++, ancestor = ancestor.parentElement) {
      // Reserve an equal exploration opportunity for every ancestor depth.
      const anchors = fragments(ancestor).slice(0, 4);
      for (const anchor of anchors) {
        if (!verify(anchor.query, ancestor)) continue;
        for (const target of own) {
          add({ query: anchor.query + ' ' + target.query, score: Math.max(anchor.score, target.score) + 20 + depth, strategy: "anchored_descendant:" + anchor.strategy + ":" + target.strategy });
        }
        add({ query: anchor.query + ' > ' + relative.join(' > '), score: 700 + depth, strategy: "anchored_path" });
      }
      relative.unshift(segment(ancestor));
    }
    const locators = [];
    for (const candidate of Array.from(candidates.values()).sort(compare)) {
      if (!verify(candidate.query, el)) continue;
      locators.push({ kind: "css", query: candidate.query, verification: "live_document_unique", stability: candidate.score < 30 ? "high" : candidate.score < 200 ? "medium" : "low", score: candidate.score, strategy: candidate.strategy });
      if (locators.length === 5) break;
    }
    if (!locators.length) {
      const path = [];
      for (let node = el; node; node = node.parentElement) path.unshift(segment(node));
      const query = path.join(' > ');
      if (verify(query, el, true)) locators.push({ kind: "css", query, verification: "live_document_unique", stability: "low", score: 1000 + path.length, strategy: "full_path" });
    }
    if (selectorRoot === document) return locators;
    const host = selectorRoot.host;
    if (!(host instanceof Element) || host.shadowRoot !== selectorRoot) return [];
    const hostLocator = synthesize(host, shadowDepth + 1)[0];
    if (!hostLocator) return [];
    return locators.map((locator) => ({
      ...locator,
      verification: "live_shadow_root_unique",
      shadowHosts: [...(hostLocator.shadowHosts || []), hostLocator.query],
      stability: locator.stability === "low" || hostLocator.stability === "low" ? "low"
        : locator.stability === "medium" || hostLocator.stability === "medium" ? "medium" : "high",
    }));
  };
  return synthesize;
})();
`
}
