export interface PackageSearch {
  update(row: HTMLElement, fields: string[], toolsKnown?: boolean): void
  /** Recount after a section removes rows, including an empty render. */
  rowsChanged(): void
}

/** Filters the existing package rows without reloading data or rebuilding cards. */
export function createPackageSearch(
  input: HTMLInputElement,
  clear: HTMLButtonElement,
  status: HTMLElement,
  formatStatus: (matched: number, total: number, unknown: number) => string,
): PackageSearch {
  const rows = new Map<HTMLElement, { text: string; toolsKnown: boolean }>()
  let query = input.value.trim().toLowerCase()
  let statusPending = false

  function scheduleStatus(): void {
    if (statusPending) return
    statusPending = true
    queueMicrotask(() => {
      statusPending = false
      let matched = 0
      let unknown = 0
      for (const [row, entry] of rows) {
        if (!row.isConnected) {
          rows.delete(row)
          continue
        }
        if (!row.hidden) matched += 1
        if (!entry.toolsKnown) unknown += 1
      }
      // Keep the live region present so the first result update is announced.
      status.textContent = query ? formatStatus(matched, rows.size, unknown) : ''
    })
  }

  function applyQuery(): void {
    query = input.value.trim().toLowerCase()
    clear.hidden = !input.value
    for (const [row, entry] of rows) row.hidden = !entry.text.includes(query)
    scheduleStatus()
  }

  function clearQuery(): void {
    input.value = ''
    applyQuery()
    input.focus()
  }

  input.addEventListener('input', applyQuery)
  clear.addEventListener('click', clearQuery)
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      clearQuery()
    }
  })
  applyQuery()

  return {
    rowsChanged: scheduleStatus,
    update(row, fields, toolsKnown = true) {
      const text = fields.join('\n').toLowerCase()
      rows.set(row, { text, toolsKnown })
      row.dataset.packageSearchRow = ''
      row.hidden = !text.includes(query)
      scheduleStatus()
    },
  }
}
