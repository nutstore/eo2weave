import { describe, expect, it } from 'vitest'
import { parseDescriptionI18nFromSkillMd, parseSkillMd, serializeSkillMd } from '../skill-parser'

/** Build a SKILL.md document from a frontmatter block + body. */
function doc(yamlBlock: string, body = '# Instruction\n\nDo things.'): string {
  return `---\n${yamlBlock}---\n\n${body}\n`
}

describe('parseSkillMd — hand-written YAML tolerance (repair path)', () => {
  it('parses an unquoted description containing ": " instead of failing', () => {
    const result = parseSkillMd(
      doc('name: my-skill\ndescription: Use this when: the user asks about X\n')
    )
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe('Use this when: the user asks about X')
  })

  it('parses an unquoted description ending with a colon', () => {
    const result = parseSkillMd(doc('name: my-skill\ndescription: Steps follow:\n'))
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe('Steps follow:')
  })

  it('repairs naively nested double quotes', () => {
    const result = parseSkillMd(doc('name: my-skill\ndescription: "say "hi" now"\n'))
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe('say "hi" now')
  })

  it('repairs naively nested single quotes', () => {
    const result = parseSkillMd(doc("name: my-skill\ndescription: 'it's here'\n"))
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe("it's here")
  })

  it('keeps an inline # as literal text instead of a comment when repairing', () => {
    // Strict YAML would silently truncate at the #; combined with the ": "
    // the block fails strict parsing, so the repair must keep the full text.
    const result = parseSkillMd(doc('name: my-skill\ndescription: Note: use #2 pencils\n'))
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe('Note: use #2 pencils')
  })

  it('repairs keys with dashes/dots and preserves lead indentation', () => {
    const result = parseSkillMd(
      doc('name: my-skill\nmy-key: broken: yes\n')
    )
    expect(result.skill).not.toBeNull()
    // Unknown keys are ignored by the mapper, but the file must still parse.
  })

  it('preserves boolean and array fields while repairing a sibling line', () => {
    const result = parseSkillMd(
      doc(
        'name: my-skill\ndescription: Use when: X\ntriggers:\n  keywords: [alpha, beta]\n'
      )
    )
    expect(result.skill).not.toBeNull()
    expect(result.skill!.triggers.keywords).toEqual(['alpha', 'beta'])
  })

  it('preserves secrets (compact and detailed) while repairing a sibling line', () => {
    const result = parseSkillMd(
      doc(
        'name: my-skill\ndescription: Use when: X\nsecrets:\n  - name: API_KEY\n    description: The: main token\n    required: false\n'
      )
    )
    expect(result.skill).not.toBeNull()
    expect(result.skill!.secrets).toEqual([
      { name: 'API_KEY', description: 'The: main token', required: false },
    ])
  })

  it('leaves block scalars untouched (no re-quoting of block content)', () => {
    const yaml = [
      'name: my-skill',
      'description: >',
      '  A long: description',
      '  spanning lines',
    ].join('\n')
    const result = parseSkillMd(doc(yaml + '\n'))
    expect(result.skill).not.toBeNull()
    // Folded scalar keeps the trailing newline per YAML folding semantics.
    expect(result.skill!.description).toBe('A long: description spanning lines\n')
  })
})

describe('parseSkillMd — strict path unaffected', () => {
  it('parses a fully valid frontmatter without repair', () => {
    const result = parseSkillMd(
      doc(
        'name: my-skill\nversion: "1.2.3"\ndescription: "A: fine description"\ntags: [a, b]\n'
      )
    )
    expect(result.skill).not.toBeNull()
    expect(result.skill!.version).toBe('1.2.3')
    expect(result.skill!.description).toBe('A: fine description')
    expect(result.skill!.tags).toEqual(['a', 'b'])
  })

  it('parses colon-without-space scalars as plain YAML (no repair needed)', () => {
    const result = parseSkillMd(doc('name: my-skill\ndescription: Ratio 3:1 works\n'))
    expect(result.skill).not.toBeNull()
    expect(result.skill!.description).toBe('Ratio 3:1 works')
  })

  it('still reports an error with an actionable hint for unfixable YAML', () => {
    // An unclosed flow sequence is not repairable by re-quoting — the repair
    // must leave it alone and the parser must surface an actionable error.
    const result = parseSkillMd(doc('name: my-skill\ndescription: [a, b\n'))
    expect(result.skill).toBeNull()
    expect(result.error).toContain('YAML frontmatter parse error')
    expect(result.error).toContain('Hint:')
  })
})

describe('parseSkillMd/serializeSkillMd round-trip after repair', () => {
  it('a repaired skill serializes to valid YAML that parses back identically', () => {
    const parsed = parseSkillMd(
      doc('name: my-skill\ndescription: Use when: the "model" says: hi\n')
    )
    expect(parsed.skill).not.toBeNull()

    const serialized = serializeSkillMd(parsed.skill!)
    const reparsed = parseSkillMd(serialized)
    expect(reparsed.skill).not.toBeNull()
    expect(reparsed.skill!.description).toBe('Use when: the "model" says: hi')
    expect(reparsed.skill!.name).toBe('my-skill')
  })
})

describe('parseSkillMd/serializeSkillMd — localized descriptions', () => {
  const withI18n = doc(
    [
      'name: cw-legal-evidence-chain',
      'version: "1.1.3"',
      'description: Use for lawyers evidence-chain work.',
      'description.zh-CN: "面向律师的证据链工作技能。"',
      'description.ja-JP: "弁護士向けの証拠チェーン作業スキル。"',
      'description.ko-KR: "변호사를 위한 증거 사슬 작업 스킬."',
      '',
    ].join('\n'),
  )

  it('collects description.<locale> values into description_i18n', () => {
    const { skill } = parseSkillMd(withI18n)
    expect(skill).not.toBeNull()
    expect(skill!.description).toBe('Use for lawyers evidence-chain work.')
    expect(skill!.description_i18n).toEqual({
      'zh-CN': '面向律师的证据链工作技能。',
      'ja-JP': '弁護士向けの証拠チェーン作業スキル。',
      'ko-KR': '변호사를 위한 증거 사슬 작업 스킬.',
    })
  })

  it('omits description_i18n when the skill ships no translations', () => {
    const { skill } = parseSkillMd(doc('name: plain-skill\ndescription: Only English.\n'))
    expect(skill!.description_i18n).toBeUndefined()
  })

  it('survives a serialize → parse round-trip (editing keeps translations)', () => {
    const { skill } = parseSkillMd(withI18n)
    const reparsed = parseSkillMd(serializeSkillMd(skill!))
    expect(reparsed.skill!.description_i18n).toEqual(skill!.description_i18n)
  })

  it('ignores non-locale keys under the description prefix', () => {
    const { skill } = parseSkillMd(
      doc('name: odd-skill\ndescription: Base.\ndescription.swagger: not a locale\n'),
    )
    expect(skill!.description_i18n).toBeUndefined()
  })
})

describe('parseDescriptionI18n — locale tag coverage', () => {
  it('accepts multi-subtag locales (zh-Hant-TW) without dropping them', () => {
    const { skill } = parseSkillMd(
      doc(
        [
          'name: hant-skill',
          'description: Base description.',
          'description.zh-Hant-TW: "繁體中文描述。"',
          '',
        ].join('\n'),
      ),
    )
    expect(skill!.description_i18n).toEqual({ 'zh-Hant-TW': '繁體中文描述。' })
  })

  it('extracts translations from raw SKILL.md text (SQLite reload path)', () => {
    const raw = doc(
      [
        'name: raw-skill',
        'description: Base.',
        'description.zh-CN: "中文描述。"',
        '',
      ].join('\n'),
    )
    expect(parseDescriptionI18nFromSkillMd(raw)).toEqual({ 'zh-CN': '中文描述。' })
    // Unreadable/absent frontmatter is not an error — just no translations.
    expect(parseDescriptionI18nFromSkillMd('no frontmatter here')).toBeUndefined()
  })
})
