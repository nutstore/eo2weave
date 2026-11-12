import type { AdapterDiagnostics } from '../webmcp/package-client'
import { createSection, t } from './shared'

export function createDiagnosticsSection(host: HTMLElement): {
  render(diagnostics: AdapterDiagnostics): void
  fail(error: unknown): void
} {
  const shell = createSection(host, {
    id: 'diagnostics',
    headingKey: 'webmcpPackagesDiagnosticsTitle',
    hintKey: 'webmcpPackagesDiagnosticsHint',
  })
  shell.root.hidden = true

  return {
    render(diagnostics) {
      shell.error.clear()
      shell.list.replaceChildren()
      const refreshFailed = diagnostics.catalogStatus === 'failed'
      const issueCount = diagnostics.rejected.length + Number(refreshFailed)
      shell.setCount(issueCount)
      shell.root.hidden = issueCount === 0

      if (refreshFailed) {
        const warning = document.createElement('p')
        warning.className = 'error'
        warning.textContent = t('webmcpPackagesDiagnosticsCatalogFailed')
        shell.list.append(warning)
      }

      for (const rejected of diagnostics.rejected) {
        const card = document.createElement('div')
        card.className = 'card pkg'
        const body = document.createElement('div')
        body.className = 'body'
        const id = document.createElement('div')
        id.className = 'name'
        id.textContent = rejected.id
        const reason = document.createElement('p')
        reason.className = 'desc'
        reason.textContent = rejected.reason
        body.append(id, reason)
        card.append(body)
        shell.list.append(card)
      }
    },
    fail(error) {
      shell.root.hidden = false
      shell.list.replaceChildren()
      shell.setCount(0)
      const message = error instanceof Error ? error.message : String(error)
      shell.error.show(`${t('webmcpPackagesDiagnosticsUnavailable')}: ${message}`)
    },
  }
}
