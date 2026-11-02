// ============================================================
// Page Action Runner Content Script (MAIN world)
//
// Injects `window.__cwPageAction` into the upstream page's JS context.
// Exposes page-interaction primitives (snapshot / text / find / click /
// fill / type / scroll) that the CreatorWeave agent invokes through the
// `__agentWeb.runPageAction(tabId, action)` bridge.
//
// Design notes:
// - Runs in MAIN world (world: 'MAIN') because it needs full DOM access
//   in the page's JS context. It does NOT depend on any page framework
//   (Vue/React) — all lookups are plain DOM.
// - click/fill/type simulate events with `isTrusted=false`. This works on
//   the overwhelming majority of sites but is BLOCKED by pages that
//   explicitly reject synthetic events (anti-bot / login / payment).
//   For those, a CDP-based (chrome.debugger) path is required (Phase 1).
// - React/Vue controlled components: fill() uses the native setter trick
//   (HTMLInputElement.prototype.value setter) so React's onChange fires.
// - Locator model is the "strict intersection" philosophy from
//   browser-agent-wxt: every provided field MUST match, no fallback,
//   ambiguity => fail and return candidates.
// ============================================================

import { synthesizeElementLocators } from '../lib/page-action-synthesis-source'
import { isCspCompileRejection } from '../lib/bash-commands/browser/csp-rejection'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  world: 'MAIN',

  main() {
    // Guard against double-injection (HMR / re-injection).
    if ((window as any).__cwPageAction?.ready) return

    // --------------------------------------------------------------
    // Types
    // --------------------------------------------------------------
    type Locator = {
      element_id?: string
      xpath?: string
      selector?: string
      text?: string
      role?: string
      name?: string
      near_text?: string
      ancestor_text?: string
      tag_name?: string
      input_type?: string
      visible_only?: boolean
    }

    type Action =
      | { type: 'snapshot'; maxNodes?: number }
      | { type: 'text_content'; locator?: Locator; maxLength?: number }
      | { type: 'find_elements'; locator: Locator; limit?: number }
      | { type: 'synthesize_locators'; locator: Locator; limit?: number }
      | { type: 'click'; locator: Locator }
      | { type: 'fill'; locator: Locator; value: string; clearFirst?: boolean }
      | { type: 'type'; locator: Locator; text: string }
      | { type: 'scroll'; locator?: Locator; x?: number; y?: number; behavior?: ScrollBehavior }
      | { type: 'evaluate'; expression: string }

    type ElementInfo = {
      elementId: string
      tagName: string
      role: string | null
      name: string | null
      text: string | null
      visible: boolean
      rect: { x: number; y: number; width: number; height: number }
      attributes: Record<string, string>
    }

    // --------------------------------------------------------------
    // Element ID assignment (stable within a snapshot)
    // --------------------------------------------------------------
    const ID_ATTR = 'data-cw-eid'
    let _eidCounter = 0

    function ensureElementId(el: Element): string {
      let id = el.getAttribute(ID_ATTR)
      if (!id) {
        id = 'cw_' + (++_eidCounter).toString(36)
        try {
          el.setAttribute(ID_ATTR, id)
        } catch {
          // setAttribute can throw on SVG/MathML exotic elements; fall back
          // to a WeakMap-backed id so we still have a stable handle.
          id = fallbackIdFor(el)
        }
      }
      return id
    }

    const _fallbackIds = new WeakMap<Element, string>()
    function fallbackIdFor(el: Element): string {
      let id = _fallbackIds.get(el)
      if (!id) {
        id = 'cw_' + (++_eidCounter).toString(36)
        _fallbackIds.set(el, id)
      }
      return id
    }

    function getElementById(id: string): Element | null {
      // Prefer real DOM lookup (data attr) — fast and works across snapshots.
      const found = document.querySelector(`[${ID_ATTR}="${cssEscape(id)}"]`)
      if (found) return found
      // WeakMap fallback isn't queryable by id, so element_id lookups for
      // exotic elements that failed setAttribute will miss here. That is an
      // acceptable edge case (rare).
      return null
    }

    function cssEscape(s: string): string {
      if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s)
      return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c)
    }

    // --------------------------------------------------------------
    // Visibility & geometry
    // --------------------------------------------------------------
    function isVisible(el: Element): boolean {
      const html = el as HTMLElement
      if (typeof html.getClientRects === 'function') {
        const rects = html.getClientRects()
        if (rects.length === 0) return false
      }
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden') return false
      const rect = html.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return false
      return true
    }

    function elementInfo(el: Element): ElementInfo {
      const html = el as HTMLElement
      const rect = html.getBoundingClientRect()
      const role = el.getAttribute('role')
      const name = el.getAttribute('name')
      const text = (el.textContent || '').trim().slice(0, 200) || null
      const attrs: Record<string, string> = {}
      for (const attr of Array.from(el.attributes)) {
        attrs[attr.name] = attr.value
      }
      return {
        elementId: ensureElementId(el),
        tagName: el.tagName.toLowerCase(),
        role,
        name,
        text,
        visible: isVisible(el),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        attributes: attrs,
      }
    }

    // --------------------------------------------------------------
    // Candidate collection (used by locator matching)
    // --------------------------------------------------------------
    // We gather candidates from a few cheap strategies, then apply the
    // strict-intersection filter. Keeping the candidate pool bounded is
    // critical for performance on large DOMs.
    function gatherCandidates(loc: Locator): Element[] {
      const sets: Set<Element>[] = []

      // Strategy 1: element_id (exact, preferred)
      if (loc.element_id) {
        const el = getElementById(loc.element_id)
        if (el) sets.push(new Set([el]))
      }

      // Strategy 2: CSS selector
      if (loc.selector) {
        try {
          const els = Array.from(document.querySelectorAll(loc.selector))
          if (els.length) sets.push(new Set(els))
        } catch {
          // invalid selector → treated as no candidates from this strategy
        }
      }

      // Strategy 3: xpath
      if (loc.xpath) {
        try {
          const result = document.evaluate(
            loc.xpath,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          )
          const els: Element[] = []
          for (let i = 0; i < result.snapshotLength; i++) {
            const node = result.snapshotItem(i)
            if (node && node.nodeType === Node.ELEMENT_NODE) els.push(node as Element)
          }
          if (els.length) sets.push(new Set(els))
        } catch {
          // invalid xpath
        }
      }

      // Strategy 4: tag_name (cheap, bounded by common tag assumption)
      if (loc.tag_name) {
        try {
          const els = Array.from(document.getElementsByTagName(loc.tag_name))
          if (els.length) sets.push(new Set(els))
        } catch {
          // invalid tag
        }
      }

      // Strategy 5: role / name attributes (via querySelectorAll)
      const attrClauses: string[] = []
      if (loc.role) attrClauses.push(`[role="${cssEscape(loc.role)}"]`)
      if (loc.name) attrClauses.push(`[name="${cssEscape(loc.name)}"]`)
      if (loc.input_type) attrClauses.push(`[type="${cssEscape(loc.input_type)}"]`)
      if (attrClauses.length) {
        try {
          const els = Array.from(document.querySelectorAll(attrClauses.join('')))
          if (els.length) sets.push(new Set(els))
        } catch {
          // ignore
        }
      }

      if (sets.length === 0) return []

      // Intersect all sets: a candidate must match EVERY provided strategy.
      // This is the strict-intersection contract.
      const primary = sets[0]!
      const result: Element[] = []
      for (const el of primary) {
        if (sets.every((s) => s.has(el))) result.push(el)
      }
      return result
    }

    // --------------------------------------------------------------
    // Field-level matchers (applied AFTER candidate gathering, as a
    // finer filter for text / visibility / ancestor conditions)
    // --------------------------------------------------------------
    function matchesFieldConditions(el: Element, loc: Locator): boolean {
      if (loc.text) {
        const t = (el.textContent || '').trim()
        if (!t.includes(loc.text)) return false
      }
      if (loc.near_text || loc.ancestor_text) {
        const nearby = findNearestText(el, loc)
        if (loc.near_text && !nearby.hasNear) return false
        if (loc.ancestor_text && !nearby.hasAncestor) return false
      }
      if (loc.visible_only === true && !isVisible(el)) return false
      return true
    }

    function findNearestText(el: Element, loc: Locator): { hasNear: boolean; hasAncestor: boolean } {
      let hasNear = false
      let hasAncestor = false
      if (loc.near_text) {
        const rect = (el as HTMLElement).getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        // Look at siblings within 2 hops and ancestors' immediate children
        const probeRange = 300
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          const t = (node.textContent || '').trim()
          if (!t.includes(loc.near_text)) continue
          const parent = node.parentElement
          if (!parent) continue
          const pr = parent.getBoundingClientRect()
          if (
            Math.abs(pr.left - cx) < probeRange &&
            Math.abs(pr.top - cy) < probeRange
          ) {
            hasNear = true
            break
          }
        }
      }
      if (loc.ancestor_text) {
        let cur: Element | null = el
        while (cur) {
          if ((cur.textContent || '').includes(loc.ancestor_text)) {
            hasAncestor = true
            break
          }
          cur = cur.parentElement
        }
      }
      return { hasNear, hasAncestor }
    }

    function resolveLocator(loc: Locator, limit?: number): Element[] {
      const candidates = gatherCandidates(loc)
      const matched = candidates.filter((el) => matchesFieldConditions(el, loc))
      if (typeof limit === 'number' && limit > 0) return matched.slice(0, limit)
      return matched
    }

    // --------------------------------------------------------------
    // Locator synthesis (browser-side, direct function call)
    // --------------------------------------------------------------
    // `synthesizeElementLocators(el)` is imported directly from
    // lib/page-action-synthesis-source. It returns a ranked list of
    // {kind, query, verification, stability, score, strategy} for the
    // element. This is the browser-agent-wxt scoring table ported
    // verbatim — do not re-tune casually.
    // NOTE: it used to be eval'd lazily via `new Function(source)`; that
    // broke on strict-CSP pages (no 'unsafe-eval'). A plain imported
    // function call is not restricted by page CSP.

    function synthesizeLocatorsForMatches(matches: Element[], limit?: number): any[] {
      const out: any[] = []
      for (const el of matches) {
        const locators = synthesizeElementLocators(el)
        out.push({ elementId: ensureElementId(el), locators })
        if (typeof limit === 'number' && limit > 0 && out.length >= limit) break
      }
      return out
    }

    // --------------------------------------------------------------
    // React/Vue controlled input trick
    // --------------------------------------------------------------
    // React tracks the value via a hidden descriptor; setting el.value
    // directly doesn't trigger React's onChange. We use the native setter
    // on the prototype to dispatch a proper input event.
    function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
      if (setter) {
        setter.call(el, value)
      } else {
        // Fallback: direct assignment (works for non-framework pages)
        el.value = value
      }
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }

    // --------------------------------------------------------------
    // ContentEditable / ProseMirror / Remirror support
    // --------------------------------------------------------------
    // Rich text editors (ProseMirror, Remirror, Quill, TinyMCE) can't be
    // filled with the native setter trick — they manage their own document
    // model via transactions. We try several strategies in order:
    //   1. ProseMirror view (via pmViewDesc) → dispatch transaction
    //   2. document.execCommand('insertText') after select-all
    //   3. innerHTML fallback (last resort)
    function fillContentEditable(
      el: HTMLElement,
      value: string,
      clearFirst: boolean,
    ): { ok: boolean; error?: string } {
      el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
      try { el.focus({ preventScroll: true }) } catch {}

      // Strategy 1: ProseMirror / Remirror via pmViewDesc.
      const pmResult = tryProseMirrorFill(el, value, clearFirst)
      if (pmResult !== null) return pmResult

      // Strategy 2: execCommand fallback.
      if (clearFirst) {
        selectAllAndDelete(el)
      }
      try {
        document.execCommand('insertText', false, value)
        return { ok: true }
      } catch {
        // fall through
      }

      // Strategy 3: innerHTML fallback (last resort)
      if (clearFirst) {
        el.innerHTML = ''
      }
      const lines = value.split('\n')
      if (lines.length === 1) {
        el.appendChild(document.createTextNode(value))
      } else {
        for (const line of lines) {
          const p = document.createElement('p')
          p.textContent = line
          el.appendChild(p)
        }
      }
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }))
      return { ok: true }
    }

    /**
     * Try to fill via ProseMirror's EditorView, obtained from pmViewDesc.
     * Returns null if not a ProseMirror node (so caller can fall back).
     */
    function tryProseMirrorFill(
      el: HTMLElement,
      value: string,
      clearFirst: boolean,
    ): { ok: boolean; error?: string } | null {
      let node: any = el
      let view: any = null
      for (let i = 0; i < 20 && node; i++) {
        const desc = node.pmViewDesc
        if (desc?.view) {
          view = desc.view
          break
        }
        node = node.parentElement || node.parentNode
      }
      if (!view) {
        const directView = (el as any).view || (el.closest('.remirror-editor') as any)?.view
        if (directView) view = directView
      }
      if (!view || !view.state || !view.dispatch) return null

      try {
        const lines = value.split('\n')
        const { state } = view
        const schema = state.schema
        const paragraphType = schema.nodes.paragraph || schema.nodes.p
        if (!paragraphType) return null

        const nodes = lines.map((line) =>
          paragraphType.create(null, line ? schema.text(line) : []),
        )

        const tr = clearFirst
          ? state.tr.replaceWith(0, state.doc.content.size, nodes)
          : state.tr.insert(state.doc.content.size, nodes)

        view.dispatch(tr)
        view.focus()
        return { ok: true }
      } catch (err) {
        return {
          ok: false,
          error: `ProseMirror fill failed: ${(err as Error).message}`,
        }
      }
    }

    function selectAllAndDelete(el: HTMLElement): void {
      const sel = window.getSelection()
      if (!sel) return
      const range = document.createRange()
      range.selectNodeContents(el)
      sel.removeAllRanges()
      sel.addRange(range)
      try { document.execCommand('delete', false) } catch {}
    }

    // --------------------------------------------------------------
    // Snapshot (pruned accessibility/DOM tree as text)
    // --------------------------------------------------------------
    function snapshot(maxNodes = 2000): { tree_text: string; nodeCount: number; truncated: boolean } {
      const lines: string[] = []
      let count = 0
      let truncated = false

      const SKIPPABLE_TAGS = new Set([
        'script', 'style', 'noscript', 'template', 'svg', 'path', 'head', 'link', 'meta',
      ])
      const INTERACTIVE_TAGS = new Set([
        'a', 'button', 'input', 'textarea', 'select', 'summary',
      ])

      function walk(el: Element, depth: number) {
        if (count >= maxNodes) {
          truncated = true
          return
        }
        const tag = el.tagName.toLowerCase()
        if (SKIPPABLE_TAGS.has(tag)) return

        const visible = isVisible(el)
        const interactive = INTERACTIVE_TAGS.has(tag) || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link'

        // Skip non-visible non-interactive wrappers to keep the tree compact,
        // but still descend into them (their children may be visible).
        if (visible || interactive) {
          const id = ensureElementId(el)
          const role = el.getAttribute('role')
          const name = el.getAttribute('name')
          const type = el.getAttribute('type')
          const placeholder = el.getAttribute('placeholder')
          const ariaLabel = el.getAttribute('aria-label')
          const href = el.getAttribute('href')
          const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)

          const parts: string[] = [`[${id}]`, tag]
          if (role) parts.push(`role="${role}"`)
          if (name) parts.push(`name="${name}"`)
          if (type) parts.push(`type="${type}"`)
          if (placeholder) parts.push(`placeholder="${placeholder}"`)
          if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)
          if (href && tag === 'a') parts.push(`href="${href.slice(0, 60)}"`)
          if (text) parts.push(`:: "${text}"`)
          lines.push('  '.repeat(depth) + parts.join(' '))
          count++
        }

        for (const child of Array.from(el.children)) {
          walk(child, depth + 1)
        }
      }

      walk(document.body, 0)

      return { tree_text: lines.join('\n'), nodeCount: count, truncated }
    }

    // --------------------------------------------------------------
    // Text content extraction
    // --------------------------------------------------------------
    function textContent(el: Element | null, maxLength = 10000): string {
      const raw = el
        ? (el.textContent || '').trim()
        : (document.body.textContent || '').trim()
      const collapsed = raw.replace(/\s+/g, ' ')
      if (collapsed.length <= maxLength) return collapsed
      return collapsed.slice(0, maxLength) + `\n...[truncated, ${collapsed.length - maxLength} more chars]`
    }

    // --------------------------------------------------------------
    // click / fill / type / scroll
    // --------------------------------------------------------------
    function click(el: Element): { ok: boolean; error?: string } {
      try {
        const html = el as HTMLElement
        html.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
        // Realistic click sequence: mouseover → mousedown → focus → mouseup → click
        const opts: MouseEventInit = { bubbles: true, cancelable: true, view: window }
        html.dispatchEvent(new MouseEvent('mouseover', opts))
        html.dispatchEvent(new MouseEvent('mousedown', opts))
        try { html.focus({ preventScroll: true }) } catch {}
        html.dispatchEvent(new MouseEvent('mouseup', opts))
        html.dispatchEvent(new MouseEvent('click', opts))
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }

    function fill(el: Element, value: string, clearFirst = true): { ok: boolean; error?: string } {
      try {
        // Check if this is a contenteditable element (ProseMirror, Remirror, etc.)
        const html = el as HTMLElement
        if (html.isContentEditable || html.getAttribute('contenteditable') === 'true') {
          return fillContentEditable(html, value, clearFirst)
        }

        const input = el as HTMLInputElement | HTMLTextAreaElement
        if (!('value' in input)) {
          return { ok: false, error: 'Element is not an input/textarea/contenteditable' }
        }
        html.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
        try { html.focus({ preventScroll: true }) } catch {}
        if (clearFirst) {
          input.value = ''
        }
        setNativeValue(input, value)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }

    function typeText(el: Element, text: string): { ok: boolean; error?: string } {
      try {
        // Check if this is a contenteditable element
        const html = el as HTMLElement
        if (html.isContentEditable || html.getAttribute('contenteditable') === 'true') {
          // For type (append), we use fillContentEditable with clearFirst=false
          return fillContentEditable(html, text, false)
        }

        const input = el as HTMLInputElement | HTMLTextAreaElement
        if (!('value' in input)) {
          return { ok: false, error: 'Element is not an input/textarea/contenteditable' }
        }
        html.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior })
        try { html.focus({ preventScroll: true }) } catch {}
        // Append via native setter (keeps React in sync)
        setNativeValue(input, input.value + text)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: (err as Error).message }
      }
    }

    function scrollTo(el: Element | null, x?: number, y?: number, behavior?: ScrollBehavior): { ok: boolean } {
      const target = el as (HTMLElement & { scrollIntoView?: (o: ScrollIntoViewOptions) => void }) | null
      if (target) {
        target.scrollIntoView?.({ block: 'center', behavior: behavior ?? 'smooth' })
      } else {
        window.scrollTo({ left: x ?? 0, top: y ?? 0, behavior: behavior ?? 'smooth' })
      }
      return { ok: true }
    }

    // --------------------------------------------------------------
    // Action dispatcher
    // --------------------------------------------------------------
    async function runAction(action: Action): Promise<any> {
      switch (action.type) {
        case 'snapshot': {
          return { ok: true, ...snapshot(action.maxNodes ?? 2000) }
        }
        case 'text_content': {
          let target: Element | null = null
          if (action.locator) {
            const matches = resolveLocator(action.locator, 1)
            if (matches.length === 0) {
              return { ok: false, errorCode: 'ELEMENT_NOT_FOUND', error: 'No element matched the locator' }
            }
            target = matches[0]!
          }
          return { ok: true, text: textContent(target, action.maxLength ?? 10000) }
        }
        case 'find_elements': {
          const matches = resolveLocator(action.locator, action.limit ?? 20)
          return {
            ok: true,
            count: matches.length,
            elements: matches.map(elementInfo),
          }
        }
        case 'synthesize_locators': {
          // Like find_elements, but also returns synthesized CSS/id/name/
          // link_text locators (with stability scores) for each match.
          // The agent uses these to pick the most stable locator for reuse.
          const matches = resolveLocator(action.locator, action.limit ?? 20)
          return {
            ok: true,
            count: matches.length,
            elements: matches.map((el) => ({
              ...elementInfo(el),
              locators: synthesizeElementLocators(el),
            })),
          }
        }
        case 'click': {
          const matches = resolveLocator(action.locator, 5)
          if (matches.length === 0) {
            return { ok: false, errorCode: 'ELEMENT_NOT_FOUND', error: 'No element matched the locator' }
          }
          if (matches.length > 1) {
            return {
              ok: false,
              errorCode: 'ELEMENT_AMBIGUOUS',
              error: `Locator matched ${matches.length} elements; refine it`,
              candidates: matches.map(elementInfo),
            }
          }
          return { ...click(matches[0]!), element: elementInfo(matches[0]!) }
        }
        case 'fill': {
          const matches = resolveLocator(action.locator, 5)
          if (matches.length === 0) {
            return { ok: false, errorCode: 'ELEMENT_NOT_FOUND', error: 'No element matched the locator' }
          }
          if (matches.length > 1) {
            return {
              ok: false,
              errorCode: 'ELEMENT_AMBIGUOUS',
              error: `Locator matched ${matches.length} elements; refine it`,
              candidates: matches.map(elementInfo),
            }
          }
          return { ...fill(matches[0]!, action.value, action.clearFirst ?? true), element: elementInfo(matches[0]!) }
        }
        case 'type': {
          const matches = resolveLocator(action.locator, 5)
          if (matches.length === 0) {
            return { ok: false, errorCode: 'ELEMENT_NOT_FOUND', error: 'No element matched the locator' }
          }
          if (matches.length > 1) {
            return {
              ok: false,
              errorCode: 'ELEMENT_AMBIGUOUS',
              error: `Locator matched ${matches.length} elements; refine it`,
              candidates: matches.map(elementInfo),
            }
          }
          return { ...typeText(matches[0]!, action.text), element: elementInfo(matches[0]!) }
        }
        case 'scroll': {
          let target: Element | null = null
          if (action.locator) {
            const matches = resolveLocator(action.locator, 1)
            if (matches.length) target = matches[0]!
          }
          return scrollTo(target, action.x, action.y, action.behavior)
        }
        case 'evaluate': {
          // Execute arbitrary JS in page context. Intentionally strict:
          // only used for diagnostics / data extraction, NOT for DOM
          // mutation. The agent layer is expected to gate this on authorization.
          // COMPILE AND EXECUTE IN SEPARATE STAGES: only a throw from the
          // Function CONSTRUCTOR itself is provably pre-side-effect, so it
          // is the ONLY error eligible for the CSP fallback re-run. A user
          // error thrown during execution whose message happens to start
          // with the CSP wording must NEVER carry the tag — the expression
          // may already have mutated the page, and the background's CDP
          // re-run would duplicate the side effect.
          let fn: () => unknown
          try {
            // eslint-disable-next-line no-new-func
            fn = new Function(action.expression) as () => unknown
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            if (isCspCompileRejection(message)) {
              // Tag the failure so the background falls back to the CDP path.
              // NO page-readable identity token rides along (the old per-
              // document `docId` on `window.__cwPageAction` was forgeable — a
              // page script could persist and replay it in a replacement
              // document). The stale-document guard is enforced entirely in
              // the background via the browser-provided frame loader id.
              return {
                ok: false,
                errorCode: 'CSP_BLOCKED_COMPILE',
                compileError: true,
                error: message,
              }
            }
            return { ok: false, error: message }
          }
          try {
            const result = await Promise.resolve(fn())
            return { ok: true, result }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            return { ok: false, error: message }
          }
        }
        default:
          return { ok: false, errorCode: 'UNKNOWN_ACTION', error: `Unknown action type: ${(action as any).type}` }
      }
    }

    // --------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------
    // No identity token is exposed here: anything on `window` is readable
    // and forgeable by page scripts, so the CDP fallback's stale-document
    // guard uses the browser-provided frame loader id (Page.getFrameTree)
    // captured and re-checked in the background instead.
    ;(window as any).__cwPageAction = {
      ready: true,
      run: (action: Action) => runAction(action).catch((err) => ({
        ok: false,
        errorCode: 'RUNNER_ERROR',
        error: err instanceof Error ? err.message : String(err),
      })),
    }

    console.log('[Browser Extension] ✅ __cwPageAction available')
  },
})
