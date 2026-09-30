import content from '../builtin-packages/webmcp-creator/SKILL.md?raw'
import { expect, it } from 'vitest'
import { parseSkillMd } from '../skill-parser'
import { validatePackage } from '@creatorweave/shared/webmcp-adapter'

it('loads the creator skill and validates its documented adapter example', () => {
  const parsed = parseSkillMd(content)
  expect(parsed.error).toBeUndefined()
  expect(parsed.skill?.name).toBe('cw-webmcp-creator')
  const metadata = JSON.parse(content.match(/```json\n([\s\S]*?)\n```/)![1])
  const source = content.match(/```js\n([\s\S]*?)\n```/)![1]
  expect(validatePackage(metadata, { 'read-title.js': source }, metadata.id).manifest.tools[0].name).toBe('read-title')
})
