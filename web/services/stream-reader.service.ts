/**
 * Stream Reader Service
 *
 * Provides chunked reading of large files to avoid memory overflow
 * and support streaming plugin processing.
 */

//=============================================================================
// Types
//=============================================================================

/**
 * Stream reader configuration
 */
export interface StreamReaderOptions {
  chunkSize: number // Bytes per chunk (default: 64KB)
  encoding: string // Text encoding (default: utf-8)
  skipBOM?: boolean // Skip UTF-8 BOM if present
}

/**
 * A chunk of data from the stream
 */
export interface StreamChunk {
  index: number
  data: string
  offset: number
  bytes: number
  isLast: boolean
}

/**
 * Stream progress information
 */
export interface StreamProgress {
  file: string
  chunkIndex: number
  totalChunks: number
  bytesProcessed: number
  totalBytes: number
  percentage: number
}

/**
 * Stream reading result
 */
export interface StreamResult {
  file: string
  chunks: number
  totalBytes: number
  duration: number
  data: string // Combined data (for small files)
}

//=============================================================================
// Stream Reader
//=============================================================================

export class StreamReader {
  private defaultOptions: Required<StreamReaderOptions> = {
    chunkSize: 64 * 1024, // 64KB
    encoding: 'utf-8',
    skipBOM: true,
  }

  /**
   * Read a file as an async stream of chunks
   *
   * @param file - File to read
   * @param options - Stream options
   * @yields Stream chunks
   */
  async *readStream(
    file: File,
    options: Partial<StreamReaderOptions> = {}
  ): AsyncGenerator<StreamChunk> {
    const opts = { ...this.defaultOptions, ...options }
    const stream = file.stream()
    const reader = stream.getReader()
    const decoder = new TextDecoder(opts.encoding)

    let index = 0
    let offset = 0
    let skipBOM = opts.skipBOM

    try {
      while (true) {
        const { done, value } = await reader.read()

        if (done) {
          // Final chunk
          yield {
            index,
            data: '',
            offset,
            bytes: 0,
            isLast: true,
          }
          break
        }

        let data = decoder.decode(value, { stream: true })

        // Skip BOM on first chunk
        if (skipBOM && index === 0 && data.startsWith('\uFEFF')) {
          data = data.slice(1)
          skipBOM = false
        }

        yield {
          index,
          data,
          offset,
          bytes: value.length,
          isLast: false,
        }

        offset += value.length
        index++
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * Read a file with a callback for each chunk
   *
   * @param file - File to read
   * @param callback - Callback for each chunk
   * @param options - Stream options
   * @returns Stream result
   */
  async readWithCallback(
    file: File,
    callback: (chunk: StreamChunk) => void | Promise<void>,
    options: Partial<StreamReaderOptions> = {}
  ): Promise<StreamResult> {
    const startTime = Date.now()
    const opts = { ...this.defaultOptions, ...options }
    let totalChunks = 0
    let combinedData = ''

    for await (const chunk of this.readStream(file, opts)) {
      totalChunks++
      if (!chunk.isLast) {
        combinedData += chunk.data
      }
      await callback(chunk)
    }

    return {
      file: file.name,
      chunks: totalChunks,
      totalBytes: file.size,
      duration: Date.now() - startTime,
      data: combinedData,
    }
  }

  /**
   * Read entire file into memory (for small files)
   *
   * @param file - File to read
   * @param options - Stream options
   * @returns File content
   */
  async readAll(file: File, options: Partial<StreamReaderOptions> = {}): Promise<string> {
    const opts = { ...this.defaultOptions, ...options }
    const chunks: string[] = []

    for await (const chunk of this.readStream(file, opts)) {
      if (!chunk.isLast) {
        chunks.push(chunk.data)
      }
    }

    return chunks.join('')
  }

  /**
   * Estimate memory usage for streaming
   *
   * @param _fileSize - Size of file in bytes
   * @param chunkSize - Size of each chunk
   * @returns Estimated memory usage in bytes
   */
  estimateMemoryUsage(_fileSize: number, chunkSize: number): number {
    // Estimate: 2x chunk size for buffer + overhead
    return chunkSize * 2 + 1024 // +1KB overhead
  }

  /**
   * Check if streaming is recommended for a file
   *
   * @param fileSize - Size of file in bytes
   * @param memoryLimit - Available memory in bytes
   * @returns true if streaming recommended
   */
  shouldStream(fileSize: number, memoryLimit = 16 * 1024 * 1024): boolean {
    // Stream if file is > 10% of memory limit
    return fileSize > memoryLimit * 0.1
  }

  /**
   * Get optimal chunk size based on file size and memory limit
   *
   * @param _fileSize - Size of file in bytes
   * @param memoryLimit - Available memory in bytes
   * @returns Optimal chunk size
   */
  getOptimalChunkSize(_fileSize: number, memoryLimit = 16 * 1024 * 1024): number {
    // Use 1/8 of memory limit, min 4KB, max 1MB
    const chunkSize = Math.min(memoryLimit / 8, 1024 * 1024)
    return Math.max(chunkSize, 4 * 1024)
  }

  /**
   * Read file lines (for text files)
   *
   * @param file - File to read
   * @param options - Stream options
   * @yields Lines from the file
   */
  async *readLines(file: File, options: Partial<StreamReaderOptions> = {}): AsyncGenerator<string> {
    let buffer = ''

    for await (const chunk of this.readStream(file, options)) {
      if (chunk.isLast) {
        // Yield remaining buffer
        if (buffer) {
          yield buffer
        }
        break
      }

      buffer += chunk.data

      // Split by newlines
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() || '' // Keep incomplete line in buffer

      for (const line of lines) {
        yield line
      }
    }
  }

  /**
   * Count lines in a file (streaming)
   *
   * @param file - File to count lines in
   * @returns Number of lines
   */
  async countLines(file: File): Promise<number> {
    let count = 0

    for await (const line of this.readLines(file)) {
      void line
      count++
    }

    return count
  }
}

//=============================================================================
// Helper Functions
//=============================================================================

/**
 * Detect file encoding from BOM
 *
 * @param bytes - First bytes of file
 * @returns Detected encoding or null
 */
export function detectEncodingFromBOM(bytes: Uint8Array): string | null {
  if (bytes.length < 2) return null

  // UTF-8 BOM: EF BB BF
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return 'utf-8'
  }

  // UTF-16 LE BOM: FF FE
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return 'utf-16le'
  }

  // UTF-16 BE BOM: FE FF
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return 'utf-16be'
  }

  // UTF-32 LE BOM: FF FE 00 00
  if (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xfe &&
    bytes[2] === 0x00 &&
    bytes[3] === 0x00
  ) {
    return 'utf-32le'
  }

  // UTF-32 BE BOM: 00 00 FE FF
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x00 &&
    bytes[1] === 0x00 &&
    bytes[2] === 0xfe &&
    bytes[3] === 0xff
  ) {
    return 'utf-32be'
  }

  return null
}

/**
 * Format file size for display
 *
 * NOTE (issue #14): intentionally kept local, not switched to the canonical
 * `formatBytes` in `@/lib/utils` — this variant renders EVERY unit with one
 * decimal ("512.0 B", "1.0 KB"), while the canonical keeps byte counts whole
 * ("512 B"), and it caps at GB. Kept for log-line formatting stability.
 *
 * @param bytes - Size in bytes
 * @returns Formatted string
 */
export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Calculate stream progress percentage
 *
 * @param bytesProcessed - Bytes processed so far
 * @param totalBytes - Total bytes to process
 * @returns Percentage (0-100)
 */
export function calculateProgress(bytesProcessed: number, totalBytes: number): number {
  if (totalBytes === 0) return 100
  return Math.min(100, Math.round((bytesProcessed / totalBytes) * 100))
}

//=============================================================================
// Singleton Instance
//=============================================================================

let readerInstance: StreamReader | null = null

export function getStreamReader(): StreamReader {
  if (!readerInstance) {
    readerInstance = new StreamReader()
  }
  return readerInstance
}
