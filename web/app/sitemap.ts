import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const isCn = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'
  const base = isCn ? 'https://weave.eo2suite.cn' : 'https://weave.eo2suite.com'
  const paths = ['', '/webmcp', '/download', '/experience', '/help/privacy']
  // The model registration notice is domestic-only: the international
  // deployment does not build it, so it must never declare an `en` alternate.
  if (isCn) paths.push('/help/models')
  return paths.map((path) => ({
    url: `${base}${path}`,
    ...(path === '/help/models'
      ? {}
      : {
          alternates: {
            languages: {
              'zh-CN': `https://weave.eo2suite.cn${path}`,
              en: `https://weave.eo2suite.com${path}`,
            },
          },
        }),
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }))
}
