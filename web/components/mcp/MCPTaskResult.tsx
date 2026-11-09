import type { MCPToolCallResult } from '@/mcp/mcp-types'

export default function MCPTaskResult({ result }: { result: MCPToolCallResult }) {
  return (
    <div className="space-y-2">
      {result.content.map((block, index) =>
        block.type === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType) ? (
          <img
            key={index}
            alt=""
            className="max-h-64 max-w-full rounded"
            src={`data:${block.mimeType};base64,${block.data}`}
          />
        ) : (
          <pre
            key={index}
            className="whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800"
          >
            {block.type === 'text' ? block.text : JSON.stringify(block, null, 2)}
          </pre>
        )
      )}
      {result.structuredContent ? (
        <pre className="whitespace-pre-wrap break-all rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-800">
          {JSON.stringify(result.structuredContent, null, 2)}
        </pre>
      ) : null}
    </div>
  )
}
