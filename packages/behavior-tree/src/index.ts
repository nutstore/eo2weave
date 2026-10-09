export type Status = 'success' | 'failure' | 'running'
export type Awaitable<T> = T | Promise<T>
export type Predicate<C> = (context: C) => Awaitable<boolean>

export type Node<C> =
  | { readonly type: 'action'; readonly run: (context: C) => Awaitable<Status> }
  | { readonly type: 'condition'; readonly inspect: Predicate<C> }
  | { readonly type: 'wait'; readonly inspect: Predicate<C>; readonly intervalMs: number; readonly timeoutMs?: number }
  | { readonly type: 'sequence' | 'selector'; readonly children: readonly Node<C>[] }

export function action<C>(run: (context: C) => Awaitable<Status>): Node<C> {
  return Object.freeze({ type: 'action', run })
}

export function condition<C>(inspect: Predicate<C>): Node<C> {
  return Object.freeze({ type: 'condition', inspect })
}

export function sequence<C>(...children: Node<C>[]): Node<C> {
  return Object.freeze({ type: 'sequence', children: Object.freeze(children) })
}

export function selector<C>(...children: Node<C>[]): Node<C> {
  return Object.freeze({ type: 'selector', children: Object.freeze(children) })
}

export interface WaitOptions {
  intervalMs?: number
  timeoutMs?: number
}

export function wait<C>(inspect: Predicate<C>, options: WaitOptions = {}): Node<C> {
  const intervalMs = options.intervalMs ?? 0
  for (const value of [intervalMs, options.timeoutMs]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new RangeError('Wait durations must be finite and nonnegative')
    }
  }
  return Object.freeze({ type: 'wait', inspect, intervalMs, timeoutMs: options.timeoutMs })
}

interface Memory {
  status?: Status
  index: number
  startedAt?: number
  nextInspectionAt?: number
}

export interface Execution<C> {
  readonly context: C
  readonly status: Status | undefined
  tick(): Promise<Status>
  /** Clears execution memory, but does not undo effects or clear caller-owned context. */
  reset(): void
}

/** Each execution owns memory; the same tree can serve multiple independent contexts. */
export function createExecution<C>(
  root: Node<C>,
  context: C,
  options: { now?: () => number } = {},
): Execution<C> {
  const now = options.now ?? Date.now
  // Paths distinguish repeated occurrences of the same reusable subtree.
  const memory = new Map<string, Memory>()
  let pending: Promise<Status> | undefined
  let fault: { error: unknown } | undefined

  async function visit(node: Node<C>, path: string): Promise<Status> {
    let state = memory.get(path)
    if (!state) {
      state = { index: 0 }
      memory.set(path, state)
    }
    if (state.status === 'success' || state.status === 'failure') return state.status
    state.status = 'running'
    let result: Status
    switch (node.type) {
      case 'action':
        result = await node.run(context)
        if (result !== 'success' && result !== 'failure' && result !== 'running') {
          throw new TypeError('Action must return success, failure or running')
        }
        break
      case 'condition':
        result = await inspect(node.inspect) ? 'success' : 'failure'
        break
      case 'wait': {
        const time = now()
        const first = state.startedAt === undefined
        state.startedAt ??= time
        const expired = () => node.timeoutMs !== undefined && now() - state.startedAt! >= node.timeoutMs
        if (!first && expired()) {
          result = 'failure'
        } else if (state.nextInspectionAt !== undefined && time < state.nextInspectionAt) {
          result = 'running'
        } else {
          const ready = await inspect(node.inspect)
          result = ready ? 'success' : expired() ? 'failure' : 'running'
          state.nextInspectionAt = now() + node.intervalMs
        }
        break
      }
      case 'sequence':
      case 'selector': {
        const advanceOn = node.type === 'sequence' ? 'success' : 'failure'
        result = advanceOn
        while (state.index < node.children.length) {
          result = await visit(node.children[state.index], `${path}/${state.index}`)
          if (result !== advanceOn) break
          state.index++
        }
        break
      }
    }
    state.status = result
    return result
  }

  async function inspect(predicate: Predicate<C>): Promise<boolean> {
    const result = await predicate(context)
    if (typeof result !== 'boolean') throw new TypeError('Inspect must return a boolean')
    return result
  }

  return {
    context,
    get status() { return fault ? undefined : memory.get('root')?.status },
    tick() {
      if (pending) return pending
      if (fault) return Promise.reject(fault.error)
      // Defer callbacks until pending is assigned, including synchronous callbacks.
      pending = Promise.resolve().then(() => visit(root, 'root')).catch((error: unknown) => {
        fault = { error }
        throw error
      }).finally(() => { pending = undefined })
      return pending
    },
    reset() {
      if (pending) throw new Error('Cannot reset while a tick is pending')
      memory.clear()
      fault = undefined
    },
  }
}
