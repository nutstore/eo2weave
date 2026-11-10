import { describe, expect, it } from 'vitest'
import { getExperienceSite, getMarketingContent } from './content'

describe('regional marketing metadata', () => {
  it('selects the appropriate brand for each region', () => {
    expect(getMarketingContent('cn').brand).toBe('怡氧知知')
    expect(getMarketingContent('global').brand).toBe('EO2Weave')
  })
})

describe('experience site selection', () => {
  it('allows either demo to be previewed on either regional site', () => {
    expect(getExperienceSite('douban', 'global')).toBe('douban')
    expect(getExperienceSite('jmail', 'cn')).toBe('jmail')
  })

  it('falls back to the regional default for absent or unknown values', () => {
    expect(getExperienceSite(undefined, 'cn')).toBe('douban')
    expect(getExperienceSite('unknown', 'global')).toBe('jmail')
    expect(getExperienceSite(['jmail', 'douban'], 'cn')).toBe('douban')
  })
})
