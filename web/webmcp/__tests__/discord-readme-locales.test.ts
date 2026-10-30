// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const readmePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../browser-extension/builtin-webmcp/com.discord.main/README.md'
)

type ManifestTool = { name: string }

describe('discord package README locale sections', () => {
  const readme = readFileSync(readmePath, 'utf8')
  const manifest = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../browser-extension/builtin-webmcp/com.discord.main/manifest.json'
      ),
      'utf8'
    )
  ) as { tools: ManifestTool[] }

  it.each(['zh-CN', 'ja-JP', 'ko-KR'] as const)(
    '%s README entries carry the localized translations (not English fallbacks)',
    (locale) => {
      const section = (readme.split(`### ${locale}`)[1] ?? '').split(/\n### /)[0]
      expect(section, locale).not.toBe('')
      for (const tool of manifest.tools) {
        const line = section
          .split('\n')
          .find((l) => l.startsWith(`- \`${tool.name}\`:`))
        expect(line, `${locale} ${tool.name} entry`).toBeDefined()
        const description = line!.slice(`- \`${tool.name}\`:`.length).trim()
        expect(description.length, `${locale} ${tool.name} description`).toBeGreaterThan(0)
        expect(
          description,
          `${locale} ${tool.name} description`
        ).toMatch(/[^\x00-\x7F]/)
        // Locale-specific guard: en-US text appearing in a non-English locale
        // section means a translation was lost to the English fallback.
        const enSection = (readme.split('### en-US')[1] ?? '').split(/\n### /)[0]
        const enLine = enSection
          .split('\n')
          .find((l) => l.startsWith(`- \`${tool.name}\`:`))
        expect(enLine, `en-US ${tool.name} entry`).toBeDefined()
        const enDescription = enLine!.slice(`- \`${tool.name}\`:`.length).trim()
        expect(description, `${locale} ${tool.name} not English`).not.toBe(
          enDescription
        )
      }
    }
  )
})
