// Internal transport only: input is scoped to an existing authorized tool invocation.
export const XHS_INPUT_MESSAGE = 'cw_xhs_cdp_input'
export const XHS_INPUT_SLOT = 'eo2.xhs.cdp-input'
export const XHS_INPUT_RESPONSE = 'cw_xhs_cdp_input_response'
export const XHS_OPERATION_TIMEOUT_MS = 300_000 // Upstream Publish uses a 300-second context.
export const isXhsPreparationTool = (name: string) => name === 'xhs_publish_content' || name === 'xhs_publish_video'
export const XHS_COMMENT_TIMEOUT_MS = 60_000 // Upstream PostComment uses a 60-second page timeout.
export const XHS_REPLY_TIMEOUT_MS = 300_000 // Upstream ReplyToComment uses a five-minute page timeout.
export const isXhsCommentTool = (name: string) => name === 'xhs_post_comment_to_feed' || name === 'xhs_reply_comment_in_feed'
export const XHS_INTERACT_TIMEOUT_MS = 60_000 // Upstream LikeAction uses a 60-second page timeout.
export const isXhsMainSiteInputTool = (name: string) => isXhsCommentTool(name) || name === 'xhs_like_feed'
export const isXhsInputTool = (name: string) => isXhsPreparationTool(name) || isXhsMainSiteInputTool(name)
export const xhsInputTimeout = (name: string) => name === 'xhs_post_comment_to_feed' ? XHS_COMMENT_TIMEOUT_MS : name === 'xhs_like_feed' ? XHS_INTERACT_TIMEOUT_MS : name === 'xhs_reply_comment_in_feed' ? XHS_REPLY_TIMEOUT_MS : XHS_OPERATION_TIMEOUT_MS
// Port humanize/provider.go's bounded log-normal timings for shared input.
export function sampleInputTiming(mu: number, sigma: number, min: number, max: number): number {
  const normal = Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random())
  return Math.max(min, Math.min(max, Math.exp(mu + sigma * normal) * 1000))
}
export type XhsInputOperation =
  | { kind: 'click'; element: string }
  | { kind: 'scroll-into-view'; element: string }
  | { kind: 'scroll-wheel'; delta: number; element?: string }
  | { kind: 'type'; element: string; text: string; append: boolean; preserveSelection?: boolean }
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
  if (op.kind === 'click' || op.kind === 'scroll-into-view') return typeof op.element === 'string'
  if (op.kind === 'scroll-wheel') return Number.isFinite(op.delta) && (op.element === undefined || typeof op.element === 'string')
  if (op.kind === 'type') return typeof op.element === 'string' && typeof op.text === 'string' && typeof op.append === 'boolean' && (op.preserveSelection === undefined || typeof op.preserveSelection === 'boolean')
  if (op.kind === 'key') return (op.key === 'Enter' || op.key === 'Escape' || op.key === 'ArrowDown') && (op.element === undefined || typeof op.element === 'string')
  return op.kind === 'click-point' && Number.isFinite(op.x) && Number.isFinite(op.y)
}
