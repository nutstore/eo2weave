/**
 * Encrypted API Key storage using Web Crypto API + SQLite.
 * Keys are encrypted with a device-derived key before storage.
 *
 * SQLite version - using unified SQLite storage.
 */

import { getApiKeyRepository, initSQLiteDB } from '@/sqlite'
import { notifyApiKeyChanged } from '@/security/api-key-change'

let initPromise: Promise<void> | null = null

/**
 * Retry policy for transient SQLite worker init races (e.g. OPFS lock not yet
 * released by a previous tab, worker handshake after a cold start).  Without
 * retry, the first concurrent caller sees "Database not initialized" and the
 * error silently degrades to "key not configured" in the UI — users perceive
 * this as data loss.
 */
const INIT_RETRY_DELAYS_MS = [200, 500, 1500]

/**
 * Initialize SQLite for API keys.
 *
 * Retries up to 3 times with exponential backoff because the OPFS-backed
 * SQLite worker occasionally rejects the first `init` message during cold
 * start or right after a tab-switch — the second attempt almost always
 * succeeds.  On any attempt failure, the cached promise is cleared so the
 * next caller can re-attempt cleanly.
 */
async function ensureInitialized(): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt <= INIT_RETRY_DELAYS_MS.length; attempt++) {
    if (initPromise) return initPromise

    initPromise = (async () => {
      try {
        await initSQLiteDB()
      } catch (error) {
        // Clear promise on error so subsequent callers (including the next
        // retry iteration) start fresh.
        initPromise = null
        throw error
      }
    })()

    try {
      return await initPromise
    } catch (error) {
      lastError = error
      // Backoff before the next attempt; the last iteration's await below
      // is harmless because we exit immediately after.
      if (attempt < INIT_RETRY_DELAYS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, INIT_RETRY_DELAYS_MS[attempt]))
      }
    }
  }
  throw lastError
}

/** Save an API key (encrypted) */
export async function saveApiKey(provider: string, apiKey: string): Promise<void> {
  await ensureInitialized()
  const repo = getApiKeyRepository()
  await repo.save(provider, apiKey)
  notifyApiKeyChanged(provider)
}

/** Load an API key (decrypted) */
export async function loadApiKey(provider: string): Promise<string | null> {
  await ensureInitialized()
  const repo = getApiKeyRepository()
  return await repo.load(provider)
}

/** Delete an API key */
export async function deleteApiKey(provider: string): Promise<void> {
  await ensureInitialized()
  const repo = getApiKeyRepository()
  await repo.delete(provider)
  notifyApiKeyChanged(provider)
}

/** Check if an API key exists for a provider */
export async function hasApiKey(provider: string): Promise<boolean> {
  await ensureInitialized()
  const repo = getApiKeyRepository()
  return await repo.has(provider)
}

/** Get all providers with stored keys */
export async function getAllApiKeyProviders(): Promise<string[]> {
  await ensureInitialized()
  const repo = getApiKeyRepository()
  return await repo.getAllProviders()
}
