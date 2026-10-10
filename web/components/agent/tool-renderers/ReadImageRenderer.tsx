import { Image } from 'lucide-react'
import { isOutputPart } from '@creatorweave/shared/code-output'
import { registerRenderer } from './registry'
import { ImageOutputView } from './ImageOutputView'

registerRenderer({
  name: 'read_image',
  icon: <Image className="h-3.5 w-3.5" />,
  Summary(ctx) { return <span className="truncate">{String(ctx.args.path || 'read_image')}</span> },
  Detail(ctx) {
    const result = ctx.result?.data
    return <div className="px-3 py-2">
      {isOutputPart(result) && result.type === 'image'
        ? <ImageOutputView image={result} alt={String(ctx.args.path || 'read_image')} />
        : <pre className="whitespace-pre-wrap text-xs">{JSON.stringify(ctx.result, null, 2)}</pre>}
    </div>
  },
})
