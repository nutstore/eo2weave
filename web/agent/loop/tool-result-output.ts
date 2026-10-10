import { isCodeRunResult, isOutputPart, type OutputPart } from '@creatorweave/shared/code-output'
import { isToolEnvelopeV2 } from '../tools/tool-envelope'

/** Only the Agent consumer turns explicit, top-level output into model content. */
export function projectToolOutput(toolName: string, parsed: unknown, fallback: string): {
  text: string; output: OutputPart[]; isError: boolean
} {
  if (!isToolEnvelopeV2(parsed) || !parsed.ok)
    return { text: fallback, output: [], isError: false }
  if (toolName === 'run_code' && isCodeRunResult(parsed.data)) {
    const { output, ...result } = parsed.data
    return {
      text: JSON.stringify({ ...parsed, data: result }),
      output, isError: !result.ok,
    }
  }
  if (toolName === 'read_image' && isOutputPart(parsed.data) && parsed.data.type === 'image') {
    const metadata = { ...parsed.data }
    Reflect.deleteProperty(metadata, 'data')
    return { text: JSON.stringify({ ...parsed, data: metadata }), output: [parsed.data], isError: false }
  }
  // A declared envelope presentation is explicit; nested JSON is never scanned for images.
  if (parsed.contentParts?.length && parsed.contentParts.every(isOutputPart))
    return { text: '', output: parsed.contentParts, isError: false }
  return { text: fallback, output: [], isError: false }
}
