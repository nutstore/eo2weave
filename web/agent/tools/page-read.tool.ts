// ============================================================
// Page Read Tools — page_snapshot / page_text_content / page_find_elements
//
// Read-only tools that let the agent inspect the upstream page structure,
// extract text, and locate elements. These have NO side effects on the
// page and are safe to run without user confirmation.
//
// Bridge: window.__agentWeb.runPageAction → extension →
//         window.__cwPageAction.run(action) in upstream tab.
// ============================================================

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import type { JSONSchemaProperty } from './tool-types'
import { toolOkJson, toolErrorJson } from './tool-envelope'
import { isPageActionAvailable, runPageAction, captureTab, type Locator } from './page-action-bridge'

// --------------------------------------------------------------
// Shared locator schema (reused by page-write tools)
// --------------------------------------------------------------
export const locatorSchema: JSONSchemaProperty = {
  type: 'object',
  description: [
    'Element locator. STRICT INTERSECTION: every provided field MUST match.',
    'If multiple elements match, the action FAILS with ELEMENT_AMBIGUOUS',
    'and returns `candidates` — refine the locator rather than guessing.',
    '',
    'Recommended priority for stability:',
    '  1. element_id (from a prior snapshot — most stable)',
    '  2. role + name (semantic, survives markup reshuffles)',
    '  3. text + near_text (readable but localization-fragile)',
    '  4. selector / xpath (last resort — brittle to DOM changes)',
  ].join('\n'),
  properties: {
    element_id: { type: 'string', description: 'Stable id from a prior page_snapshot / find_elements result (e.g. "cw_abc"). Preferred for reuse.' },
    selector: { type: 'string', description: 'CSS selector.' },
    xpath: { type: 'string', description: 'XPath expression.' },
    text: { type: 'string', description: 'Substring that must appear in the element\'s textContent.' },
    role: { type: 'string', description: 'ARIA role (e.g. "button", "link", "textbox").' },
    name: { type: 'string', description: 'HTML name attribute.' },
    near_text: { type: 'string', description: 'Substring in a nearby element\'s text (within ~300px). Use to disambiguate similar elements.' },
    ancestor_text: { type: 'string', description: 'Substring in an ancestor element\'s textContent.' },
    tag_name: { type: 'string', description: 'Lowercase tag name (e.g. "button", "input", "a").' },
    input_type: { type: 'string', description: 'Input type attribute (e.g. "text", "email", "checkbox").' },
    visible_only: { type: 'boolean', description: 'When true, only currently-visible elements match. Default false.' },
  },
}

// ===========================================================================
// page_snapshot
// ===========================================================================

export const pageSnapshotDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'page_snapshot',
    description: [
      'Capture a pruned accessibility/DOM snapshot of the current upstream page.',
      '',
      'Returns a tree_text representation: each visible or interactive node is one',
      'indented line with its [element_id], tag, role, name, type, placeholder,',
      'aria-label, and a short text snippet.',
      '',
      'Use this FIRST to understand page structure and discover element_ids,',
      'then reuse those element_ids in page_click / page_fill / page_find_elements',
      'for stable targeting.',
      '',
      'Requires: Browser Extension + side-panel mode.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        maxNodes: {
          type: 'number',
          description: 'Maximum nodes to include before truncation (default 2000). Lower this for very large pages to keep output manageable.',
        },
      },
    },
  },
}

export const pageSnapshotExecutor: ToolExecutor = async (args) => {
  if (!isPageActionAvailable()) {
    return toolErrorJson('page_snapshot', 'PAGE_ACTION_UNAVAILABLE', 'Page tools require the Browser Extension and side-panel mode. Open eo2weave as a side panel docked to the page you want to inspect.')
  }
  const result = await runPageAction({ type: 'snapshot', maxNodes: typeof args.maxNodes === 'number' ? args.maxNodes : undefined })
  if (!result.ok) {
    return toolErrorJson('page_snapshot', result.errorCode || 'SNAPSHOT_FAILED', result.error || 'Snapshot failed', { retryable: result.errorCode === 'EXECUTE_SCRIPT_FAILED' })
  }
  return toolOkJson('page_snapshot', {
    tree_text: result.tree_text || '',
    nodeCount: result.nodeCount ?? 0,
    truncated: result.truncated === true,
  })
}

// ===========================================================================
// page_text_content
// ===========================================================================

export const pageTextContentDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'page_text_content',
    description: [
      'Extract text content from the current upstream page.',
      '',
      '- With a locator: returns the matched element\'s textContent.',
      '- Without a locator: returns the entire page body text.',
      '',
      'Output is whitespace-collapsed and truncated to maxLength. Use this to',
      'read content the user is looking at, or to verify what an element says',
      'before clicking it.',
      '',
      'Requires: Browser Extension + side-panel mode.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        locator: { ...locatorSchema, description: 'Optional element locator. Omit to read the whole page.' },
        maxLength: { type: 'number', description: 'Maximum characters to return (default 10000).' },
      },
    },
  },
}

export const pageTextContentExecutor: ToolExecutor = async (args) => {
  if (!isPageActionAvailable()) {
    return toolErrorJson('page_text_content', 'PAGE_ACTION_UNAVAILABLE', 'Page tools require the Browser Extension and side-panel mode.')
  }
  const locator = args.locator as Locator | undefined
  const result = await runPageAction({
    type: 'text_content',
    locator,
    maxLength: typeof args.maxLength === 'number' ? args.maxLength : undefined,
  })
  if (!result.ok) {
    return toolErrorJson('page_text_content', result.errorCode || 'TEXT_FAILED', result.error || 'Text extraction failed', {
      retryable: result.errorCode === 'EXECUTE_SCRIPT_FAILED',
      details: result.candidates ? { candidates: result.candidates } : undefined,
    })
  }
  return toolOkJson('page_text_content', { text: result.text || '' })
}

// ===========================================================================
// page_find_elements
// ===========================================================================

export const pageFindElementsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'page_find_elements',
    description: [
      'Find elements matching a locator and return their descriptors.',
      '',
      'Use this to check whether a locator uniquely identifies an element BEFORE',
      'attempting a click/fill — pass the same locator you plan to use. If the',
      'result has count > 1, refine the locator (add near_text / role / name)',
      'until it matches exactly one element.',
      '',
      'Returns: count, and up to `limit` element descriptors (elementId, tagName,',
      'role, name, text, visible, rect, attributes).',
      '',
      'Requires: Browser Extension + side-panel mode.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        locator: locatorSchema,
        limit: { type: 'number', description: 'Maximum elements to return (default 20).' },
      },
      required: ['locator'],
    },
  },
}

export const pageFindElementsExecutor: ToolExecutor = async (args) => {
  if (!isPageActionAvailable()) {
    return toolErrorJson('page_find_elements', 'PAGE_ACTION_UNAVAILABLE', 'Page tools require the Browser Extension and side-panel mode.')
  }
  const locator = args.locator as Locator
  if (!locator || typeof locator !== 'object') {
    return toolErrorJson('page_find_elements', 'INVALID_INPUT', 'locator is required and must be an object')
  }
  const result = await runPageAction({ type: 'find_elements', locator, limit: typeof args.limit === 'number' ? args.limit : undefined })
  if (!result.ok) {
    return toolErrorJson('page_find_elements', result.errorCode || 'FIND_FAILED', result.error || 'Find failed', { retryable: result.errorCode === 'EXECUTE_SCRIPT_FAILED' })
  }
  return toolOkJson('page_find_elements', {
    count: result.count ?? 0,
    elements: result.elements ?? [],
  })
}

// ===========================================================================
// page_synthesize_locators
// ===========================================================================

export const pageSynthesizeLocatorsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'page_synthesize_locators',
    description: [
      'Find elements matching a locator AND synthesize ranked CSS/id/name/link_text',
      'locators for each match, with stability scores.',
      '',
      'Use this when you need a STABLE locator to reuse across multiple operations',
      '(e.g. find a button once, then click it later without re-searching). The',
      'returned locators are sorted by stability score (lower = better):',
      '  - link_text exact unique (5), id (8-9), name+tag (12)',
      '  - data-testid/aria-label attribute (15), other attributes (35)',
      '  - single class (45), class pair (65), bare tag (80), nth-of-type (110)',
      '  - full path (1000+, last resort)',
      '',
      'Prefer locators with stability="high" for reuse.',
      'Requires: Browser Extension + side-panel mode.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        locator: locatorSchema,
        limit: { type: 'number', description: 'Maximum elements to synthesize locators for (default 20).' },
      },
      required: ['locator'],
    },
  },
}

export const pageSynthesizeLocatorsExecutor: ToolExecutor = async (args) => {
  if (!isPageActionAvailable()) {
    return toolErrorJson('page_synthesize_locators', 'PAGE_ACTION_UNAVAILABLE', 'Page tools require the Browser Extension and side-panel mode.')
  }
  const locator = args.locator as Locator
  if (!locator || typeof locator !== 'object') {
    return toolErrorJson('page_synthesize_locators', 'INVALID_INPUT', 'locator is required and must be an object')
  }
  const result = await runPageAction({ type: 'synthesize_locators', locator, limit: typeof args.limit === 'number' ? args.limit : undefined })
  if (!result.ok) {
    return toolErrorJson('page_synthesize_locators', result.errorCode || 'SYNTH_FAILED', result.error || 'Synthesis failed', { retryable: result.errorCode === 'EXECUTE_SCRIPT_FAILED' })
  }
  return toolOkJson('page_synthesize_locators', {
    count: result.count ?? 0,
    elements: result.elements ?? [],
  })
}

// ===========================================================================
// page_screenshot
// ===========================================================================

export const pageScreenshotDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'page_screenshot',
    description: [
      'Capture a screenshot of the current visible viewport of the upstream page.',
      '',
      'Returns the image as a base64 data URL. The screenshot reflects exactly',
      'what the user sees right now (after all dynamic rendering, scrolling, etc.).',
      '',
      'Only captures the visible viewport. To capture a specific area, scroll',
      'the page first with page_scroll, then screenshot.',
      '',
      'Requires: Browser Extension + side-panel mode + a vision-capable model.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['png', 'jpeg'],
          description: 'Image format. Use jpeg for smaller payload (default: png).',
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 0-100 (only for jpeg format). Default: 80.',
        },
      },
    },
  },
}

export const pageScreenshotExecutor: ToolExecutor = async (args) => {
  if (!isPageActionAvailable()) {
    return toolErrorJson('page_screenshot', 'PAGE_ACTION_UNAVAILABLE', 'Screenshot requires the Browser Extension and side-panel mode.')
  }
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  const quality = typeof args.quality === 'number' ? args.quality : undefined
  const result = await captureTab(format, quality)
  if (!result.ok || !result.dataUrl) {
    return toolErrorJson('page_screenshot', result.errorCode || 'CAPTURE_FAILED', result.error || 'Screenshot failed', { retryable: false })
  }

  // Parse the data URL into (mimeType, base64 data) so we can deliver it
  // as a multimodal content part instead of a huge text blob.
  // Format: data:<mime>;base64,<data>
  const match = /^data:([^;]+);base64,(.*)$/.exec(result.dataUrl)
  if (!match) {
    // Malformed dataUrl — fall back to text
    return toolOkJson('page_screenshot', {
      format: result.format || format,
      note: 'Screenshot captured but dataUrl could not be parsed as multimodal content.',
    })
  }
  const [, mimeType, base64Data] = match

  return toolOkJson(
    'page_screenshot',
    {
      format: result.format || format,
      image: { type: 'image', data: base64Data!, mimeType: mimeType! },
    },
    {
      // Direct Agent presentation; code callers receive data.image explicitly.
      contentParts: [
        {
          type: 'image',
          data: base64Data!,
          mimeType: mimeType!,
        },
        {
          type: 'text',
          text: `[Screenshot captured. Format: ${result.format || format}. The image is visible above. Use it to answer the user's question about the current page.]`,
        },
      ],
    }
  )
}

// ===========================================================================
// Prompt doc
// ===========================================================================

export const pageReadPromptDoc: ToolPromptDoc = {
  category: 'page',
  section: '### Page Tools (read — Browser Extension + side panel)',
  lines: [
    '- `page_snapshot(maxNodes?)` - Capture a pruned DOM/a11y tree of the upstream page with stable element_ids',
    '- `page_text_content(locator?, maxLength?)` - Extract text from an element (or the whole page if no locator)',
    '- `page_find_elements(locator, limit?)` - Find elements matching a locator; use to verify uniqueness before clicking',
    '- `page_synthesize_locators(locator, limit?)` - Get ranked stable locators (CSS/id/name/link_text) with stability scores for reuse',
    '- `page_screenshot(format?, quality?)` - Capture the visible viewport as an image (requires vision-capable model)',
  ],
}
