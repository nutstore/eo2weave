/**
 * QuoteBlock — the composer-side representation of a quoted selection.
 *
 * The block renders as a bordered card inside the rich input, while
 * `quoteBlockToText` serializes it back into plain markdown blockquote text
 * (`> ` per line). The model must receive the quote in-band, so the card is a
 * composer-only affordance: it never changes what gets sent.
 */

import { Node, mergeAttributes, type JSONContent } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { quoteLinesToText } from './selection-quote'

export const QuoteBlock = Node.create({
  name: 'quoteBlock',

  group: 'block',

  content: 'inline*',

  defining: true,

  parseHTML() {
    return [{ tag: 'blockquote[data-quote-block]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'blockquote',
      mergeAttributes(HTMLAttributes, {
        'data-quote-block': '',
        class:
          'my-1 border-l-2 border-primary-300 pl-3 text-neutral-600 dark:border-primary-700 dark:text-neutral-300',
      }),
      0,
    ]
  },
})

/**
 * ProseMirror content for a quote block: one hard-break separated line per
 * selection line (the schema has no newline text node).
 */
export function quoteBlockContent(lines: string[]): JSONContent[] {
  const content: JSONContent[] = []
  lines.forEach((line, index) => {
    if (index > 0) content.push({ type: 'hardBreak' })
    if (line) content.push({ type: 'text', text: line })
  })
  return content
}

/** Serialize one quote block back into markdown blockquote text. */
export function quoteBlockToText(node: ProseMirrorNode): string {
  let text = ''
  node.forEach((child) => {
    if (child.isText) text += child.text ?? ''
    else if (child.type.name === 'hardBreak') text += '\n'
  })
  return quoteLinesToText(text.split('\n'))
}
