export const WEBMCP_ACTIVATIONS = ['enabled', 'disabled'] as const
export type WebMCPActivation = typeof WEBMCP_ACTIVATIONS[number]
export interface WebMCPConfig { activation?: WebMCPActivation }

/** Absence is disabled; malformed configuration never silently enables a package. */
export function parseWebMCPConfig(value: unknown): WebMCPConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('config.json must be an object')
  const config = value as Record<string, unknown>
  if (Object.keys(config).some(key => key !== 'activation')) throw new Error('Unknown config.json field')
  if ('activation' in config && !WEBMCP_ACTIVATIONS.includes(config.activation as WebMCPActivation))
    throw new Error('activation must be enabled or disabled')
  return 'activation' in config ? { activation: config.activation as WebMCPActivation } : {}
}

export function resolveWebMCPConfig(config: WebMCPConfig): Required<WebMCPConfig> {
  return { activation: config.activation ?? 'disabled' }
}
export function serializeWebMCPConfig(config: WebMCPConfig): string {
  return JSON.stringify(parseWebMCPConfig(config), null, 2) + '\n'
}
