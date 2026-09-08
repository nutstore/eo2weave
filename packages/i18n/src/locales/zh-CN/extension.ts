// 浏览器扩展相关
export const extension = {
  // Banner
  bannerTitle: "解锁网页搜索能力！",
  bannerDescription: "安装浏览器扩展，让 AI 可以搜索和读取网页内容。",
  bannerAction: "了解并安装",
  bannerDismiss: "以后再说",

  // Install Guide Dialog
  guideTitle: "安装 怡氧知知 浏览器扩展",
  guideSubtitle: "让你的 AI 助手连接互联网",
  guideAlreadyInstalled: "已安装插件？",
  verifyInstallLink: "刷新页面",
  estimatedTime: "预计安装时间：3-5 分钟",
  prerequisite: "你需要准备：Chrome 或 Edge 浏览器",

  // 安装方式选择（第 1 步）
  methodChoose: "请选择安装方式：",
  methodRecommended: "推荐",
  methodStoreTitle: "从 Chrome 应用商店安装",
  methodStoreDesc: "一键安装，自动更新。需要能访问 chromewebstore.google.com。",
  methodStoreBadge: "自动更新",
  methodZipTitle: "手动安装（下载安装包）",
  methodZipDesc: "下载插件包后手动加载，商店无法访问时也能安装。",
  methodZipBadge: "不依赖商店",

  // Feature list
  featureSearch: "搜索互联网",
  featureFetch: "读取网页内容",

  // Chrome Web Store 流程（海外站点构建）
  stepStoreOpen: "打开 Chrome 应用商店",
  stepStoreInstall: "添加至 Chrome",
  storeOpenDesc: "插件已发布到 Chrome 应用商店，一键安装，自动更新。",
  storeOpenButton: "打开 Chrome 应用商店",
  storeOpenHint: "商店页面会在新标签页打开，点击“添加至 Chrome”，然后回到本页点击“下一步”。",
  storeNeedsChromium: "当前浏览器不支持 Chrome 商店扩展，请使用 Chrome 或 Edge 打开本页面。",
  storeInstallDesc: "在 Chrome 应用商店页面完成安装",
  storeInstallStepA: "在商店页面点击“添加至 Chrome”",
  storeInstallStepADesc: "按钮位于商店页面右上角",
  storeInstallStepB: "在浏览器弹窗中点击“添加扩展程序”确认",
  storeInstallStepBDesc: "无需开启开发者模式，插件会自动安装并自动更新",
  storeInstallHint: "安装成功后，扩展列表中会出现“怡氧知知”",

  // Steps
  stepIntro: "介绍与准备",
  stepDownload: "下载插件",
  stepExtract: "解压文件",
  stepInstall: "安装到浏览器",
  stepRefresh: "刷新页面",

  stepIntroDesc: "了解这个插件能为你做什么",
  stepDownloadDesc: "下载插件压缩包",
  stepExtractDesc: "解压下载的文件",
  stepInstallDesc: "在浏览器中加载插件",
  stepRefreshDesc: "刷新页面使插件生效",

  // Download step
  downloadButton: "下载插件包",
  downloadHint: "下载完成后记住文件保存位置，下一步需要用到",
  downloadSize: "约 500KB",

  // Extract step
  extractTitle: "解压下载的文件",
  extractWindows: "Windows：右键 → 全部解压缩",
  extractMac: "macOS：双击 zip 文件自动解压",
  extractLinux: "Linux：右键 → 提取到...",

  // Install step
  installStepA: "打开扩展管理页面",
  installStepAChrome: "Chrome：地址栏输入 chrome://extensions",
  installStepAEdge: "Edge：地址栏输入 edge://extensions",
  installCopyLink: "复制链接",
  installStepB: "打开右上角「开发者模式」开关",
  installStepC: "点击「加载已解压的扩展程序」",
  installStepCSelect: "选择刚才解压出来的 chrome-extension 文件夹",
  installSuccessHint: "看到扩展列表中出现 \"怡氧知知\" 即安装成功",

  // Verify step (kept for backwards compat)
  verifyTitle: "刷新页面",
  verifyChecking: "正在检测插件状态...",
  verifySuccess: "插件已就绪！",
  verifyFailed: "未检测到插件",
  verifyRetry: "重新检测",
  verifyTroubleshootTitle: "故障排查",
  verifyTroubleshoot1: "确认插件已在 chrome://extensions 中启用",
  verifyTroubleshoot2: "刷新当前页面后重试",
  verifyTroubleshoot3: "确认选择了正确的解压文件夹",

  // Refresh step
  refreshTitle: "最后一步：刷新页面",
  refreshDescription: "插件安装完成后，需要刷新本页面才能生效。点击下方按钮刷新页面。",
  refreshButton: "刷新页面",
  refreshHint: "刷新后插件将自动生效，你可以开始使用网页搜索功能了。",
  refreshPageLink: "刷新页面",

  // Success
  successTitle: "安装成功！",
  successDescription: "你的 AI 助手现在可以搜索互联网了。试试问它\"今天的新闻有什么？\"",

  // Navigation
  nextStep: "下一步",
  prevStep: "上一步",
  finish: "完成",
  skip: "暂时不用",

  // Error Card (in conversation)
  errorCardTitle: "网页搜索暂不可用",
  errorCardDescription: "AI 当前无法搜索互联网，因为浏览器扩展尚未安装。",
  errorCardFeature1: "搜索互联网（DuckDuckGo）",
  errorCardFeature2: "读取任意网页内容",
  errorCardFeature3: "渲染动态网页（如 Twitter、Reddit）",
  errorCardAction: "立即安装浏览器扩展",
  errorCardDismiss: "暂时不用",

  // Settings tab
  settingsTab: "浏览器扩展",
  settingsInstalled: "插件已就绪",
  settingsNotInstalled: "未安装",
  settingsInstallButton: "安装插件",
  settingsVersion: "版本",
  settingsDescription: "浏览器扩展为 AI 助手提供网页搜索和内容读取能力",
  settingsCapabilities: "插件能力",

  // Settings — 版本显示
  settingsVersionTitle: "版本",
  settingsLatestVersion: "最新版本",
  settingsCurrentVersion: "当前安装",
  settingsUpdateAvailable: "有更新",

  // 过期提示横幅
  outdatedBannerTitle: "插件有新版本",
  outdatedBannerDescription: "你的插件版本 (v{current}) 已过期，最新版本为 v{latest}",
  outdatedBannerAction: "下载更新",

  // Mobile notice
  mobileNotice: "浏览器扩展仅支持桌面端，请在电脑上的 Chrome 或 Edge 浏览器中打开本页面进行安装。",
}