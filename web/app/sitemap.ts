import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const isCn = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'
  const base = isCn ? 'https://weave.eo2suite.cn' : 'https://weave.eo2suite.com'
  const paths = ['', '/webmcp', '/download', '/experience', '/help/privacy']
  // The model registration notice is domestic-only: the international
  // deployment does not build it, so it must never declare an `en` alternate.
  if (isCn) paths.push('/help/models')
  // `/help/privacy` no longer describes equivalent policies across deployments
  // (the domestic one covers account-backed model processing, the international
  // one keeps the local-first claims), so neither page may declare the other as
  // its language alternate — same reasoning as the domestic-only notice.
  const withoutAlternates = new Set(['/help/privacy', '/help/models'])
  return paths.map((path) => ({
    url: `${base}${path}`,
    ...(withoutAlternates.has(path)
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
