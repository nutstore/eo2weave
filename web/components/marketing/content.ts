const content = {
  cn: { brand: '怡氧®AI', homeTitle: '浏览器里的 AI 工作空间', homeText: '怡氧®AI 是一款运行在浏览器中的 AI 工作空间：在侧边栏中选用不同模型，让 AI 理解网页、操作网站并处理本地文件。', mcpLead: '了解 WebMCP 如何让 AI 使用网站工具。', downloadTitle: '把怡氧®AI 装进浏览器', downloadText: '安装浏览器扩展，在网站中随时唤起怡氧®AI。', experienceTitle: '亲手体验怡氧®AI', experienceText: '在真实网站上体验 WebMCP。' },
  global: { brand: 'EO2Weave', homeTitle: 'The AI workspace in your browser', homeText: 'EO2Weave is an AI workspace that runs in your browser: pick a model in the side panel and let it read pages, operate sites and work with local files.', mcpLead: 'Discover how WebMCP lets AI use website tools.', downloadTitle: 'Bring EO2Weave to your browser', downloadText: 'Install the browser extension and open EO2Weave while browsing.', experienceTitle: 'Try EO2Weave', experienceText: 'Experience WebMCP on a real website.' },
} as const
export function getMarketingContent(region: 'cn' | 'global') { return content[region] }
export const experienceSites = { douban: 'cn', jmail: 'global' } as const
export type ExperienceSite = keyof typeof experienceSites
export function getExperienceSite(site: string | string[] | undefined, region: 'cn' | 'global'): ExperienceSite {
  if (typeof site === 'string' && Object.prototype.hasOwnProperty.call(experienceSites, site)) return site as ExperienceSite
  return region === 'cn' ? 'douban' : 'jmail'
}
export const isCN = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'
export const copy = getMarketingContent(isCN ? 'cn' : 'global')
