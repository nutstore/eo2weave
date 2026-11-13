/**
 * DeepSeek Provider Helpers
 *
 * DeepSeek (https://api.deepseek.com) is OpenAI-compatible. Models are fetched
 * via the standard /models endpoint (handled by model-fetcher.ts). This module
 * additionally exposes balance queries through the DeepSeek-specific
 * `GET /user/balance` endpoint.
 *
 * Docs: https://api-docs.deepseek.com/zh-cn/api/get-user-balance
 */

import { getProviderConfig } from './types'
import { llmFetch } from '@/agent/llm/llm-fetch'

export const DEEPSEEK_PROVIDER_TYPE = 'deepseek'

/** Official DeepSeek base URL (OpenAI-compatible). */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

// ── Types ───────────────────────────────────────────────────────────────────

export interface DeepSeekBalanceInfo {
  /** Currency, e.g. "CNY" or "USD" */
  currency: string
  /** Total available balance (granted + topped up) */
  total_balance: string
  /** Unexpired granted (free) balance */
  granted_balance: string
  /** Topped-up (paid) balance */
  topped_up_balance: string
}

export interface DeepSeekBalanceResponse {
  is_available: boolean
  balance_infos: DeepSeekBalanceInfo[]
}

// ── Balance query ───────────────────────────────────────────────────────────

/**
 * Query the current account balance for the given DeepSeek API key.
 *
 * Calls `GET {baseURL}/user/balance` with `Authorization: Bearer <apiKey>`.
 * The base URL is resolved from the provider config if not provided, and a
 * trailing `/v1` (if a user configured the alternative DeepSeek base) is
 * stripped because the balance endpoint lives at the root path.
 *
 * @throws Error with a readable message on HTTP failure / invalid shape.
 */
export async function fetchDeepSeekBalance(
  apiKey: string,
  baseUrl?: string,
): Promise<DeepSeekBalanceResponse> {
  const configuredBase =
    baseUrl || getProviderConfig(DEEPSEEK_PROVIDER_TYPE)?.baseURL || DEEPSEEK_BASE_URL

  // Strip trailing slash and any `/v1` suffix — DeepSeek balance endpoint is
  // at the root: /user/balance (not /v1/user/balance).
  const cleanBase = configuredBase.replace(/\/+$/, '').replace(/\/v1$/i, '')

  const url = `${cleanBase}/user/balance`
  const response = await llmFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  })

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`)
  }

  const data = (await response.json()) as Partial<DeepSeekBalanceResponse>

  if (!data || typeof data !== 'object' || !Array.isArray(data.balance_infos)) {
    throw new Error('Unexpected balance response format')
  }

  return data as DeepSeekBalanceResponse
}
