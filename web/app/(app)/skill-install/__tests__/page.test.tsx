/**
 * Tests for the /skill-install promotion landing page (issue #126):
 * param validation (missing / unknown skill → friendly error), the details
 * → install → navigate happy path, and installed-idempotency ("already
 * installed" shows without re-installing).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks ────────────────────────────────────────────────────────────

const routerReplaceMock = vi.fn()

const searchParamsMock = vi.fn<() => URLSearchParams>(() => new URLSearchParams('skill=cw-legal-evidence-chain'))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: routerReplaceMock, push: vi.fn(), back: vi.fn() }),
  usePathname: () => '/skill-install',
  useParams: () => ({}),
  useSearchParams: () => searchParamsMock(),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) =>
    params && 'count' in params ? `${key}:${params.count}` : key,
}))

const fetchSkillStoreManifestMock = vi.fn()
const installSkillFromUrlMock = vi.fn()
const scanInstalledDirNamesMock = vi.fn()

vi.mock('@/skills/skill-store', () => ({
  fetchSkillStoreManifest: (...args: unknown[]) => fetchSkillStoreManifestMock(...(args as [])),
  installSkillFromUrl: (...args: unknown[]) => installSkillFromUrlMock(...(args as [])),
  scanInstalledDirNames: (...args: unknown[]) => scanInstalledDirNamesMock(...(args as [])),
}))

const refreshUserSkillsMock = vi.fn(async () => {})
const getSkillsMock = vi.fn(() => [] as Array<{ id: string; source: string; enabled?: boolean }>)
const setUserSkillEnabledMock = vi.fn()

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: () => ({
    refreshUserSkills: refreshUserSkillsMock,
    getSkills: getSkillsMock,
    setUserSkillEnabled: setUserSkillEnabledMock,
  }),
}))

const checkAiReadinessMock = vi.fn()

vi.mock('@/lib/skill-install-flow', () => ({
  checkAiReadiness: (...args: unknown[]) => checkAiReadinessMock(...(args as [])),
  buildPrefillText: (name: string, prompt?: string | null) =>
    prompt ? `/${name} ${prompt}` : `/${name}`,
  mergePrefillText: (existing: string | null | undefined, prefill: string) =>
    (existing ?? '').trim() ? `${prefill}\n${existing!.trim()}` : prefill,
  pickConversationTarget: vi.fn(() => ({ id: 'recent-conv', created: false })),
  waitForCondition: vi.fn(async () => true),
}))

vi.mock('@/lib/jianguoyun-ai-console', () => ({
  getNutstoreAIConsoleURL: () => 'https://ai.jianguoyun.com',
}))

// Login-phase tests need the gateway branch (device-code login UI), not the
// The test env has no NEXT_PUBLIC_DEPLOY_REGION, so the real module reports
// a non-CN build — the login step (and InlineGatewayLogin) is gated behind
// ENABLE_LLM_GATEWAY. Force the CN build for these tests, via a MUTABLE
// holder so the gateway-disabled branch (aiOpenSettings button) can be
// exercised by flipping the flag inside a single test.
const { deployRegionHolder } = vi.hoisted(() => ({
  deployRegionHolder: { enableGateway: true, isCnBuild: true },
}))
vi.mock('@/lib/deploy-region', () => ({
  get ENABLE_LLM_GATEWAY() {
    return deployRegionHolder.enableGateway
  },
  get IS_CN_BUILD() {
    return deployRegionHolder.isCnBuild
  },
}))

const saveDraftMock = vi.fn()
const inputDraftPeekMock = vi.fn<() => InputDraft | null>(() => null)

// Mutable gateway-login auth state so tests can drive the login-success
// effect (the page keys its post-login behavior on authState.status).
const { gatewayAuthHolder, gatewayLoginMock, gatewayResetMock } = vi.hoisted(() => ({
  gatewayAuthHolder: { state: { status: 'idle' } as { status: string } },
  gatewayLoginMock: vi.fn<() => Promise<boolean>>(),
  gatewayResetMock: vi.fn(),
}))

vi.mock('@/hooks/useGatewayLogin', () => ({
  useGatewayLogin: () => ({
    authState: gatewayAuthHolder.state as unknown as ReturnType<
      (typeof import('@/hooks/useGatewayLogin'))['useGatewayLogin']
    >['authState'],
    isRunning: false,
    login: gatewayLoginMock,
    reset: gatewayResetMock,
  }),
}))

const { setActiveProjectMock, useProjectStoreMock, projectState } = vi.hoisted(() => {
  const projectState = {
    initialized: true,
    activeProjectId: 'proj-1',
    projects: [] as Array<{ id: string }>,
    setActiveProject: null as unknown as (id: string) => Promise<boolean>,
  }
  const useProjectStoreMock = { getState: () => projectState }
  // Mirrors the real store: switching projects updates activeProjectId.
  const setActiveProjectMock = vi.fn(async (id: string) => {
    projectState.activeProjectId = id
    return true
  })
  projectState.setActiveProject = setActiveProjectMock
  return { setActiveProjectMock, useProjectStoreMock, projectState }
})

vi.mock('@/store/input-draft.store', () => ({
  useInputDraftStore: { getState: () => ({ saveDraft: saveDraftMock, peekDraft: () => inputDraftPeekMock() }) },
}))

type InputDraft = { text: string; mentionedAgentIds: string[]; selectedFiles: string[] }

vi.mock('@/store/project.store', () => ({
  useProjectStore: useProjectStoreMock,
}))

vi.mock('@/store/conversation-context.store', () => ({
  useConversationContextStore: {
    getState: () => ({
      initialized: true,
      workspaces: [{ id: 'recent-conv', lastAccessedAt: 99 }],
    }),
  },
}))

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: {
    getState: () => ({ createNew: vi.fn(() => ({ id: 'new-conv' })) }),
  },
}))

vi.mock('@/lib/route-paths', () => ({
  projectWorkspacePath: (projectId: string, workspaceId?: string) =>
    workspaceId ? `/projects/${projectId}/workspaces/${workspaceId}` : `/projects/${projectId}`,
}))

import SkillInstallPage from '@/app/(app)/skill-install/page'

const ENTRY = {
  id: 'cw-legal-evidence-chain',
  name: 'cw-legal-evidence-chain',
  dirName: 'cw-legal-evidence-chain',
  description: "Lawyers' evidence-chain analysis",
  category: 'general',
  tags: ['legal'],
  version: '1.1.2',
  zipUrl: '/skills/cw-legal-evidence-chain.zip',
  fileCount: 4,
}

describe('SkillInstallPage (issue #126)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gatewayLoginMock.mockResolvedValue(true)
    gatewayAuthHolder.state = { status: 'idle' }
    // clearAllMocks keeps implementations — reset the registration cache
    // explicitly so tests start with an EMPTY manager (leftover
    // mockReturnValue from an earlier test would make the already-installed
    // flow skip its refresh-on-miss).
    getSkillsMock.mockReset()
    getSkillsMock.mockReturnValue([])
    setUserSkillEnabledMock.mockReset()
    projectState.initialized = true
    projectState.activeProjectId = 'proj-1'
    projectState.projects = []
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [ENTRY] })
    // The installed-dir scan runs at load (not installed yet).
    scanInstalledDirNamesMock.mockResolvedValue(new Set<string>())
    installSkillFromUrlMock.mockResolvedValue({ count: 4, manifest: ENTRY })
    // Deferred registration: refreshUserSkills must return a PENDING promise
    // first and only then resolve — so call-ORDER assertions below verify
    // the page awaits completion (a missing `await` would navigate before
    // the registration resolved and fail these tests). The skill becomes
    // registered at RESOLUTION time, not when the mock is called.
    let resolveRefresh!: () => void
    refreshUserSkillsMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRefresh = () => {
            getSkillsMock.mockReturnValue([
              { id: `user:${ENTRY.dirName}`, source: 'user', enabled: true },
            ])
            resolve()
          }
        }),
    )
    // Expose the resolver for tests that drive the flow manually.
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh =
      () => resolveRefresh()
    checkAiReadinessMock.mockResolvedValue({ ready: true, creditExhausted: false })
    searchParamsMock.mockReturnValue(new URLSearchParams('skill=cw-legal-evidence-chain'))
  })

  it('unknown skill param shows the friendly error', async () => {
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [] })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.errorTitle')).toBeInTheDocument())
    expect(screen.getByText('skillInstall.notFound')).toBeInTheDocument()
    expect(screen.getByText('skillInstall.openSkillManager')).toBeInTheDocument()
  })

  it('unknown-skill Skill Manager entry routes to the WORKSPACE (the flag consumer), not /projects', async () => {
    // Requirement-5 (Sourcery round-21): the button arms the one-shot
    // `panelState.skillsManagerOpen` request, but only WorkspaceLayout —
    // mounted on /projects/:projectId/** via WorkspaceRouteView — consumes
    // it. /projects renders ProjectHomeView with no layout, so routing
    // there dead-ends the flag (the visitor never reaches the Skill
    // Manager). The bare project URL is used so the store resolves the
    // workspace.
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [] })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.errorTitle')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.openSkillManager'))
    expect(routerReplaceMock).toHaveBeenCalledWith('/projects/proj-1')
    expect(routerReplaceMock).not.toHaveBeenCalledWith('/projects')
  })

  it('error-view manager link: empty-string activeProjectId falls back to the first project (store uses "" not null)', async () => {
    // Sourcery round-22: the project store models "no active project" as
    // the EMPTY STRING — a `??` fallback never fires on '', dropping the
    // first-project resolution and routing to /projects/ (no layout), so
    // the armed flag dead-ends.
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [] })
    projectState.activeProjectId = ''
    projectState.projects = [{ id: 'auto-default' }]
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.errorTitle')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.openSkillManager'))
    await waitFor(() => expect(setActiveProjectMock).toHaveBeenCalledWith('auto-default'))
    expect(routerReplaceMock).toHaveBeenCalledWith('/projects/auto-default')
    expect(routerReplaceMock).not.toHaveBeenCalledWith('/projects')
  })

  it('missing skill param shows the missing-param error (no manifest fetch)', async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams())
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.missingParam')).toBeInTheDocument())
    expect(fetchSkillStoreManifestMock).not.toHaveBeenCalled()
  })

  it('manifest fetch failure shows load-failed with a retry entry', async () => {
    fetchSkillStoreManifestMock.mockRejectedValue(new Error('HTTP 500'))
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('HTTP 500')).toBeInTheDocument())
    expect(screen.getByText('skillInstall.retry')).toBeInTheDocument()
  })

  it('happy path: details → Install (user click) → refreshUserSkills resolves → navigate with prefill', async () => {
    // Both async steps are deferred: the installer and the registration
    // return PENDING promises and are resolved explicitly below. A page
    // that omits an `await` would register/navigate while these are still
    // pending — the assertions verify that navigation happens only after
    // each promise actually resolved.
    let resolveInstall!: () => void
    installSkillFromUrlMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = () => resolve({ count: 4, manifest: ENTRY })
      }),
    )
    render(<SkillInstallPage />)
    // Details render first.
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    const installButton = screen.getByText('skillInstall.installButton')
    fireEvent.click(installButton)

    await waitFor(() => {
      expect(installSkillFromUrlMock).toHaveBeenCalledWith('/skills/cw-legal-evidence-chain.zip', expect.any(Function))
    })
    // While the download is pending, the page must neither register nor navigate.
    expect(refreshUserSkillsMock).not.toHaveBeenCalled()
    expect(routerReplaceMock).not.toHaveBeenCalled()

    resolveInstall()
    // Registration starts only after the installer resolved — and is still
    // pending here: navigation must NOT have happened yet.
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    expect(routerReplaceMock).not.toHaveBeenCalled()

    // Complete the registration; navigation may only follow resolution.
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    // Navigates to the most recent conversation (lastAccessedAt: 99).
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith('/projects/proj-1/workspaces/recent-conv')
    })
    // Prefill was written before navigation.
    expect(saveDraftMock).toHaveBeenCalledWith('recent-conv', {
      text: '/cw-legal-evidence-chain',
      mentionedAgentIds: [],
      selectedFiles: [],
    })
    // Ordering: installation MUST be awaited before registration — refresh
    // may only start after the installer promise resolved.
    expect(refreshUserSkillsMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      installSkillFromUrlMock.mock.invocationCallOrder[0],
    )
    // Ordering: registration MUST complete before navigation — with the
    // pending-then-resolved mock above, a missing `await` would navigate
    // while refreshUserSkills is still pending and fail this check.
    expect(refreshUserSkillsMock.mock.invocationCallOrder[0]).toBeLessThan(
      routerReplaceMock.mock.invocationCallOrder[0],
    )
    // Ordering: the draft write MUST precede router.replace — otherwise a
    // visitor can arrive at the conversation without the prefill (the
    // mocked router does not unmount the page, so "eventually" checks
    // alone would not catch a reordering).
    const draftOrder = saveDraftMock.mock.invocationCallOrder[0]
    const replaceOrder = routerReplaceMock.mock.invocationCallOrder[0]
    expect(draftOrder).toBeLessThan(replaceOrder)
  })

  it('install failure surfaces the error message in the details view', async () => {
    installSkillFromUrlMock.mockRejectedValue(new Error('Download timed out'))
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(screen.getByText('Download timed out')).toBeInTheDocument())
    // Back on the details view with a retry-able button.
    expect(screen.getByText('skillInstall.installButton')).toBeInTheDocument()
  })

  it('treats an unregistered skill as a failed install (no navigation with a dead slash command)', async () => {
    // refreshUserSkills "succeeds" but the scan failed silently — the skill
    // never shows up in getSkills() (also at resolution time), so the page
    // must abort with the registration error instead of navigating.
    refreshUserSkillsMock.mockImplementation(async () => {
      getSkillsMock.mockReturnValue([])
    })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(screen.getByText('skillInstall.registerFailed')).toBeInTheDocument())
    expect(routerReplaceMock).not.toHaveBeenCalled()
  })

  it('zero-credit readiness shows the hint in the details view instead of navigating', async () => {
    checkAiReadinessMock.mockResolvedValue({ ready: true, creditExhausted: true })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    // Install completes, then registration resolves (the mock is
    // pending-then-resolved — see beforeEach).
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => expect(screen.getByText('skillInstall.creditExhausted')).toBeInTheDocument())
    expect(routerReplaceMock).not.toHaveBeenCalled()
    // A follow-up start proceeds to the conversation.
    fireEvent.click(screen.getByText('skillInstall.startUsing'))
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith('/projects/proj-1/workspaces/recent-conv')
    })
  })

  it('fresh session with no active project: falls back to the first project and still navigates', async () => {
    projectState.activeProjectId = ''
    projectState.projects = [{ id: 'auto-default' }]
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    // Registration is pending — navigation must wait for it to resolve.
    expect(routerReplaceMock).not.toHaveBeenCalled()
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => expect(setActiveProjectMock).toHaveBeenCalledWith('auto-default'))
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith('/projects/auto-default/workspaces/recent-conv')
    })
  })

  it('appends the prefill below an existing unsent draft instead of clobbering it', async () => {
    saveDraftMock.mockImplementation(() => {})
    // Pre-seed an existing draft via peekDraft.
    inputDraftPeekMock.mockReturnValue({
      text: 'my unsent question',
      mentionedAgentIds: ['agent-1'],
      selectedFiles: ['a.md'],
    })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => {
      expect(saveDraftMock).toHaveBeenCalledWith('recent-conv', {
        text: '/cw-legal-evidence-chain\nmy unsent question',
        mentionedAgentIds: ['agent-1'],
        selectedFiles: ['a.md'],
      })
    })
    inputDraftPeekMock.mockReturnValue(null)
  })

  it('idempotent for installed skills: no re-install, "already installed" badge, registration verified', async () => {
    scanInstalledDirNamesMock.mockResolvedValue(new Set([ENTRY.dirName]))
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.installedBadge')).toBeInTheDocument())

    // The single click (start) verifies registration (refresh-on-miss) and
    // runs readiness — never a re-install.
    fireEvent.click(screen.getByText('skillInstall.startUsing'))
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    expect(installSkillFromUrlMock).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(checkAiReadinessMock).toHaveBeenCalled()
    })
    await waitFor(() => {
      expect(routerReplaceMock).toHaveBeenCalledWith('/projects/proj-1/workspaces/recent-conv')
    })
  })

  it('already-installed flow aborts with registerFailed when the skill never registers', async () => {
    // Fresh session: the manager cache stays empty even after the refresh —
    // navigation with a dead slash command must NOT happen.
    scanInstalledDirNamesMock.mockResolvedValue(new Set([ENTRY.dirName]))
    // refreshUserSkills "succeeds" but the scan failed silently — the skill
    // never appears in getSkills() even at resolution time.
    refreshUserSkillsMock.mockImplementation(async () => {
      getSkillsMock.mockReturnValue([])
    })
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.installedBadge')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.startUsing'))
    await waitFor(() => expect(screen.getByText('skillInstall.registerFailed')).toBeInTheDocument())
    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(installSkillFromUrlMock).not.toHaveBeenCalled()
  })

  it('normalizes user: skill IDs in the installed-dir fallback (installed skills appear installed)', async () => {
    // The store fallback (OPFS scan failed) returns skill IDs, not dirNames.
    scanInstalledDirNamesMock.mockResolvedValue(new Set([`user:${ENTRY.dirName}`]))
    // getSkills reports the skill as registered so the flow can proceed.
    getSkillsMock.mockReturnValue([{ id: `user:${ENTRY.dirName}`, source: 'user', enabled: true }])
    render(<SkillInstallPage />)
    // With normalization the badge shows; without it the page would render
    // the install button (treating a skill that IS installed as missing).
    await waitFor(() => expect(screen.getByText('skillInstall.installedBadge')).toBeInTheDocument())
  })

  it('resets a stale credit warning when the skill param changes', async () => {
    checkAiReadinessMock.mockResolvedValue({ ready: true, creditExhausted: true })
    const { rerender } = render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => expect(screen.getByText('skillInstall.creditExhausted')).toBeInTheDocument())

    // Visitor changes the skill query → new entry loads; the OLD credit
    // warning must not linger on the new details view.
    checkAiReadinessMock.mockResolvedValue({ ready: true, creditExhausted: false })
    searchParamsMock.mockReturnValue(new URLSearchParams('skill=other-skill'))
    fetchSkillStoreManifestMock.mockResolvedValue({
      skills: [{ ...ENTRY, dirName: 'other-skill', name: 'other-skill', zipUrl: '/skills/other-skill.zip' }],
    })
    // A search-param change only reaches the component on a re-render.
    rerender(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('other-skill')).toBeInTheDocument())
    expect(screen.queryByText('skillInstall.creditExhausted')).not.toBeInTheDocument()
  })

  it('invalidates the pending flow when the prompt param changes (no stale-prefill navigation)', async () => {
    let resolveInstall!: () => void
    installSkillFromUrlMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = () => resolve({ count: 4, manifest: ENTRY })
      }),
    )
    const { rerender } = render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(installSkillFromUrlMock).toHaveBeenCalled())

    // The prompt param changes while the install is pending: the OLD flow
    // must abandon (no navigation, no stale prefill draft).
    searchParamsMock.mockReturnValue(
      new URLSearchParams('skill=cw-legal-evidence-chain&prompt=new-question'),
    )
    rerender(<SkillInstallPage />)
    resolveInstall()
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    // Registration refresh for the abandoned flow still ran (defensive),
    // but navigation must NOT: the flow belongs to the old generation.
    await new Promise((r) => setTimeout(r, 20))
    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(saveDraftMock).not.toHaveBeenCalled()
  })

  it('prompt param is appended to the prefill', async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams('skill=cw-legal-evidence-chain&prompt=整理本案证据'),
    )
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => {
      expect(saveDraftMock).toHaveBeenCalledWith(
        'recent-conv',
        expect.objectContaining({ text: '/cw-legal-evidence-chain 整理本案证据' }),
      )
    })
  })

  it('re-enables an installed-but-disabled skill instead of navigating with a dead command', async () => {
    // Previously installed, then disabled by the visitor: the registration
    // check must notice `enabled: false` and re-enable the skill — not
    // pre-fill the command and navigate into a conversation that cannot
    // use it.
    scanInstalledDirNamesMock.mockResolvedValue(new Set([ENTRY.dirName]))
    getSkillsMock.mockReturnValue([
      { id: `user:${ENTRY.dirName}`, source: 'user', enabled: false },
    ])
    render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('skillInstall.installedBadge')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.startUsing'))
    await waitFor(() => {
      expect(setUserSkillEnabledMock).toHaveBeenCalledWith(`user:${ENTRY.dirName}`, true)
    })
    expect(routerReplaceMock).toHaveBeenCalledWith('/projects/proj-1/workspaces/recent-conv')
  })

  it('re-checks credit after inline login and shows the recharge hint instead of navigating', async () => {
    // Visitor was logged out at page load (readiness → login step); after a
    // successful inline login the readiness re-check finds 0 credit —
    // navigation must wait behind the recharge hint on the details view.
    checkAiReadinessMock
      .mockResolvedValueOnce({ ready: false, creditExhausted: false })
      .mockResolvedValueOnce({ ready: true, creditExhausted: true })
    const result = render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    // The fresh-install path awaits registration before readiness.
    await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
    ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
    await waitFor(() => expect(screen.getByText('skillInstall.aiNotReady')).toBeInTheDocument())
    expect(checkAiReadinessMock).toHaveBeenCalledTimes(1)
    // Simulate the login-success effect: flip the mocked auth state (the
    // hook mock reads the holder on every render) and re-render.
    fireEvent.click(screen.getByText('settings.gateway.login'))
    gatewayAuthHolder.state = { status: 'success' }
    result.rerender(<SkillInstallPage />)
    await waitFor(() => expect(checkAiReadinessMock).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(screen.getByText('skillInstall.creditExhausted')).toBeInTheDocument(),
    )
    expect(routerReplaceMock).not.toHaveBeenCalled()
    gatewayAuthHolder.state = { status: 'idle' }
  })

  it('login-timeout: a stalled gateway login resets the flow with a retryable error', async () => {
    vi.useFakeTimers()
    try {
      checkAiReadinessMock.mockResolvedValue({ ready: false, creditExhausted: false })
      const view = render(<SkillInstallPage />)
      await vi.waitFor(() =>
        expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument(),
      )
      fireEvent.click(screen.getByText('skillInstall.installButton'))
      await vi.waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
      ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
      await vi.waitFor(() =>
        expect(screen.getByText('skillInstall.aiNotReady')).toBeInTheDocument(),
      )
      // Start the (never-settling) login, then advance past the
      // login-request timeout: the UI must leave `requesting` and surface
      // the retryable timeout error instead of pinning the spinner.
      gatewayLoginMock.mockReturnValue(new Promise(() => {}))
      fireEvent.click(screen.getByText('settings.gateway.login'))
      await vi.advanceTimersByTimeAsync(14_999)
      expect(screen.queryByText('skillInstall.loginTimeout')).not.toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() =>
        expect(screen.getByText('skillInstall.loginTimeout')).toBeInTheDocument(),
      )
      // The skip escape remains usable afterwards.
      expect(screen.getAllByText('skillInstall.aiLater').length).toBeGreaterThan(0)
      gatewayAuthHolder.state = { status: 'success' }
      view.rerender(<SkillInstallPage />)
      expect(checkAiReadinessMock).toHaveBeenCalledTimes(1)
      expect(routerReplaceMock).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not time out while the visitor is approving a device code', async () => {
    vi.useFakeTimers()
    try {
      checkAiReadinessMock.mockResolvedValue({ ready: false, creditExhausted: false })
      gatewayLoginMock.mockReturnValue(new Promise(() => {}))
      const view = render(<SkillInstallPage />)
      await vi.waitFor(() => expect(screen.getByText(ENTRY.dirName)).toBeInTheDocument())
      fireEvent.click(screen.getByText('skillInstall.installButton'))
      await vi.waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
      ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
      await vi.waitFor(() => expect(screen.getByText('skillInstall.aiNotReady')).toBeInTheDocument())
      fireEvent.click(screen.getByText('settings.gateway.login'))
      gatewayAuthHolder.state = { status: 'waiting' }
      view.rerender(<SkillInstallPage />)
      await vi.advanceTimersByTimeAsync(16_000)
      expect(screen.queryByText('skillInstall.loginTimeout')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('unmount invalidates the pending flow (no redirect after leaving the page)', async () => {
    // Install is pending when the visitor navigates away: the abandoned
    // flow must never continue into router.replace.
    let resolveInstall!: () => void
    installSkillFromUrlMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInstall = () => resolve({ count: 4, manifest: ENTRY })
      }),
    )
    const { unmount } = render(<SkillInstallPage />)
    await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
    fireEvent.click(screen.getByText('skillInstall.installButton'))
    await waitFor(() => expect(installSkillFromUrlMock).toHaveBeenCalled())
    // Visitor leaves the page mid-install.
    unmount()
    resolveInstall()
    await new Promise((r) => setTimeout(r, 30))
    // The manager-cache refresh is intentional even for abandoned flows
    // (the skill IS on disk) — but navigation and prefill must NOT run:
    // the visitor's route must stay wherever they went.
    expect(routerReplaceMock).not.toHaveBeenCalled()
    expect(saveDraftMock).not.toHaveBeenCalled()
  })

  it('gateway-disabled build: the login view routes to a workspace and arms the settings-open request (LLM tab)', async () => {
    // Sourcery round-22: with ENABLE_LLM_GATEWAY=false the device-code
    // login can never work (no client id) — the "Open AI settings" button
    // must land the visitor on a WorkspaceLayout-consumed surface and
    // arm panelState.settingsOpenRequest so the unified SettingsDialog
    // opens on the LLM tab, instead of dumping them on /projects (no
    // layout, no settings dialog, dead end).
    const { useWorkspacePreferencesStore } = await import(
      '@/store/workspace-preferences.store'
    )
    deployRegionHolder.enableGateway = false
    checkAiReadinessMock.mockResolvedValue({ ready: false, creditExhausted: false })
    projectState.activeProjectId = ''
    projectState.projects = [{ id: 'auto-default' }]
    try {
      render(<SkillInstallPage />)
      await waitFor(() => expect(screen.getByText('cw-legal-evidence-chain')).toBeInTheDocument())
      fireEvent.click(screen.getByText('skillInstall.installButton'))
      await waitFor(() => expect(refreshUserSkillsMock).toHaveBeenCalled())
      ;(refreshUserSkillsMock as unknown as { __resolveRefresh: () => void }).__resolveRefresh()
      await waitFor(() =>
        expect(screen.getByText('skillInstall.aiGatewayUnavailable')).toBeInTheDocument(),
      )
      fireEvent.click(screen.getByText('skillInstall.aiOpenSettings'))
      await waitFor(() => expect(setActiveProjectMock).toHaveBeenCalledWith('auto-default'))
      expect(routerReplaceMock).toHaveBeenCalledWith('/projects/auto-default')
      expect(
        useWorkspacePreferencesStore.getState().panelState.settingsOpenRequest,
      ).toBe(true)
    } finally {
      deployRegionHolder.enableGateway = true
    }
  })
})
