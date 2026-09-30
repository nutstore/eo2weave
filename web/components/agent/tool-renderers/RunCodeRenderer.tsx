import { Code2 } from 'lucide-react'
import { registerRenderer } from './registry'
import type { CodeToolTrace } from '@/agent/tools/run-code.tool'

registerRenderer({
  name: 'run_code',
  icon: <Code2 className="h-3.5 w-3.5" />,
  Summary(ctx) {
    return <span className="truncate">{String(ctx.args.purpose || 'run_code')}</span>
  },
  Detail(ctx) {
    const meta = ctx.result?.meta as { calls?: CodeToolTrace[] } | undefined
    return <div className="space-y-2 px-3 py-2">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{String(ctx.args.code || '')}</pre>
      {meta?.calls?.map(call => <details key={call.id}>
        <summary className="cursor-pointer text-xs">{call.name} · {call.status}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(call.args, null, 2)}{'\n'}{call.result}</pre>
      </details>)}
      {ctx.result && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(ctx.result.data ?? ctx.result.error, null, 2)}</pre>}
    </div>
  },
})
