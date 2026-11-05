import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SQLiteDatabaseManager } from '../sqlite-database'

class FakeWorker {
  static requests: Array<{ type: string; sql?: string; id?: string }> = []
  static inTransaction = false
  static beginWhileInTransaction = 0
  static terminateCalls = 0
  static instanceCount = 0
  static handleRequest: ((request: any, respond: (response: any) => void) => void) | null = null

  onmessage: ((event: MessageEvent<any>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor(_url: URL, _options?: WorkerOptions) {
    FakeWorker.instanceCount += 1
  }

  postMessage(request: any) {
    FakeWorker.requests.push(request)
    const respond = (response: any) => {
      queueMicrotask(() => this.onmessage?.({ data: response } as MessageEvent))
    }

    if (FakeWorker.handleRequest) {
      FakeWorker.handleRequest(request, respond)
      return
    }

    queueMicrotask(() => {
      if (request.type === 'init') {
        this.onmessage?.({
          data: { type: 'init', id: request.id, success: true, mode: 'opfs' },
        } as MessageEvent)
        return
      }

      if (request.type === 'beginTransaction') {
        if (FakeWorker.inTransaction) {
          FakeWorker.beginWhileInTransaction += 1
          this.onmessage?.({
            data: {
              type: 'beginTransaction',
              id: request.id,
              error: 'cannot start a transaction within a transaction',
            },
          } as MessageEvent)
          return
        }
        FakeWorker.inTransaction = true
      }

      if (request.type === 'commit' || request.type === 'rollback') {
        FakeWorker.inTransaction = false
      }

      this.onmessage?.({ data: { type: request.type, id: request.id } } as MessageEvent)
    })
  }

  terminate() {
    FakeWorker.terminateCalls += 1
  }
}

describe('SQLiteDatabaseManager transaction serialization', () => {
  const OriginalWorker = globalThis.Worker
  const originalCrossOriginIsolated = (globalThis as any).crossOriginIsolated

  beforeEach(() => {
    const managerCtor = SQLiteDatabaseManager as any
    const globals = globalThis as any
    managerCtor.instance = null
    globals.Worker = FakeWorker as any
    globals.crossOriginIsolated = true
    FakeWorker.requests = []
    FakeWorker.inTransaction = false
    FakeWorker.beginWhileInTransaction = 0
    FakeWorker.terminateCalls = 0
    FakeWorker.instanceCount = 0
    FakeWorker.handleRequest = null
  })

  afterEach(async () => {
    await SQLiteDatabaseManager.getInstance()
      .close()
      .catch(() => undefined)
    const managerCtor = SQLiteDatabaseManager as any
    const globals = globalThis as any
    managerCtor.instance = null
    globals.Worker = OriginalWorker
    globals.crossOriginIsolated = originalCrossOriginIsolated
  })

  it('serializes concurrent transactions so a second BEGIN is not sent before the first COMMIT', async () => {
    const db = SQLiteDatabaseManager.getInstance()
    await db.initialize()

    let releaseFirst!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstCallbackStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstCallbackStarted = resolve
    })

    const first = db.transaction(async (tx) => {
      firstCallbackStarted()
      await firstCanFinish
      await tx.execute('INSERT INTO test VALUES (1)')
    })

    await firstStarted

    let secondCallbackRan = false
    const second = db.transaction(async (tx) => {
      secondCallbackRan = true
      await tx.execute('INSERT INTO test VALUES (2)')
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(secondCallbackRan).toBe(false)
    expect(FakeWorker.beginWhileInTransaction).toBe(0)

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(secondCallbackRan).toBe(true)
  })

  it('waits for initialization instead of creating a second worker', async () => {
    // Init is answered only after the gate opens, so the assertions below run
    // while initialization is genuinely still in flight.
    let openInitGate!: () => void
    const initGate = new Promise<void>((resolve) => {
      openInitGate = resolve
    })
    let initDispatched!: () => void
    const initRequestSeen = new Promise<void>((resolve) => {
      initDispatched = resolve
    })
    let queryResolved = false
    FakeWorker.handleRequest = (request, respond) => {
      if (request.type === 'init') {
        initDispatched()
        void initGate.then(() =>
          respond({ type: 'init', id: request.id, success: true, mode: 'opfs' })
        )
        return
      }
      if (request.type === 'queryFirst') {
        respond({ type: 'queryFirst', id: request.id, row: { value: 1 } })
        return
      }
      respond({ type: request.type, id: request.id })
    }

    const db = SQLiteDatabaseManager.getInstance()
    const initialization = db.initialize()
    const query = db.queryFirst<{ value: number }>('SELECT 1').finally(() => {
      queryResolved = true
    })

    // initialize() takes the cross-tab init lock BEFORE constructing the
    // worker, so waiting a fixed number of microtasks is not a reliable
    // signal (#203). Wait for the init request itself.
    await initRequestSeen
    // ONE worker while initialization is pending — the concurrent query
    // queues on the init promise instead of spawning a second worker…
    expect(FakeWorker.instanceCount).toBe(1)
    // …and it has not been answered yet.
    expect(queryResolved).toBe(false)

    openInitGate()
    await expect(Promise.all([initialization, query])).resolves.toEqual([undefined, { value: 1 }])
    // Still a single worker after initialization completed.
    expect(FakeWorker.instanceCount).toBe(1)
  })

  it('runs unrelated writes only after the active transaction commits', async () => {
    const db = SQLiteDatabaseManager.getInstance()
    await db.initialize()

    let releaseTransaction!: () => void
    const transactionCanFinish = new Promise<void>((resolve) => {
      releaseTransaction = resolve
    })
    let transactionStarted!: () => void
    const started = new Promise<void>((resolve) => {
      transactionStarted = resolve
    })

    const transaction = db.transaction(async (tx) => {
      transactionStarted()
      await transactionCanFinish
      await tx.execute('INSERT INTO test VALUES (1)')
    })
    await started

    const outsideWrite = db.execute('INSERT INTO test VALUES (2)')
    await Promise.resolve()
    await Promise.resolve()
    expect(FakeWorker.requests.filter((request) => request.type === 'execute')).toHaveLength(0)

    releaseTransaction()
    await expect(Promise.all([transaction, outsideWrite])).resolves.toEqual([undefined, undefined])

    // Assert the ORDERING CONTRACT, not the whole request log: the
    // initialization handshake legitimately emits an init + `SELECT 1` probe +
    // a second init (#203), which used to make a fixed-sequence expectation
    // fail even though nothing was mis-ordered.
    const types = FakeWorker.requests.map((request) => request.type)
    const beginAt = types.indexOf('beginTransaction')
    const commitAt = types.indexOf('commit')
    expect(beginAt).toBeGreaterThan(-1)
    expect(commitAt).toBeGreaterThan(beginAt)
    // Exactly two writes: the transaction's own, then the outside one. The
    // POSITIONS alone are not enough — a swapped pair (outside write before
    // COMMIT, transaction write after) would satisfy them — so identify each
    // write by its SQL.
    const writes = FakeWorker.requests
      .map((request, index) => ({ request, index }))
      .filter(({ request }) => request.type === 'execute')
    expect(writes).toHaveLength(2)
    expect(writes.map(({ request }) => request.sql)).toEqual([
      'INSERT INTO test VALUES (1)', // the transaction's write
      'INSERT INTO test VALUES (2)', // the outside write
    ])
    // …the transaction's write before the commit…
    expect(writes[0].index).toBeLessThan(commitAt)
    // …and the outside write AFTER it, as the last request of the run.
    expect(writes[1].index).toBeGreaterThan(commitAt)
    expect(types[types.length - 1]).toBe('execute')
  })

  it('retries a sync-handle error after recovery without losing the original request', async () => {
    let firstQuery = true
    FakeWorker.handleRequest = (request, respond) => {
      if (request.type === 'init') {
        respond({ type: 'init', id: request.id, success: true, mode: 'opfs' })
        return
      }
      if (request.type === 'queryAll' && firstQuery) {
        firstQuery = false
        respond({ type: 'queryAll', id: request.id, error: 'GetSyncHandleError: database busy' })
        return
      }
      if (request.type === 'recover') {
        respond({ type: 'recover', id: request.id, success: true })
        return
      }
      if (request.type === 'queryAll') {
        respond({ type: 'queryAll', id: request.id, rows: [{ value: 1 }] })
        return
      }
      respond({ type: request.type, id: request.id })
    }

    const db = SQLiteDatabaseManager.getInstance()
    await db.initialize()

    await expect(db.queryAll<{ value: number }>('SELECT 1')).resolves.toEqual([{ value: 1 }])
    expect(FakeWorker.requests.map((request) => request.type)).toEqual([
      'init',
      'queryAll',
      'recover',
      'queryAll',
    ])
  })

  it('terminates a timed-out worker before reinitializing future requests', async () => {
    let workerCount = 0
    FakeWorker.handleRequest = (request, respond) => {
      if (request.type === 'init') {
        workerCount += 1
        respond({ type: 'init', id: request.id, success: true, mode: 'opfs' })
        return
      }
      if (request.type === 'queryAll' && workerCount === 1) {
        return
      }
      if (request.type === 'queryAll') {
        respond({ type: 'queryAll', id: request.id, rows: [{ value: 2 }] })
        return
      }
      respond({ type: request.type, id: request.id })
    }

    const db = SQLiteDatabaseManager.getInstance()
    await db.initialize()
    const client = (db as any).workerClient

    await expect(
      client.sendRequest({ type: 'queryAll', sql: 'SELECT 1', params: [], id: 'slow-query' }, 1)
    ).rejects.toThrow('Request timeout: queryAll')
    expect(FakeWorker.terminateCalls).toBe(1)

    await expect(db.queryAll<{ value: number }>('SELECT 2')).resolves.toEqual([{ value: 2 }])
    expect(workerCount).toBe(2)
  })

  it('synchronously disposes the worker for a hot module replacement', async () => {
    const db = SQLiteDatabaseManager.getInstance()
    await db.initialize()

    db.dispose()

    expect(FakeWorker.terminateCalls).toBe(1)
  })
})
