// Internal transport only: input is scoped to an existing authorized tool invocation.
export const XHS_INPUT_MESSAGE = 'cw_xhs_cdp_input'
export const XHS_INPUT_SLOT = 'eo2.xhs.cdp-input'
export const XHS_INPUT_RESPONSE = 'cw_xhs_cdp_input_response'
export const XHS_OPERATION_TIMEOUT_MS = 300_000 // Upstream Publish uses a 300-second context.
export const isXhsPreparationTool = (name: string) => name === 'xhs_publish_content' || name === 'xhs_publish_video'
// Port humanize/provider.go's bounded log-normal timings for shared input.
export function sampleInputTiming(mu: number, sigma: number, min: number, max: number): number {
  const normal = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
  return Math.max(min, Math.min(max, Math.exp(mu + sigma * normal) * 1000))
}
export type XhsInputOperation =
  | { kind: 'click'; element: string }
  | { kind: 'type'; element: string; text: string; append: boolean }
  | { kind: 'key'; key: 'Enter' | 'Escape' | 'ArrowDown'; element?: string }
  | { kind: 'click-point'; x: number; y: number }
export interface XhsInputRequest {
  type: typeof XHS_INPUT_MESSAGE
  session: string
  requestId: string
  operation: XhsInputOperation
}
export function isXhsInputRequest(value: unknown): value is XhsInputRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<XhsInputRequest>, op = request.operation
  if (request.type !== XHS_INPUT_MESSAGE || typeof request.session !== 'string' || typeof request.requestId !== 'string' || !op) return false
  if (op.kind === 'click') return typeof op.element === 'string'
  if (op.kind === 'type') return typeof op.element === 'string' && typeof op.text === 'string' && typeof op.append === 'boolean'
  if (op.kind === 'key') return (op.key === 'Enter' || op.key === 'Escape' || op.key === 'ArrowDown') && (op.element === undefined || typeof op.element === 'string')
  return op.kind === 'click-point' && Number.isFinite(op.x) && Number.isFinite(op.y)
}
