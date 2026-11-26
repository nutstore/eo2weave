/**
 * Decide which error banner (if any) the composer shows above the input
 * (issue #370). Kept as a pure function so the dismissal rules are unit
 * testable without rendering ConversationView.
 */
export interface ErrorBannerInput {
  /** Runtime error for the active conversation (already trimmed upstream), if any. */
  conversationError: string | null
  /** Error carried by the last persisted failed/empty turn; pass null while a run is active. */
  persistedRetryError: string | null
  /** Error string the user dismissed for the current run. */
  dismissedError: string | null
}

/**
 * Returns the error text to render, or null when no banner should show.
 * A dismissal hides exactly the string it was clicked on — the persisted
 * fallback stays dismissible too, and any other failure still shows.
 */
export function resolveErrorBanner({
  conversationError,
  persistedRetryError,
  dismissedError,
}: ErrorBannerInput): string | null {
  const bannerError = conversationError ?? persistedRetryError
  if (!bannerError) return null
  if (dismissedError && dismissedError.trim() === bannerError.trim()) return null
  return bannerError
}
