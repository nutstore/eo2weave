import type { MetadataRoute } from 'next'

/**
 * Sitemap for crawlers. The product is a client-rendered SPA behind the root
 * route — until a static landing page ships (P1), only genuinely indexable
 * static routes belong here. Keeps the file valid XML for
 * https://weave.eo2suite.cn/sitemap.xml (and .com for global builds).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const isCN = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'
  const base = isCN ? 'https://weave.eo2suite.cn' : 'https://weave.eo2suite.com'

  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: 'weekly',
      priority: 1,
    },
    {
      url: `${base}/help/privacy`,
      lastModified: new Date(),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
  ]
}
