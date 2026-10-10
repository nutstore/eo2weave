// Adapted from agentic-sandbox browser automation.
import { parseElementLocators } from "./element-locator"
import { sendCommand } from "./cdp"
import { serializeError } from "./errors"
import {
    browserSelectorSynthesisSource,
    type SelectorLocator,
    type SelectorLocatorKind,
} from "./selector-synthesis"

// ─── Types ───────────────────────────────────────────────────────────────────

export type SemanticLocatorKind = SelectorLocatorKind

export type SemanticLocator = SelectorLocator

export type SnapshotNode = {
    ref: string | null
    elementId: string
    backendNodeId: number
    role: string
    name: string
    tagName: string
    domPath: string
    locators: SemanticLocator[]
    parentElementId: string | null
    childElementIds: string[]
    visible: boolean | null
    clickable: boolean
    editable: boolean
    textPreview: string
    checked?: true | "mixed"
    disabled?: true
    expanded?: true
    active?: true
    invalid?: true | "grammar" | "spelling"
    level?: number
    pressed?: true | "mixed"
    selected?: true
    cursorPointer?: true
    box?: { x: number; y: number; width: number; height: number }
    url?: string
    placeholder?: string
    textValue?: string
    domPathGroupIndex?: number
    domPathGroupSize?: number
}

export type BrowserSnapshot = {
    snapshotId: string
    tabId: number
    sessionId: string
    url: string
    title: string
    treeText: string
    nodes: SnapshotNode[]
    createdAt: string
}

export const snapshotCache = new Map<string, BrowserSnapshot>()
export const latestSnapshotByScope = new Map<string, string>()
let snapshotCounter = 0
let snapshotRefCounter = 0
const snapshotRefsByScope = new Map<
    string,
    {
        documentId: string
        byBackendNodeId: Map<
            number,
            { ref: string; role: string; name: string }
        >
    }
>()
const MAX_SNAPSHOT_SCOPES = 100

function clearSnapshotScope(scope: string): void {
    const snapshotId = latestSnapshotByScope.get(scope)
    if (snapshotId) snapshotCache.delete(snapshotId)
    latestSnapshotByScope.delete(scope)
    snapshotRefsByScope.delete(scope)
}

/** Drop all ephemeral browser state tied to a closed tab. */
export function clearSnapshotsForTab(tabId: number): void {
    const tabSuffix = `:${tabId}`
    for (const [scope] of latestSnapshotByScope) {
        if (!scope.endsWith(tabSuffix)) continue
        clearSnapshotScope(scope)
    }
    for (const [snapshotId, snapshot] of snapshotCache) {
        if (snapshot.tabId === tabId) snapshotCache.delete(snapshotId)
    }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

export function getBrowserScopeKey(sessionId: string, tabId: number): string {
    return `${sessionId}:${tabId}`
}

export function getSessionId(payload: Record<string, unknown>): string {
    const value = payload.session_id
    return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : "default"
}

export function nextSnapshotId(sessionId: string, tabId: number): string {
    snapshotCounter += 1
    return `snap-${sessionId}-${tabId}-${snapshotCounter}`
}

export function extractTabUrl(tab: any): string {
    if (typeof tab?.url === "string" && tab.url.length > 0) {
        return tab.url
    }
    if (typeof tab?.pendingUrl === "string" && tab.pendingUrl.length > 0) {
        return tab.pendingUrl
    }
    return ""
}

export function extractTabTitle(tab: any): string {
    return typeof tab?.title === "string" ? tab.title : ""
}

export function normalizePlainText(value: unknown): string {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
}

export function shortenText(value: unknown, maxLength = 120): string {
    return normalizePlainText(value).slice(0, maxLength)
}

function normalizeDomPathPattern(domPath: string): string {
    return domPath.replace(/\[\d+\]/g, "")
}

function parseNodeAttributes(raw: unknown): Record<string, string> {
    if (!Array.isArray(raw)) return {}
    const attrs: Record<string, string> = {}
    for (let i = 0; i < raw.length; i += 2) {
        const name = raw[i]
        const value = raw[i + 1]
        if (typeof name !== "string" || typeof value !== "string") continue
        const normalizedName = name.trim().toLowerCase()
        if (!normalizedName) continue
        attrs[normalizedName] = value
    }
    return attrs
}

function readAxProperty(axNode: any, name: string): unknown {
    const properties = Array.isArray(axNode?.properties)
        ? axNode.properties
        : []
    const property = properties.find((item: any) => item?.name === name)
    return property?.value?.value ?? property?.value
}

function readAxTruthyProperty(axNode: any, name: string): boolean {
    const value = readAxProperty(axNode, name)
    return value === true || value === "true"
}

function readAxMixedBoolean(
    axNode: any,
    name: string,
): true | "mixed" | undefined {
    const value = readAxProperty(axNode, name)
    if (value === "mixed") return "mixed"
    return value === true || value === "true" ? true : undefined
}

function snapshotRefForNode(
    sessionId: string,
    tabId: number,
    documentId: string,
    backendNodeId: number,
    role: string,
    name: string,
): string {
    const scope = getBrowserScopeKey(sessionId, tabId)
    let state = snapshotRefsByScope.get(scope)
    if (!state || state.documentId !== documentId) {
        state = {
            documentId,
            byBackendNodeId: new Map(),
        }
        snapshotRefsByScope.set(scope, state)
    }
    const existing = state.byBackendNodeId.get(backendNodeId)
    if (existing && existing.role === role && existing.name === name) {
        return existing.ref
    }
    snapshotRefCounter += 1
    const ref = `e${snapshotRefCounter}`
    state.byBackendNodeId.set(backendNodeId, { ref, role, name })
    return ref
}

function truncateSnapshotUrl(value: string): string {
    if (!value.startsWith("data:") || value.length <= 100) return value
    const commaIndex = value.indexOf(",")
    return commaIndex === -1
        ? `${value.slice(0, 96)}…`
        : `${value.slice(0, commaIndex + 1)}…`
}

function normalizeSnapshotRole(role: string): string {
    const normalized = role.trim().toLowerCase()
    if (normalized === "rootwebarea" || normalized === "webarea") {
        return "generic"
    }
    if (normalized === "statictext" || normalized === "inlinetextbox") {
        return "text"
    }
    if (normalized === "select") return "combobox"
    return normalized || "generic"
}

export function isSnapshotRoleMeaningful(role: string): boolean {
    return !["generic", "none", "text"].includes(normalizeSnapshotRole(role))
}

export function buildSnapshotLabel(node: SnapshotNode): string {
    return buildSnapshotLabelWithName(node, node.name)
}

function buildSnapshotLabelWithName(node: SnapshotNode, name: string): string {
    const baseRole =
        node.role && node.role !== "none" ? node.role : node.tagName || "node"
    const roleTagPart =
        node.tagName && node.tagName !== "unknown"
            ? `${baseRole}<${node.tagName}>`
            : baseRole
    const namePart = name ? `: ${name}` : ""
    const groupPart =
        node.domPathGroupIndex !== undefined
            ? ` [${node.domPathGroupIndex}/${node.domPathGroupSize}]`
            : ""
    return `[${node.elementId}] ${roleTagPart}${namePart}${groupPart}`
}

function yamlStringNeedsQuotes(value: string): boolean {
    const hasControlCharacter = Array.from(value).some((character) => {
        const code = character.charCodeAt(0)
        return (
            code <= 0x08 ||
            code === 0x0b ||
            code === 0x0c ||
            (code >= 0x0e && code <= 0x1f) ||
            (code >= 0x7f && code <= 0x9f)
        )
    })
    return (
        value.length === 0 ||
        /^\s|\s$/.test(value) ||
        hasControlCharacter ||
        value.startsWith("-") ||
        /[\n:](\s|$)/.test(value) ||
        /\s#/.test(value) ||
        /[\n\r]/.test(value) ||
        /^[&*\],?!>|@"'#%]/.test(value) ||
        /[{}`]/.test(value) ||
        value.startsWith("[") ||
        !Number.isNaN(Number(value)) ||
        ["y", "n", "yes", "no", "true", "false", "on", "off", "null"].includes(
            value.toLowerCase(),
        )
    )
}

function yamlEscapeValueIfNeeded(value: string): string {
    if (!yamlStringNeedsQuotes(value)) return value
    return JSON.stringify(value)
}

function yamlEscapeKeyIfNeeded(value: string): string {
    if (!yamlStringNeedsQuotes(value)) return value
    return `'${value.replace(/'/g, "''")}'`
}

function buildPlaywrightSnapshotKey(node: SnapshotNode): string {
    let key = normalizeSnapshotRole(node.role)
    if (node.name && node.name.length <= 900) {
        key += ` ${JSON.stringify(node.name)}`
    }
    if (node.checked === "mixed") key += " [checked=mixed]"
    if (node.checked === true) key += " [checked]"
    if (node.disabled) key += " [disabled]"
    if (node.expanded) key += " [expanded]"
    if (node.active) key += " [active]"
    if (node.invalid === "grammar" || node.invalid === "spelling") {
        key += ` [invalid=${node.invalid}]`
    } else if (node.invalid) {
        key += " [invalid]"
    }
    if (node.level) key += ` [level=${node.level}]`
    if (node.pressed === "mixed") key += " [pressed=mixed]"
    if (node.pressed === true) key += " [pressed]"
    if (node.selected) key += " [selected]"
    if (node.ref) key += ` [ref=${node.ref}]`
    if (node.ref && node.cursorPointer) key += " [cursor=pointer]"
    if (node.box) {
        key += ` [box=${node.box.x},${node.box.y},${node.box.width},${node.box.height}]`
    }
    return key
}

export function renderPlaywrightStyleSnapshot(
    nodes: SnapshotNode[],
    maxDepth?: number | null,
): string {
    const nodeByElementId = new Map(nodes.map((node) => [node.elementId, node]))
    const roots = nodes.filter(
        (node) =>
            !node.parentElementId || !nodeByElementId.has(node.parentElementId),
    )
    const lines: string[] = []
    const indent = (depth: number) => "  ".repeat(depth)

    const visitText = (text: string, depth: number) => {
        const normalized = normalizePlainText(text)
        if (!normalized) return
        lines.push(
            `${indent(depth)}- text: ${yamlEscapeValueIfNeeded(normalized)}`,
        )
    }

    const visit = (node: SnapshotNode, depth: number) => {
        if (normalizeSnapshotRole(node.role) === "text") {
            visitText(node.name || node.textValue || "", depth)
            return
        }

        const key = `${indent(depth)}- ${yamlEscapeKeyIfNeeded(buildPlaywrightSnapshotKey(node))}`
        const properties: Array<[string, string]> = []
        if (node.url !== undefined) properties.push(["url", node.url])
        if (node.placeholder !== undefined) {
            properties.push(["placeholder", node.placeholder])
        }

        const children: Array<SnapshotNode | string> = []
        if (node.textValue) children.push(node.textValue)
        for (const childId of node.childElementIds) {
            const child = nodeByElementId.get(childId)
            if (!child) continue
            if (normalizeSnapshotRole(child.role) === "text") {
                if (child.name) children.push(child.name)
            } else {
                children.push(child)
            }
        }

        const compactChildren: Array<SnapshotNode | string> = []
        const textBuffer: string[] = []
        const flushText = () => {
            if (textBuffer.length === 0) return
            const text = normalizePlainText(textBuffer.join(" "))
            if (text) compactChildren.push(text)
            textBuffer.length = 0
        }
        for (const child of children) {
            if (typeof child === "string") {
                textBuffer.push(child)
            } else {
                flushText()
                compactChildren.push(child)
            }
        }
        flushText()
        if (compactChildren.length === 1 && compactChildren[0] === node.name) {
            compactChildren.length = 0
        }

        const singleTextChild =
            compactChildren.length === 1 &&
            typeof compactChildren[0] === "string"
                ? compactChildren[0]
                : null
        if (singleTextChild !== null && properties.length === 0) {
            lines.push(`${key}: ${yamlEscapeValueIfNeeded(singleTextChild)}`)
            return
        }

        const canRenderChildren = maxDepth == null || depth < maxDepth
        const renderableChildren = canRenderChildren ? compactChildren : []
        if (properties.length === 0 && renderableChildren.length === 0) {
            lines.push(key)
            return
        }

        lines.push(`${key}:`)
        for (const [name, value] of properties) {
            lines.push(
                `${indent(depth + 1)}- /${name}: ${yamlEscapeValueIfNeeded(value)}`,
            )
        }
        for (const child of renderableChildren) {
            if (typeof child === "string") visitText(child, depth + 1)
            else visit(child, depth + 1)
        }
    }

    for (const root of roots) visit(root, 0)
    return lines.join("\n")
}

type RawSnapshotAxNode = {
    axId: string
    parentAxId: string | null
    childAxIds: string[]
    node: SnapshotNode
}

function shouldKeepSnapshotNode(node: SnapshotNode): boolean {
    if (node.role.trim().toLowerCase() === "inlinetextbox") return false
    if (isSnapshotRoleMeaningful(node.role)) return true
    if (node.clickable || node.editable) return true
    return Boolean(node.name)
}

function selectSnapshotNodesToKeep(
    rawNodes: RawSnapshotAxNode[],
): RawSnapshotAxNode[] {
    const rawByAxId = new Map(rawNodes.map((item) => [item.axId, item]))
    const memo = new Map<string, boolean>()
    const visiting = new Set<string>()

    const subtreeHasDirectlyKeptNonNone = (axId: string): boolean => {
        const cached = memo.get(axId)
        if (typeof cached === "boolean") return cached
        if (visiting.has(axId)) return false

        const item = rawByAxId.get(axId)
        if (!item) {
            memo.set(axId, false)
            return false
        }

        visiting.add(axId)
        const keepSelf = shouldKeepSnapshotNode(item.node)
        let hasKeptNonNone = item.node.role !== "none" && keepSelf
        if (!hasKeptNonNone) {
            for (const childAxId of item.childAxIds) {
                if (subtreeHasDirectlyKeptNonNone(childAxId)) {
                    hasKeptNonNone = true
                    break
                }
            }
        }
        visiting.delete(axId)
        memo.set(axId, hasKeptNonNone)
        return hasKeptNonNone
    }

    for (const item of rawNodes) {
        subtreeHasDirectlyKeptNonNone(item.axId)
    }

    return rawNodes.filter((item) => {
        const keepSelf = shouldKeepSnapshotNode(item.node)
        if (item.node.role !== "none") return keepSelf
        if (keepSelf) return true
        for (const childAxId of item.childAxIds) {
            if (subtreeHasDirectlyKeptNonNone(childAxId)) {
                return true
            }
        }
        return false
    })
}

function rebuildSnapshotTreeWithKeptNodes(
    rawNodes: RawSnapshotAxNode[],
    keptNodes: RawSnapshotAxNode[],
): void {
    const rawByAxId = new Map(rawNodes.map((item) => [item.axId, item]))
    const keptByAxId = new Map(keptNodes.map((item) => [item.axId, item]))

    for (const item of keptNodes) {
        item.node.parentElementId = null
        item.node.childElementIds = []

        let cursor = item.parentAxId
        while (cursor) {
            const keptParent = keptByAxId.get(cursor)
            if (keptParent) {
                item.node.parentElementId = keptParent.node.elementId
                break
            }
            cursor = rawByAxId.get(cursor)?.parentAxId || null
        }
    }

    const keptByElementId = new Map(
        keptNodes.map((item) => [item.node.elementId, item.node]),
    )
    for (const item of keptNodes) {
        const parentElementId = item.node.parentElementId
        if (!parentElementId) continue
        const parent = keptByElementId.get(parentElementId)
        if (!parent) continue
        parent.childElementIds.push(item.node.elementId)
    }
}

async function getDomDocumentWithFallback(tabId: number): Promise<any> {
    const depths = [-1, 4096, 2048, 512, 1]
    let lastError: unknown = null
    for (const depth of depths) {
        try {
            return await sendCommand(tabId, "DOM.getDocument", {
                depth,
                pierce: true,
            })
        } catch (error) {
            console.error(
                `[BrowserSnapshot] DOM.getDocument failed at depth=${depth}:`,
                error,
            )
            lastError = error
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error("DOM.getDocument failed")
}

async function resolveNodeLocatorsFromBrowser(
    tabId: number,
    backendNodeId: number,
): Promise<{
    isElement: boolean
    tagName: string
    locators: SemanticLocator[]
}> {
    const resolved = await sendCommand<any>(tabId, "DOM.resolveNode", {
        backendNodeId,
    })
    const objectId = resolved?.object?.objectId
    if (!objectId) {
        throw new Error(
            `LOCATOR_GENERATION_FAILED: DOM.resolveNode returned no objectId for backendNodeId ${backendNodeId}`,
        )
    }

    const result = await sendCommand<any>(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `(function() {
            const el = this;
            if (!(el instanceof Element)) {
                return { isElement: false, tagName: "unknown", locators: [] };
            }
            const tagName = el.tagName.toLowerCase();
            ${browserSelectorSynthesisSource()}
            const locators = synthesizeElementLocators(el);
            return { isElement: true, tagName, locators: Array.isArray(locators) ? locators : [] };
        })`,
        returnByValue: true,
        awaitPromise: false,
        silent: true,
    }).finally(() =>
        sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(
            (error) => {
                console.error(
                    "[background-browser-snapshot] Failed to release remote object",
                    serializeError(error),
                )
            },
        ),
    )

    if (result?.exceptionDetails) {
        throw new Error(
            `LOCATOR_GENERATION_FAILED: callFunctionOn failed for backendNodeId ${backendNodeId}: ${result.exceptionDetails?.text ?? "unknown"}`,
        )
    }
    if (!result?.result?.value) {
        throw new Error(
            `LOCATOR_GENERATION_FAILED: node is not an Element for backendNodeId ${backendNodeId}`,
        )
    }
    const val = result.result.value
    const isElement = val.isElement === true
    return {
        isElement,
        tagName: typeof val.tagName === "string" ? val.tagName : "unknown",
        locators: isElement && Array.isArray(val.locators) && val.locators.length ? parseElementLocators(val.locators) : [],
    }
}

async function attachSnapshotBoxes(
    tabId: number,
    nodes: SnapshotNode[],
): Promise<void> {
    const metrics = await sendCommand<any>(tabId, "Page.getLayoutMetrics", {})
    const pageX = Number(metrics?.visualViewport?.pageX || 0)
    const pageY = Number(metrics?.visualViewport?.pageY || 0)
    let cursor = 0
    const workerCount = Math.min(16, nodes.length)

    const worker = async () => {
        while (cursor < nodes.length) {
            const node = nodes[cursor]
            cursor += 1
            if (!node.ref) continue
            try {
                const result = await sendCommand<any>(
                    tabId,
                    "DOM.getBoxModel",
                    {
                        backendNodeId: node.backendNodeId,
                    },
                )
                const quad = result?.model?.border
                if (!Array.isArray(quad) || quad.length < 8) continue
                const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number)
                const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number)
                const left = Math.min(...xs) - pageX
                const top = Math.min(...ys) - pageY
                const right = Math.max(...xs) - pageX
                const bottom = Math.max(...ys) - pageY
                node.box = {
                    x: Math.round(left),
                    y: Math.round(top),
                    width: Math.round(right - left),
                    height: Math.round(bottom - top),
                }
            } catch {
                // Some AX nodes do not resolve to layout boxes. Playwright also
                // omits box metadata for nodes without an Element box.
            }
        }
    }

    await Promise.all(Array.from({ length: workerCount }, () => worker()))
}

export async function buildBrowserSnapshot(
    tabId: number,
    payload: Record<string, unknown>,
): Promise<BrowserSnapshot> {
    const sessionId = getSessionId(payload)
    const includeText = payload.include_text !== false

    const [tab, domDocument, axTree, frameTree] = await Promise.all([
        chrome.tabs.get(tabId),
        getDomDocumentWithFallback(tabId),
        sendCommand<any>(tabId, "Accessibility.getFullAXTree", {}),
        sendCommand<any>(tabId, "Page.getFrameTree", {}),
    ])

    const domPathMap = new Map<number, string>()
    const tagNameMap = new Map<number, string>()
    const attrsByBackendId = new Map<number, Record<string, string>>()

    const visitDomNode = (node: any, ownPath: string) => {
        if (!node || typeof node !== "object") return
        const nodeNameRaw =
            typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : ""
        const backendNodeId =
            typeof node.backendNodeId === "number" ? node.backendNodeId : null
        const isElement = Boolean(nodeNameRaw && /^[a-z]/.test(nodeNameRaw))

        if (backendNodeId && isElement) {
            const domPath = ownPath || `/${nodeNameRaw}[1]`
            const attrs = parseNodeAttributes(node.attributes)
            domPathMap.set(backendNodeId, domPath)
            tagNameMap.set(backendNodeId, nodeNameRaw)
            attrsByBackendId.set(backendNodeId, attrs)
        }

        const childArrays = []
        if (Array.isArray(node.children)) childArrays.push(node.children)
        if (Array.isArray(node.shadowRoots)) childArrays.push(node.shadowRoots)

        for (const children of childArrays) {
            const counters = new Map<string, number>()
            for (const child of children) {
                const childName =
                    typeof child?.nodeName === "string"
                        ? child.nodeName.toLowerCase()
                        : ""
                const childIsElement = Boolean(
                    childName && /^[a-z]/.test(childName),
                )
                const nextCount = childIsElement
                    ? (counters.get(childName) || 0) + 1
                    : 0
                if (childIsElement) {
                    counters.set(childName, nextCount)
                }
                visitDomNode(
                    child,
                    childIsElement
                        ? `${ownPath}/${childName}[${nextCount}]`
                        : ownPath,
                )
            }
        }
    }

    visitDomNode(domDocument?.root, "")
    const documentId =
        typeof frameTree?.frameTree?.frame?.loaderId === "string"
            ? frameTree.frameTree.frame.loaderId
            : `backend-${String(domDocument?.root?.backendNodeId || "unknown")}`

    const axNodes = Array.isArray(axTree?.nodes) ? axTree.nodes : []
    const rawNodes = axNodes
        .map((axNode: any) => {
            const backendNodeId =
                typeof axNode?.backendDOMNodeId === "number"
                    ? axNode.backendDOMNodeId
                    : typeof axNode?.backendNodeId === "number"
                      ? axNode.backendNodeId
                      : null
            if (!backendNodeId) return null
            const role = normalizePlainText(
                typeof axNode?.role?.value === "string"
                    ? axNode.role.value
                    : typeof axNode?.role === "string"
                      ? axNode.role
                      : "",
            )
            const rawName =
                typeof axNode?.name?.value === "string"
                    ? axNode.name.value
                    : typeof axNode?.name === "string"
                      ? axNode.name
                      : ""
            const name = ["RootWebArea", "WebArea"].includes(role)
                ? ""
                : normalizePlainText(rawName)
            const tagName = tagNameMap.get(backendNodeId) || "unknown"
            const domPath = domPathMap.get(backendNodeId) || ""
            const elementId = `0-${backendNodeId}`
            const attrs = attrsByBackendId.get(backendNodeId) || {}
            const hidden = readAxTruthyProperty(axNode, "hidden")
            const invalidValue = readAxProperty(axNode, "invalid")
            const levelValue = readAxProperty(axNode, "level")
            const textValue = normalizePlainText(
                axNode?.value?.value ?? axNode?.value,
            )
            return {
                axId:
                    typeof axNode?.nodeId === "string"
                        ? axNode.nodeId
                        : elementId,
                parentAxId:
                    typeof axNode?.parentId === "string"
                        ? axNode.parentId
                        : null,
                childAxIds: Array.isArray(axNode?.childIds)
                    ? axNode.childIds
                    : [],
                node: {
                    ref:
                        !hidden && tagName !== "unknown"
                            ? snapshotRefForNode(
                                  sessionId,
                                  tabId,
                                  documentId,
                                  backendNodeId,
                                  role,
                                  name,
                              )
                            : null,
                    elementId,
                    backendNodeId,
                    role:
                        role === "combobox" && tagName === "select"
                            ? "select"
                            : role || tagName || "node",
                    name,
                    tagName,
                    domPath,
                    locators: [],
                    parentElementId: null,
                    childElementIds: [],
                    visible: hidden ? false : null,
                    clickable:
                        [
                            "button",
                            "link",
                            "checkbox",
                            "radio",
                            "combobox",
                            "select",
                        ].includes(role) ||
                        ["button", "a", "select"].includes(tagName) ||
                        "onclick" in attrs,
                    editable:
                        ["textbox", "searchbox"].includes(role) ||
                        ["input", "textarea", "select"].includes(tagName),
                    textPreview: includeText
                        ? shortenText(name || tagName)
                        : "",
                    ...(readAxMixedBoolean(axNode, "checked")
                        ? { checked: readAxMixedBoolean(axNode, "checked") }
                        : {}),
                    ...(readAxTruthyProperty(axNode, "disabled")
                        ? { disabled: true as const }
                        : {}),
                    ...(readAxTruthyProperty(axNode, "expanded")
                        ? { expanded: true as const }
                        : {}),
                    ...(readAxTruthyProperty(axNode, "focused")
                        ? { active: true as const }
                        : {}),
                    ...(invalidValue === "grammar" ||
                    invalidValue === "spelling"
                        ? { invalid: invalidValue }
                        : invalidValue === true || invalidValue === "true"
                          ? { invalid: true as const }
                          : {}),
                    ...(typeof levelValue === "number" && levelValue > 0
                        ? { level: levelValue }
                        : {}),
                    ...(readAxMixedBoolean(axNode, "pressed")
                        ? { pressed: readAxMixedBoolean(axNode, "pressed") }
                        : {}),
                    ...(readAxTruthyProperty(axNode, "selected")
                        ? { selected: true as const }
                        : {}),
                    ...(/cursor\s*:\s*pointer/i.test(attrs.style || "")
                        ? { cursorPointer: true as const }
                        : {}),
                    ...(typeof attrs.href === "string"
                        ? { url: truncateSnapshotUrl(attrs.href) }
                        : {}),
                    ...(typeof attrs.placeholder === "string" &&
                    attrs.placeholder !== name
                        ? { placeholder: attrs.placeholder }
                        : {}),
                    ...(textValue &&
                    (["input", "textarea"].includes(tagName) ||
                        ["textbox", "searchbox", "spinbutton"].includes(role))
                        ? { textValue }
                        : {}),
                } satisfies SnapshotNode,
            }
        })
        .filter(Boolean) as RawSnapshotAxNode[]

    let scopedRawNodes = rawNodes
    const snapshotTarget =
        typeof payload.target === "string" ? payload.target.trim() : ""
    if (snapshotTarget) {
        const rootBackendNodeId = Number(payload.target_backend_node_id)
        const root = rawNodes.find(
            (item) => item.node.backendNodeId === rootBackendNodeId,
        )
        if (!root) {
            throw new Error(
                `SNAPSHOT_TARGET_NOT_FOUND: ${snapshotTarget} is not represented in the accessibility tree`,
            )
        }
        if (/^e\d+$/.test(snapshotTarget) && root.node.ref !== snapshotTarget) {
            throw new Error(
                `REF_NOT_FOUND: Ref ${snapshotTarget} is stale because the element's role or accessible name changed. Capture a fresh snapshot and retry.`,
            )
        }
        const byAxId = new Map(rawNodes.map((item) => [item.axId, item]))
        const includedAxIds = new Set<string>()
        const visit = (axId: string) => {
            if (includedAxIds.has(axId)) return
            includedAxIds.add(axId)
            const item = byAxId.get(axId)
            for (const childAxId of item?.childAxIds || []) visit(childAxId)
        }
        visit(root.axId)
        scopedRawNodes = rawNodes.filter((item) => includedAxIds.has(item.axId))
    }

    const prunedNodes = selectSnapshotNodesToKeep(scopedRawNodes)
    rebuildSnapshotTreeWithKeptNodes(scopedRawNodes, prunedNodes)

    // Every snapshot locator is generated and verified by the same live engine.
    let nextLocatorNode = 0
    await Promise.all(
        Array.from({ length: Math.min(4, prunedNodes.length) }, async () => {
            while (nextLocatorNode < prunedNodes.length) {
                ;(payload.signal as AbortSignal | undefined)?.throwIfAborted()
                const item = prunedNodes[nextLocatorNode++]
                const { isElement, tagName, locators } =
                    await resolveNodeLocatorsFromBrowser(
                        tabId,
                        item.node.backendNodeId,
                    )
                if (!isElement) {
                    if (item.node.clickable || item.node.editable) {
                        throw new Error(
                            `LOCATOR_GENERATION_FAILED: interactive AX node is not an Element for backendNodeId ${item.node.backendNodeId}`,
                        )
                    }
                    item.node.locators = []
                    continue
                }
                if (item.node.tagName === "unknown" && tagName !== "unknown") {
                    item.node.tagName = tagName
                    if (item.node.visible !== false) {
                        item.node.ref = snapshotRefForNode(
                            sessionId,
                            tabId,
                            documentId,
                            item.node.backendNodeId,
                            item.node.role,
                            item.node.name,
                        )
                    }
                    item.node.clickable =
                        item.node.clickable ||
                        ["button", "a", "select"].includes(tagName)
                    item.node.editable =
                        item.node.editable ||
                        ["input", "textarea", "select"].includes(tagName)
                    if (
                        item.node.role === "node" ||
                        item.node.role === "unknown"
                    ) {
                        item.node.role = tagName
                    } else if (
                        item.node.role === "combobox" &&
                        tagName === "select"
                    ) {
                        item.node.role = "select"
                    }
                }
                item.node.locators = locators
            }
        }),
    )

    if (payload.boxes === true) {
        await attachSnapshotBoxes(
            tabId,
            prunedNodes.map((item) => item.node),
        )
    }

    const nodeByElementId = new Map(
        prunedNodes.map((item) => [item.node.elementId, item.node]),
    )

    const domPathPatternOrder = new Map<string, string[]>()
    for (const item of prunedNodes) {
        if (!item.node.domPath) continue
        const pattern = normalizeDomPathPattern(item.node.domPath)
        const group = domPathPatternOrder.get(pattern) ?? []
        group.push(item.node.elementId)
        domPathPatternOrder.set(pattern, group)
    }
    for (const elementIds of domPathPatternOrder.values()) {
        if (elementIds.length < 2) continue
        for (let i = 0; i < elementIds.length; i++) {
            const node = nodeByElementId.get(elementIds[i])
            if (node) {
                node.domPathGroupIndex = i + 1
                node.domPathGroupSize = elementIds.length
            }
        }
    }

    const requestedDepth =
        typeof payload.depth === "number" &&
        Number.isInteger(payload.depth) &&
        payload.depth >= 0
            ? payload.depth
            : null

    const snapshot: BrowserSnapshot = {
        snapshotId: nextSnapshotId(sessionId, tabId),
        tabId,
        sessionId,
        url: extractTabUrl(tab),
        title: extractTabTitle(tab),
        treeText: renderPlaywrightStyleSnapshot(
            prunedNodes.map((item) => item.node),
            requestedDepth,
        ),
        nodes: prunedNodes.map((item) => item.node),
        createdAt: new Date().toISOString(),
    }

    ;(payload.signal as AbortSignal | undefined)?.throwIfAborted()
    const currentDocument = await sendCommand<any>(tabId, "DOM.getDocument", { depth: 0 })
    if (currentDocument.root?.backendNodeId !== domDocument.root?.backendNodeId) {
        throw new Error("Page changed while capturing snapshot; retry")
    }
    const scope = getBrowserScopeKey(sessionId, tabId)
    const previousSnapshotId = latestSnapshotByScope.get(scope)
    if (previousSnapshotId) snapshotCache.delete(previousSnapshotId)
    // Refresh insertion order so capacity eviction removes the least-recently
    // snapshotted scope, rather than an active one.
    latestSnapshotByScope.delete(scope)
    snapshotCache.set(snapshot.snapshotId, snapshot)
    latestSnapshotByScope.set(scope, snapshot.snapshotId)
    while (latestSnapshotByScope.size > MAX_SNAPSHOT_SCOPES) {
        const oldestScope = latestSnapshotByScope.keys().next().value
        if (typeof oldestScope !== "string") break
        clearSnapshotScope(oldestScope)
    }
    return snapshot
}

export function getLatestSnapshotForScope(
    sessionId: string,
    tabId: number,
): BrowserSnapshot | null {
    const snapshotId = latestSnapshotByScope.get(
        getBrowserScopeKey(sessionId, tabId),
    )
    if (!snapshotId) return null
    return snapshotCache.get(snapshotId) || null
}
