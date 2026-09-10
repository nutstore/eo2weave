import { deflate, deflateRaw, gzip, inflate, inflateRaw, ungzip, constants } from 'pako'

// Strip Node-only zlib options that pako does not understand (e.g.
// maxOutputLength), keeping the node:zlib API shape intact for callers.
function cleanOptions(options?: Record<string, unknown>) {
  if (!options) return options
  return Object.fromEntries(
    Object.entries(options).filter(([key]) => key !== 'maxOutputLength')
  )
}

export const gunzipSync = (data: Uint8Array, options?: Record<string, unknown>) => ungzip(data, cleanOptions(options))
export const gzipSync = (data: Uint8Array, options?: Record<string, unknown>) => gzip(data, cleanOptions(options))
export const deflateSync = (data: Uint8Array, options?: Record<string, unknown>) => deflate(data, cleanOptions(options))
export const inflateSync = (data: Uint8Array, options?: Record<string, unknown>) => inflate(data, cleanOptions(options))
export const deflateRawSync = (data: Uint8Array, options?: Record<string, unknown>) => deflateRaw(data, cleanOptions(options))
export const inflateRawSync = (data: Uint8Array, options?: Record<string, unknown>) => inflateRaw(data, cleanOptions(options))
export const unzipSync = gunzipSync

const unavailable = (name: string) => () => {
  throw new Error(`node:zlib.${name} is not available in the browser`)
}

export const createGzip = unavailable('createGzip')
export const createGunzip = unavailable('createGunzip')
export const createDeflate = unavailable('createDeflate')
export const createInflate = unavailable('createInflate')
export const createDeflateRaw = unavailable('createDeflateRaw')
export const createInflateRaw = unavailable('createInflateRaw')

export { constants }
