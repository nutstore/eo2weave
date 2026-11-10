import type { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn' ? 'https://weave.eo2suite.cn' : 'https://weave.eo2suite.com'
  return ['', '/webmcp', '/download', '/experience', '/help/privacy'].map((path) => ({
    url: `${base}${path}`,
    alternates: { languages: { 'zh-CN': `https://weave.eo2suite.cn${path}`, en: `https://weave.eo2suite.com${path}` } },
    changeFrequency: path === '' ? 'weekly' : 'monthly',
    priority: path === '' ? 1 : 0.7,
  }))
}
