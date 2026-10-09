/** JSON-only messages shared by the page proxy, extension and workspace host. */
export const ADAPTER_HOST_PORT = 'cw_adapter_host'
export const ADAPTER_HOST_MARKER = '__cwAdapterHost'
export const ADAPTER_PAGE_MARKER = '__cwAdapterPage'
export const ADAPTER_TIMEOUT_MS = 55_000
export const ADAPTER_TRANSFER_BYTES = 8 * 1024 * 1024

export interface AdapterDescriptor {
  routeId: string
  name: string
  description: string
  urlRegex: string
  inputSchema: Record<string, unknown>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseDescriptors(value: unknown): AdapterDescriptor[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid adapter catalog')
  const names = new Set<string>()
  return value.map(item => {
    if (!isRecord(item) || !['routeId', 'name', 'description', 'urlRegex'].every(key => typeof item[key] === 'string') || !isRecord(item.inputSchema))
      throw new Error('Invalid adapter descriptor')
    if (names.has(item.name as string)) throw new Error('Ambiguous adapter host')
    names.add(item.name as string)
    return { routeId: item.routeId, name: item.name, description: item.description, urlRegex: item.urlRegex, inputSchema: item.inputSchema } as AdapterDescriptor
  })
}
