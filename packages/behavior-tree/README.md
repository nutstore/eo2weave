# @creatorweave/behavior-tree

Small asynchronous behavior trees with memory. Zero runtime dependencies. Uses only ES2022 APIs; no DOM, extension, Node, timers, or application imports.

## Example

```ts
import { action, condition, createExecution, selector, sequence, wait } from '@creatorweave/behavior-tree'

type Context = {
  isReady(): Promise<boolean>
  open(): Promise<void>
  read(): Promise<string>
  result?: string
}

const tree = sequence<Context>(
  selector<Context>(
    condition(context => context.isReady()),
    sequence<Context>(
      action(async context => {
        await context.open()
        return 'success'
      }),
      wait(context => context.isReady(), { intervalMs: 100, timeoutMs: 10_000 }),
    ),
  ),
  action(async context => {
    context.result = await context.read()
    return 'success'
  }),
)

// The host supplies capabilities and owns scheduling.
const execution = createExecution(tree, context)
const status = await execution.tick()
// If status is 'running', call tick again on a later host event or scheduled wakeup.
// Read application outputs from execution.context.result.
```

## Execution contract

- `success`, `failure`, and `running` are control-flow statuses. Store application results in the caller-owned, typed context.
- Sequence advances after success, stops on failure, and stays at a running child. An empty sequence succeeds.
- Selector advances after failure, stops on success, and stays at a running child. An empty selector fails.
- Both composites remember their position. Completed siblings are not reevaluated. This is deliberately memory-based, not reactive priority evaluation.
- Condition awaits a boolean inspection. False means failure; use Wait when false means “not ready yet.”
- Action awaits its callback. A pending Promise keeps the current tick pending; simultaneous tick calls share that Promise. A returned `running` asks the host to tick again and invokes that callback again. Put one-shot effects in actions that await completion and return a terminal status.
- Wait inspects immediately, then at most once per tick when its interval has elapsed. It never starts timers or spins. It has no default timeout. An explicit timeout returns failure and can activate a selector fallback. A zero timeout allows one immediate inspection. The timeout is checked between inspections; it does not interrupt an in-flight callback. A successful in-flight inspection wins even if it finishes after the deadline.
- An exception or malformed callback result rejects the tick and latches the error. Further ticks reject the same error until reset; exceptions never silently select another branch.
- A terminal root result is retained until `reset()`. Reset clears tree memory and latched errors, retains context, and cannot undo effects. Reset during a pending tick throws to avoid overlapping runs.
- Definitions from the builders are immutable and reusable. Each execution has independent memory, including separate memory for repeated occurrences of a subtree. Supply separate contexts when application state should also be isolated. Trees must be acyclic.
- `createExecution(tree, context, { now })` accepts an injectable millisecond clock. It defaults to `Date.now`; hosts can provide a monotonic clock. Use a nondecreasing clock for predictable waits.
- `execution.status` is undefined before the first tick or after a fault/reset, running while executing, and success/failure on completion. Errors are delivered by `tick()`.

The host owns wakeups, cancellation of its capabilities, persistence, and lifecycle. Execution memory is in-process only; this package does not recover a terminated process or service worker. There is no global timeout, URL check, permission policy, retry, or implicit restart.

## Development

```sh
pnpm --filter @creatorweave/behavior-tree test:run
pnpm --filter @creatorweave/behavior-tree typecheck
```

Like other workspace packages, the export points to TypeScript source for consumers' bundlers. The package does not depend on other workspace packages.
