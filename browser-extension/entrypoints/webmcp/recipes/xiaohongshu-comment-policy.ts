// Port loading defaults and decisions from xpzouying/xiaohongshu-mcp/feed_detail.go.
// Browser actions stay in xiaohongshu-comments.ts; Go/Rod actions require tab adaptation.
export const COMMENT_POLICY = {
  parentTarget: 20,
  replyLimit: 10,
  clickAttempts: 3,
  clickRetryMs: 100,
  buttonClickInterval: 3,
  largeScrollTrigger: 5,
  stagnantLimit: 20,
  minScrollDelta: 10,
  // The EO2 relay times out after 60s. Yield progress before that boundary.
  callBudgetMs: 50_000,
} as const

export type CommentScrollSpeed = 'slow' | 'normal' | 'fast'

export function normalizeCommentTarget(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null
  // Upstream normalizes nonpositive config values to defaults, not unlimited.
  return value <= 0 ? fallback : value
}

export function skipReplyControl(text: string, threshold: number): boolean {
  const match = /^展开\s*(\d+)\s*条\s*回复$/.exec(text)
  return !!match && Number(match[1]) > threshold
}

export function commentScrollDelta(viewportHeight: number, speed: CommentScrollSpeed, large: boolean): number {
  const ratio = (speed === 'slow' ? 0.5 : speed === 'fast' ? 0.9 : 0.7) * (large ? 2 : 1)
  const delta = Math.max(400, viewportHeight * (ratio + Math.random() * 0.2))
  return delta + Math.floor(Math.random() * 100) - 50
}

export function commentScrollNotch(): number { return 100 + Math.random() * 40 }
export function commentScrollInterval(): number { return 20 + Math.floor(Math.random() * 45) }
