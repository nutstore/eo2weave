/**
 * Branch label contract in the sidebar header (issue #234): when space runs
 * out the LABEL truncates, the folder name does not — and the label carries
 * the full ref as a tooltip so a truncated branch is still readable.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { GitBranchBadge } from '@/components/file-viewer/GitBranchBadge'

describe('GitBranchBadge', () => {
  it('shows the full branch ref as the tooltip', () => {
    render(<GitBranchBadge info={{ kind: 'branch', name: 'fix/side-panel-continuous-startup' }} />)
    const badge = screen.getByTitle('fix/side-panel-continuous-startup')
    expect(badge.textContent).toContain('fix/side-panel-continuous-startup')
  })

  it('uses a default cursor so the label is not a text selection target', () => {
    render(<GitBranchBadge info={{ kind: 'branch', name: 'main' }} />)
    const badge = screen.getByTitle('main')
    expect(badge.className).toContain('cursor-default')
    expect(badge.className).toContain('select-none')
  })

  it('labels a detached HEAD with its SHA', () => {
    render(<GitBranchBadge info={{ kind: 'detached', sha: 'abc1234' }} />)
    const badge = screen.getByTitle(/abc1234/)
    expect(badge.textContent).toContain('abc1234')
  })

  it('renders nothing outside a work tree', () => {
    const { container } = render(<GitBranchBadge info={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})
