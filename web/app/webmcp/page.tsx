import { MarketingLayout } from '@/components/marketing/MarketingLayout'
import { WebMcpPage } from '@/components/marketing/pages/webmcp/WebMcpPage'
import { marketingMetadata } from '@/components/marketing/metadata'
import { copy } from '@/components/marketing/content'

const region = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn' ? 'cn' : 'global'

export const metadata = marketingMetadata('/webmcp', 'WebMCP', copy.mcpLead)

export default function Page() {
  return (
    <MarketingLayout page="webmcp" region={region}>
      <WebMcpPage region={region} />
    </MarketingLayout>
  )
}
