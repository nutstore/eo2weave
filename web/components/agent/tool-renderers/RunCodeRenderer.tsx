import { isCodeRunResult } from '@creatorweave/shared/code-output'
import { ImageOutputView } from './ImageOutputView'
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
    const execution = isCodeRunResult(ctx.result?.data) ? ctx.result.data : undefined
    const summary = execution ? (execution.ok ? { ok: true, value: execution.value } : { ok: false, error: execution.error }) : (ctx.result?.data ?? ctx.result?.error)
    return <div className="space-y-2 px-3 py-2">
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{String(ctx.args.code || '')}</pre>
      {meta?.calls?.map(call => <details key={call.id}>
        <summary className="cursor-pointer text-xs">{call.name} · {call.status}</summary>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(call.args, null, 2)}{'\n'}{call.result}</pre>
      </details>)}
      {summary !== undefined && <pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(summary, null, 2)}</pre>}
      {execution?.output.map((part, index) => part.type === 'image'
        ? <ImageOutputView key={index} image={part} alt={String(ctx.args.purpose || 'run_code')} />
        : <pre key={index} className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{part.text}</pre>)}
    </div>
  },
})
