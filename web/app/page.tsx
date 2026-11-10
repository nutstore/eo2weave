import { MarketingLayout } from '@/components/marketing/MarketingLayout'
import { LegacyLaunch } from '@/components/marketing/LegacyLaunch'
import { HomeCn } from '@/components/marketing/pages/home/HomeCn'
import { HomeGlobal } from '@/components/marketing/pages/home/HomeGlobal'
import { marketingMetadata } from '@/components/marketing/metadata'
import { copy } from '@/components/marketing/content'

const region = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn' ? 'cn' : 'global'

export const metadata = marketingMetadata('/', copy.homeTitle, copy.homeText)

export default function HomePage() {
  return (
    <>
      <LegacyLaunch />
      <MarketingLayout page="home" region={region}>
        {region === 'cn' ? <HomeCn /> : <HomeGlobal />}
      </MarketingLayout>
    </>
  )
}
