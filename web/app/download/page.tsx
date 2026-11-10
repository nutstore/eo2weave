import { MarketingLayout } from '@/components/marketing/MarketingLayout'
import { DownloadCn } from '@/components/marketing/pages/download/DownloadCn'
import { DownloadGlobal } from '@/components/marketing/pages/download/DownloadGlobal'
import { marketingMetadata } from '@/components/marketing/metadata'
import { copy } from '@/components/marketing/content'

const region = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn' ? 'cn' : 'global'

export const metadata = marketingMetadata('/download', copy.downloadTitle, copy.downloadText)

export default function Page() {
  return (
    <MarketingLayout page="download" region={region}>
      {region === 'cn' ? <DownloadCn /> : <DownloadGlobal />}
    </MarketingLayout>
  )
}
