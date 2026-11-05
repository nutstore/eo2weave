/**
 * Tests for the aggregated bundle-update consent logic (#183).
 *
 * A bundle ZIP install used to overwrite every installed sibling whose store
 * version is newer, with no prompt. The install flow now enumerates those
 * siblings BEFORE writing, asks once, and skips whatever the user declines.
 */

import { describe, expect, it } from 'vitest'
import {
  collectBundleUpdateCandidates,
  resolveBundleUpdateConsent,
  type BundleMemberUpdateFacts,
} from '@/skills/bundle-update-consent'

const members = (...specs: Array<[string, string | null]>): BundleMemberUpdateFacts[] =>
  specs.map(([dirName, storeVersion]) => ({ dirName, storeVersion }))

describe('collectBundleUpdateCandidates (#183)', () => {
  it('lists installed members whose store version is newer, excluding the selected entry', () => {
    const candidates = collectBundleUpdateCandidates(
      members(
        ['entry-skill', '1.2.0'], // the skill the user asked for — already consented
        ['sibling-newer', '2.0.0'], // installed 1.0.0 → would be overwritten
        ['sibling-current', '1.0.0'], // same version — nothing to consent to
        ['sibling-newer-local', '1.0.0'], // local copy is newer — never downgraded
        ['not-installed', '3.0.0'], // fresh install — no local copy to lose
      ),
      new Map<string, string | null>([
        ['entry-skill', '1.0.0'],
        ['sibling-newer', '1.0.0'],
        ['sibling-current', '1.0.0'],
        ['sibling-newer-local', '2.0.0'],
        ['not-installed', null],
      ]),
      'entry-skill',
    )

    expect(candidates).toEqual([
      { dirName: 'sibling-newer', installedVersion: '1.0.0', storeVersion: '2.0.0' },
    ])
  })

  it('treats an unknown version on either side as not updatable', () => {
    const candidates = collectBundleUpdateCandidates(
      members(['no-store-version', null], ['junk-store-version', 'not-a-version']),
      new Map<string, string | null>([
        ['no-store-version', '1.0.0'],
        ['junk-store-version', '1.0.0'],
      ]),
    )
    expect(candidates).toEqual([])
  })

  it('includes every updatable member when no entry was selected', () => {
    const candidates = collectBundleUpdateCandidates(
      members(['alpha', '2.0.0'], ['beta', '3.0.0']),
      new Map<string, string | null>([
        ['alpha', '1.0.0'],
        ['beta', '2.0.0'],
      ]),
    )
    expect(candidates.map((c) => c.dirName)).toEqual(['alpha', 'beta'])
  })
})

describe('resolveBundleUpdateConsent (#183)', () => {
  const candidates = [
    { dirName: 'alpha', installedVersion: '1.0.0', storeVersion: '2.0.0' },
    { dirName: 'beta', installedVersion: '1.0.0', storeVersion: '2.0.0' },
  ]

  it('splits approved and skipped members', () => {
    expect(resolveBundleUpdateConsent(candidates, ['beta'])).toEqual({
      approved: ['beta'],
      skipped: ['alpha'],
    })
  })

  it('skips everything when the user declines or the prompt is dismissed', () => {
    expect(resolveBundleUpdateConsent(candidates, [])).toEqual({
      approved: [],
      skipped: ['alpha', 'beta'],
    })
  })

  it('ignores approvals that are not candidates', () => {
    expect(resolveBundleUpdateConsent(candidates, ['alpha', 'unrelated'])).toEqual({
      approved: ['alpha'],
      skipped: ['beta'],
    })
  })
})
