import { describe, expect, it } from 'vitest'
import { legacyWorkspaceLaunch } from '../legacy-workspace-launch'

describe('legacy workspace launch', () => {
  it('preserves extension query parameters', () => {
    expect(legacyWorkspaceLaunch('?source=side_panel&binding=abc&origin=https%3A%2F%2Fexample.com', '')).toBe('/projects?source=side_panel&binding=abc&origin=https%3A%2F%2Fexample.com')
  })
  it('preserves legacy hash query parameters', () => {
    expect(legacyWorkspaceLaunch('', '#/?source=side_panel&binding=abc')).toBe('/projects#/?source=side_panel&binding=abc')
  })
  it('leaves ordinary website visits on the homepage', () => {
    expect(legacyWorkspaceLaunch('', '')).toBeNull()
    expect(legacyWorkspaceLaunch('?utm_source=example', '')).toBeNull()
  })
  it('keeps an existing installed app opening the workspace', () => {
    expect(legacyWorkspaceLaunch('', '', true)).toBe('/projects')
  })
  it('opens legacy new-session shortcuts in the workspace', () => {
    expect(legacyWorkspaceLaunch('?new=true', '')).toBe('/projects?new=true')
  })
})
