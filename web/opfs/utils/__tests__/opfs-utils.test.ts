/**
 * OPFS Utility Functions Unit Tests
 */

import { describe, it, expect } from 'vitest'
import {
  encodePath,
  decodePath,
  calculateHash,
  getFileContentType,
  isImageFile,
  isPdfFile,
  estimateWriteSize,
  formatBytes,
  formatRelativeTime,
  isContentEqual,
  getFileExtension,
  getFileName,
  normalizePath,
  joinPath,
  getDirectoryPath,
  generateId,
  safeJsonParse,
  getStorageStatus,
} from '../opfs-utils'
import type { StorageEstimate } from '../../types/opfs-types'

describe('opfs-utils', () => {
  describe('encodePath / decodePath', () => {
    it('should encode and decode simple paths', () => {
      const path = 'src/utils.ts'
      const encoded = encodePath(path)
      expect(decodePath(encoded)).toBe(path)
    })

    it('should handle special characters', () => {
      const path = 'src/file with spaces.ts'
      const encoded = encodePath(path)
      expect(decodePath(encoded)).toBe(path)
    })

    it('should handle unicode characters', () => {
      const path = 'src/文件名.ts'
      const encoded = encodePath(path)
      expect(decodePath(encoded)).toBe(path)
    })

    it('should normalize backslashes', () => {
      const path = 'src\\utils\\file.ts'
      const encoded = encodePath(path)
      const decoded = decodePath(encoded)
      expect(decoded).toBe('src/utils/file.ts')
    })

    it('should handle nested paths', () => {
      const path = 'src/components/header/Header.tsx'
      const encoded = encodePath(path)
      expect(decodePath(encoded)).toBe(path)
    })
  })

  describe('calculateHash', () => {
    it('should produce consistent hashes for same content', async () => {
      const content = 'Hello, World!'
      const hash1 = await calculateHash(content)
      const hash2 = await calculateHash(content)
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should produce different hashes for different content', async () => {
      const hash1 = await calculateHash('Hello')
      const hash2 = await calculateHash('World')
      expect(hash1).not.toBe(hash2)
    })

    it('should handle empty string', async () => {
      const hash = await calculateHash('')
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should handle ArrayBuffer', async () => {
      const buffer = new TextEncoder().encode('test').buffer as ArrayBuffer
      const hash = await calculateHash(buffer)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })

    it('should handle Blob', async () => {
      const blob = new Blob(['test'], { type: 'text/plain' })
      const hash = await calculateHash(blob)
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    })
  })

  describe('getFileContentType', () => {
    it('should detect text files', () => {
      expect(getFileContentType('file.ts')).toBe('text')
      expect(getFileContentType('file.txt')).toBe('text')
      expect(getFileContentType('file.md')).toBe('text')
      expect(getFileContentType('file.json')).toBe('text')
      expect(getFileContentType('file.css')).toBe('text')
      expect(getFileContentType('file.scss')).toBe('text')
      expect(getFileContentType('file.html')).toBe('text')
      expect(getFileContentType('file.svg')).toBe('text')
      expect(getFileContentType('file.yml')).toBe('text')
      expect(getFileContentType('file.env')).toBe('text')
      // Programming languages
      expect(getFileContentType('file.py')).toBe('text')
      expect(getFileContentType('file.pyi')).toBe('text')
      expect(getFileContentType('file.rs')).toBe('text')
      expect(getFileContentType('file.go')).toBe('text')
      expect(getFileContentType('file.java')).toBe('text')
      expect(getFileContentType('file.c')).toBe('text')
      expect(getFileContentType('file.cpp')).toBe('text')
      expect(getFileContentType('file.h')).toBe('text')
      expect(getFileContentType('file.rb')).toBe('text')
      expect(getFileContentType('file.php')).toBe('text')
      expect(getFileContentType('file.sh')).toBe('text')
      expect(getFileContentType('file.sql')).toBe('text')
      expect(getFileContentType('file.dart')).toBe('text')
      expect(getFileContentType('file.swift')).toBe('text')
      expect(getFileContentType('file.kt')).toBe('text')
      expect(getFileContentType('file.scala')).toBe('text')
      expect(getFileContentType('file.lua')).toBe('text')
      expect(getFileContentType('file.vue')).toBe('text')
      expect(getFileContentType('file.svelte')).toBe('text')
      // Mini program files
      expect(getFileContentType('page.wxml')).toBe('text')
      expect(getFileContentType('style.wxss')).toBe('text')
      expect(getFileContentType('filter.wxs')).toBe('text')
      expect(getFileContentType('page.axml')).toBe('text')
      expect(getFileContentType('style.acss')).toBe('text')
      expect(getFileContentType('page.swan')).toBe('text')
    })

    it('should detect binary files', () => {
      expect(getFileContentType('image.png')).toBe('binary')
      expect(getFileContentType('data.bin')).toBe('binary')
      expect(getFileContentType('file.pdf')).toBe('binary')
      expect(getFileContentType('file.zip')).toBe('binary')
    })

    it('should handle files without extension', () => {
      expect(getFileContentType('Makefile')).toBe('text')
      expect(getFileContentType('Dockerfile')).toBe('text')
      expect(getFileContentType('Jenkinsfile')).toBe('text')
      expect(getFileContentType('ci/Jenkinsfile')).toBe('text')
      expect(getFileContentType('Gemfile')).toBe('text')
      expect(getFileContentType('README')).toBe('text')
      expect(getFileContentType('LICENSE')).toBe('text')
      expect(getFileContentType('src/Makefile')).toBe('text')
    })

    it('should detect dockerfile/jenkinsfile alias extensions as text', () => {
      expect(getFileContentType('app.Dockerfile')).toBe('text')
      expect(getFileContentType('app.dockerfile')).toBe('text')
      expect(getFileContentType('pipeline.jenkinsfile')).toBe('text')
    })
  })

  describe('isImageFile', () => {
    it('should detect image files', () => {
      expect(isImageFile('image.png')).toBe(true)
      expect(isImageFile('photo.jpg')).toBe(true)
      expect(isImageFile('picture.jpeg')).toBe(true)
      expect(isImageFile('animation.gif')).toBe(true)
      expect(isImageFile('vector.svg')).toBe(true)
      expect(isImageFile('icon.ico')).toBe(true)
    })

    it('should reject non-image files', () => {
      expect(isImageFile('document.pdf')).toBe(false)
      expect(isImageFile('file.txt')).toBe(false)
      expect(isImageFile('file.ts')).toBe(false)
    })
  })

  describe('isPdfFile', () => {
    it('should detect PDF files', () => {
      expect(isPdfFile('document.pdf')).toBe(true)
      expect(isPdfFile('/path/to/file.PDF')).toBe(true)
    })

    it('should reject non-PDF files', () => {
      expect(isPdfFile('document.txt')).toBe(false)
      expect(isPdfFile('file.png')).toBe(false)
    })
  })

  describe('formatBytes', () => {
    it('should format bytes correctly', () => {
      expect(formatBytes(0)).toBe('0 B')
      expect(formatBytes(1024)).toBe('1.0 KB')
      expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
      expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB')
      expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
    })

    it('should handle large values', () => {
      expect(formatBytes(10 * 1024 * 1024 * 1024)).toBe('10.0 GB')
      expect(formatBytes(1.5 * 1024 * 1024 * 1024 * 1024)).toBe('1.5 TB')
    })

    it('should handle invalid byte counts', () => {
      expect(formatBytes(-1)).toBe('-1 B')
      expect(formatBytes(NaN)).toBe('0 B')
    })
  })

  describe('formatRelativeTime', () => {
    it('should format recent times', () => {
      const now = Date.now()
      expect(formatRelativeTime(now - 30 * 1000)).toBe('just now')
      expect(formatRelativeTime(now - 2 * 60 * 1000)).toBe('2 minutes ago')
      expect(formatRelativeTime(now - 3 * 60 * 60 * 1000)).toBe('3 hours ago')
      expect(formatRelativeTime(now - 5 * 24 * 60 * 60 * 1000)).toBe('5 days ago')
    })

    it('should format old times as date', () => {
      const oldDate = new Date('2024-01-01').getTime()
      const result = formatRelativeTime(oldDate)
      expect(result).toMatch(/\d{4}/) // Should contain year
    })
  })

  describe('isContentEqual', () => {
    it('should compare string content', async () => {
      const content1 = 'Hello, World!'
      const content2 = 'Hello, World!'
      const content3 = 'Different content'

      await expect(isContentEqual(content1, content2)).resolves.toBe(true)
      await expect(isContentEqual(content1, content3)).resolves.toBe(false)
    })

    it('should compare ArrayBuffer content', async () => {
      const buffer1 = new TextEncoder().encode('test').buffer as ArrayBuffer
      const buffer2 = new TextEncoder().encode('test').buffer as ArrayBuffer
      const buffer3 = new TextEncoder().encode('other').buffer as ArrayBuffer

      await expect(isContentEqual(buffer1, buffer2)).resolves.toBe(true)
      await expect(isContentEqual(buffer1, buffer3)).resolves.toBe(false)
    })
  })

  describe('estimateWriteSize', () => {
    it('should estimate string size', () => {
      const size = estimateWriteSize('hello')
      expect(size).toBeGreaterThan(0)
      expect(size).toBeGreaterThan(5) // Should include overhead
    })

    it('should estimate Blob size', () => {
      const blob = new Blob(['hello world'], { type: 'text/plain' })
      const size = estimateWriteSize(blob)
      expect(size).toBeGreaterThan(0)
    })

    it('should estimate ArrayBuffer size', () => {
      const buffer = new ArrayBuffer(100)
      const size = estimateWriteSize(buffer)
      expect(size).toBeGreaterThan(100) // Should include overhead
    })
  })

  describe('getStorageStatus', () => {
    it('should return normal for low usage', () => {
      const estimate: StorageEstimate = {
        quota: 1000,
        usage: 500,
      }
      expect(getStorageStatus(estimate)).toBe('normal')
    })

    it('should return warning for 70% usage', () => {
      const estimate: StorageEstimate = {
        quota: 1000,
        usage: 700,
      }
      expect(getStorageStatus(estimate)).toBe('warning')
    })

    it('should return urgent for 80% usage', () => {
      const estimate: StorageEstimate = {
        quota: 1000,
        usage: 800,
      }
      expect(getStorageStatus(estimate)).toBe('urgent')
    })

    it('should return critical for 95% usage', () => {
      const estimate: StorageEstimate = {
        quota: 1000,
        usage: 950,
      }
      expect(getStorageStatus(estimate)).toBe('critical')
    })

    it('should return full for 100% usage', () => {
      const estimate: StorageEstimate = {
        quota: 1000,
        usage: 1000,
      }
      expect(getStorageStatus(estimate)).toBe('full')
    })

    it('should return normal for null estimate', () => {
      expect(getStorageStatus(null)).toBe('normal')
    })
  })

  describe('getFileExtension', () => {
    it('should extract file extension', () => {
      expect(getFileExtension('file.ts')).toBe('.ts')
      expect(getFileExtension('file.component.tsx')).toBe('.tsx')
      expect(getFileExtension('archive.tar.gz')).toBe('.gz')
    })

    it('should handle files without extension', () => {
      expect(getFileExtension('Makefile')).toBe('Makefile')
      expect(getFileExtension('Dockerfile')).toBe('Dockerfile')
    })
  })

  describe('getFileName', () => {
    it('should extract file name without extension', () => {
      expect(getFileName('file.ts')).toBe('file')
      expect(getFileName('path/to/file.component.tsx')).toBe('file.component')
    })

    it('should handle files without extension', () => {
      expect(getFileName('Makefile')).toBe('Makefile')
      expect(getFileName('path/to/Dockerfile')).toBe('Dockerfile')
    })
  })

  describe('normalizePath', () => {
    it('should normalize backslashes to forward slashes', () => {
      expect(normalizePath('src\\utils\\file.ts')).toBe('src/utils/file.ts')
    })

    it('should preserve forward slashes', () => {
      expect(normalizePath('src/utils/file.ts')).toBe('src/utils/file.ts')
    })
  })

  describe('joinPath', () => {
    it('should join path parts', () => {
      expect(joinPath('src', 'utils', 'file.ts')).toBe('src/utils/file.ts')
    })

    it('should handle empty parts', () => {
      expect(joinPath('src', '', 'file.ts')).toBe('src/file.ts')
    })

    it('should normalize backslashes', () => {
      expect(joinPath('src\\utils', 'file.ts')).toBe('src/utils/file.ts')
    })
  })

  describe('getDirectoryPath', () => {
    it('should extract directory path', () => {
      expect(getDirectoryPath('src/utils/file.ts')).toBe('src/utils')
    })

    it('should handle root level files', () => {
      expect(getDirectoryPath('file.ts')).toBe('')
    })

    it('should handle nested paths', () => {
      expect(getDirectoryPath('a/b/c/d/file.ts')).toBe('a/b/c/d')
    })
  })

  describe('generateId', () => {
    it('should generate unique IDs', () => {
      const id1 = generateId('test')
      const id2 = generateId('test')
      expect(id1).not.toBe(id2)
    })

    it('should use prefix', () => {
      const id = generateId('prefix')
      expect(id.startsWith('prefix-')).toBe(true)
    })

    it('should use default prefix', () => {
      const id = generateId()
      expect(id.startsWith('id-')).toBe(true)
    })
  })

  describe('safeJsonParse', () => {
    it('should parse valid JSON', () => {
      const result = safeJsonParse('{"key": "value"}', { key: 'default' })
      expect(result).toEqual({ key: 'value' })
    })

    it('should return default value for invalid JSON', () => {
      const result = safeJsonParse('invalid json', { key: 'default' })
      expect(result).toEqual({ key: 'default' })
    })

    it('should handle empty string', () => {
      const result = safeJsonParse('', 'default')
      expect(result).toBe('default')
    })
  })
})
