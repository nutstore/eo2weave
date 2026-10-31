import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type QueryResult = Record<string, number | string | null | undefined>

const mocks = vi.hoisted(() => {
  return {
    getMode: vi.fn((): 'opfs' | 'memory' | 'indexeddb-fallback' => 'opfs'),
    getRecoveryStats: vi.fn(() => ({
      count: 0,
      lastRecoveryTime: 0,
      lastRecoveryDate: null,
      cooldownRemaining: 0,
    })),
    queryFirst: vi.fn(async (): Promise<QueryResult> => ({ count: 1 })),
    queryAll: vi.fn(async (): Promise<{ name: string }[]> => []),
    db: {} as Record<string, unknown>,
  }
})

vi.mock('@/sqlite', () => ({
  getSQLiteDB: () => ({
    getMode: mocks.getMode,
    getRecoveryStats: mocks.getRecoveryStats,
    queryFirst: mocks.queryFirst,
    queryAll: mocks.queryAll,
  }),
}))

describe('storage diagnostics', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.getMode.mockReturnValue('opfs')
    mocks.getRecoveryStats.mockReturnValue({
      count: 0,
      lastRecoveryTime: 0,
      lastRecoveryDate: null,
      cooldownRemaining: 0,
    })
    mocks.queryFirst.mockResolvedValue({ count: 1, user_version: 7 })
    mocks.queryAll.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('flags non-opfs mode as a warning', async () => {
    mocks.getMode.mockReturnValue('memory')
    // Provide tables with data so the empty-DB branch doesn't override to 'error'
    mocks.queryAll.mockResolvedValue([
      { name: 'conversations' },
      { name: 'messages' },
    ])
    mocks.queryFirst.mockImplementation(async (sql = '') => {
      if (sql.includes('PRAGMA')) return { user_version: 7 }
      if (sql.startsWith('SELECT 1')) return { ok: 1 }
      return { count: 5 }
    })
    const { runDiagnostics } = await import('@/storage/diagnostics')
    const report = await runDiagnostics()
    expect(report.summary.sqliteMode).toBe('memory')
    const sqliteSection = report.sections.find((s) => s.label === 'SQLite')
    expect(sqliteSection?.status).toBe('warn')
    expect(report.markdown).toMatch(/Expected 'opfs'/)
  })

  it('flags unhealthy SQLite', async () => {
    mocks.queryFirst.mockRejectedValueOnce(new Error('boom'))
    // Health probe then all subsequent queryFirst calls should still be tolerated.
    mocks.queryFirst.mockResolvedValue({ count: 1, user_version: 7 })
    const { runDiagnostics } = await import('@/storage/diagnostics')
    const report = await runDiagnostics()
    const sqliteSection = report.sections.find((s) => s.label === 'SQLite')
    expect(sqliteSection?.status).toBe('error')
    expect(report.markdown).toMatch(/Health check: ❌/)
  })

  it('flags missing crossOriginIsolated', async () => {
    const original = (self as { crossOriginIsolated?: boolean }).crossOriginIsolated
    Object.defineProperty(self, 'crossOriginIsolated', {
      value: false,
      configurable: true,
    })
    try {
      const { runDiagnostics } = await import('@/storage/diagnostics')
      const report = await runDiagnostics()
      expect(report.summary.crossOriginIsolated).toBe(false)
      const browserSection = report.sections.find((s) => s.label === 'Browser Runtime')
      expect(browserSection?.status).toBe('error')
    } finally {
      Object.defineProperty(self, 'crossOriginIsolated', {
        value: original,
        configurable: true,
      })
    }
  })

  it('renders markdown with all sections', async () => {
    const { runDiagnostics } = await import('@/storage/diagnostics')
    const report = await runDiagnostics()
    expect(report.markdown).toContain('# 怡氧知知诊断报告')
    expect(report.markdown).toContain('## SQLite')
    expect(report.markdown).toContain('## Project Store Init')
    expect(report.markdown).toContain('## Browser Runtime')
    expect(report.markdown).toContain('## Storage Quota')
    expect(report.markdown).toContain('## Service Worker')
    expect(report.markdown).toContain('## Environment')
    expect(report.markdown).toContain('请把以上内容完整复制给开发者')
  })

  it('includes the persisted project-store init failure when present', async () => {
    // Sourcery: a saved init failure (sessionStorage) must appear in the
    // report users attach to bug reports — it is the primary signal for
    // "blank projects page" reports.
    sessionStorage.setItem(
      'creatorweave:project-store-init-error',
      JSON.stringify({ message: 'OPFS pool busy', kind: 'transient', at: '2026-10-30T10:00:00.000Z' })
    )
    try {
      const { runDiagnostics } = await import('@/storage/diagnostics')
      const report = await runDiagnostics()
      const section = report.sections.find((s) => s.label === 'Project Store Init')
      expect(section?.status).toBe('error')
      expect(section?.lines.join('\n')).toContain('OPFS pool busy')
      expect(report.summary.projectStoreInitFailed).toBe(true)
      expect(report.markdown).toContain('OPFS pool busy')
    } finally {
      sessionStorage.removeItem('creatorweave:project-store-init-error')
    }
  })

  it('marks the project-store init section clean when no failure is recorded', async () => {
    sessionStorage.removeItem('creatorweave:project-store-init-error')
    const { runDiagnostics } = await import('@/storage/diagnostics')
    const report = await runDiagnostics()
    const section = report.sections.find((s) => s.label === 'Project Store Init')
    expect(section?.status).toBe('info')
    expect(report.summary.projectStoreInitFailed).toBe(false)
  })
})
