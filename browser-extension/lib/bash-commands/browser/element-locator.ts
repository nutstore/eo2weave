// Adapted from agentic-sandbox browser automation.
export type ElementLocator = {
    kind: "link_text" | "id" | "name" | "css"
    query: string
    verification: string
    stability: "high" | "medium" | "low"
    score?: number
    strategy?: string
    /** CSS selectors for open shadow hosts, from the document inward. */
    shadowHosts?: string[]
}

export function parseShadowHosts(value: unknown): string[] | undefined {
    if (value === undefined) return undefined
    if (
        !Array.isArray(value) ||
        value.length === 0 ||
        value.some(
            (selector) => typeof selector !== "string" || !selector.trim(),
        )
    ) {
        throw new Error("ELEMENT_PICKER_SHADOW_HOSTS_INVALID")
    }
    return value.map((selector: string) => selector.trim())
}

export function elementLocatorExpression(
    locator: ElementLocator,
): string | undefined {
    if (!locator.shadowHosts?.length || locator.kind !== "css") return undefined
    return (
        locator.shadowHosts.reduce(
            (root, selector) =>
                `${root}?.querySelector(${JSON.stringify(selector)})?.shadowRoot`,
            "document",
        ) + `?.querySelector(${JSON.stringify(locator.query)})`
    )
}

export const parseElementLocators = (value: unknown): ElementLocator[] => {
    if (!Array.isArray(value)) {
        throw new Error("ELEMENT_PICKER_LOCATORS_INVALID")
    }
    if (value.length === 0) {
        throw new Error("ELEMENT_PICKER_LOCATOR_REQUIRED")
    }

    return value.map((item, index) => {
        if (!item || typeof item !== "object") {
            throw new Error(`ELEMENT_PICKER_LOCATOR_INVALID:${index}`)
        }
        const locator = item as Record<string, unknown>
        const kind = locator.kind
        const query = locator.query
        const verification = locator.verification
        const stability = locator.stability
        if (
            (kind !== "link_text" &&
                kind !== "id" &&
                kind !== "name" &&
                kind !== "css") ||
            typeof query !== "string" ||
            query.trim().length === 0 ||
            typeof verification !== "string" ||
            (stability !== "high" &&
                stability !== "medium" &&
                stability !== "low")
        ) {
            throw new Error(`ELEMENT_PICKER_LOCATOR_INVALID:${index}`)
        }
        if (
            locator.score !== undefined &&
            (typeof locator.score !== "number" ||
                !Number.isFinite(locator.score))
        ) {
            throw new Error(`ELEMENT_PICKER_LOCATOR_SCORE_INVALID:${index}`)
        }
        if (
            locator.strategy !== undefined &&
            typeof locator.strategy !== "string"
        ) {
            throw new Error(`ELEMENT_PICKER_LOCATOR_STRATEGY_INVALID:${index}`)
        }
        const shadowHosts = parseShadowHosts(locator.shadowHosts)
        if (shadowHosts && kind !== "css") {
            throw new Error(
                `ELEMENT_PICKER_SHADOW_LOCATOR_KIND_INVALID:${index}`,
            )
        }
        return {
            kind,
            query: query.trim(),
            verification,
            stability,
            ...(shadowHosts ? { shadowHosts } : {}),
            ...(locator.score === undefined ? {} : { score: locator.score }),
            ...(locator.strategy === undefined
                ? {}
                : { strategy: locator.strategy }),
        } satisfies ElementLocator
    })
}
