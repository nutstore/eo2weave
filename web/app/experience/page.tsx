import { MarketingLayout } from '@/components/marketing/MarketingLayout'
import { ExperiencePage as ExperienceDemo } from '@/components/marketing/pages/experience/ExperiencePage'
import { marketingMetadata } from '@/components/marketing/metadata'
import { copy } from '@/components/marketing/content'

const region = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn' ? 'cn' : 'global'

export const metadata = marketingMetadata('/experience', copy.experienceTitle, copy.experienceText)

export default function Page() {
  return (
    <MarketingLayout page="experience" region={region}>
      <ExperienceDemo region={region} />
    </MarketingLayout>
  )
}
