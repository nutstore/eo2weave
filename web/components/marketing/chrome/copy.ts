import type { FooterCopy } from './SiteFooter'
import type { HeaderCopy } from './SiteHeader'

type ChromeCopy = { header: HeaderCopy; footer: FooterCopy }

const extension = {
  cn: {
    install: '安装浏览器插件',
    useNow: '立即使用',
    checking: '正在检测…',
    offline: '离线安装包',
    offlineHint: '按安装说明手动添加扩展',
    store: 'Chrome 应用商店',
    storeHint: '需网络可访问，支持自动更新',
  },
  global: {
    install: 'Install browser extension',
    useNow: 'Open EO2Weave',
    checking: 'Checking…',
    offline: 'Offline package',
    offlineHint: 'Add the extension manually with the install guide',
    store: 'Chrome Web Store',
    storeHint: 'Requires network access, updates automatically',
  },
} as const

export const chromeCopy: Record<'cn' | 'global', ChromeCopy> = {
  cn: {
    header: {
      ...extension.cn,
      brand: '怡氧®AI',
      home: '首页',
      webmcp: 'WebMCP',
      pricing: '定价',
      help: '帮助',
      download: '浏览器扩展',
      online: '在线使用',
      openMenu: '打开导航菜单',
      closeMenu: '关闭导航菜单',
    },
    footer: {
      brand: '怡氧®AI',
      copyright: '© 2026 上海奕惟网络科技有限公司',
      privacyHref: '/help/privacy',
      privacy: '隐私政策',
      helpHref: '/docs/zh',
      help: '帮助',
      filings: {
        icpHref: 'https://beian.miit.gov.cn/',
        icp: '沪ICP备2023015830号-1',
        policeHref: 'https://beian.mps.gov.cn/#/query/webSearch',
        policeIcon: '/marketing/assets/mps-filing.png',
        police: '沪公网安备 31011502019920号',
      },
    },
  },
  global: {
    header: {
      ...extension.global,
      brand: 'EO2Weave',
      home: 'Home',
      webmcp: 'WebMCP',
      help: 'Help',
      download: 'Browser extension',
      online: 'Use online',
      openMenu: 'Open navigation menu',
      closeMenu: 'Close navigation menu',
    },
    footer: {
      brand: 'EO2Weave',
      copyright: '© 2026 EO2Weave',
      privacyHref: '/help/privacy',
      privacy: 'Privacy policy',
      helpHref: '/docs/en',
      help: 'Help',
    },
  },
}
