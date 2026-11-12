export const unsupportedBrowser = {
  title: "浏览器存储不可用",
  insecureTitle: "请使用安全连接访问",
  description: "当前页面无法访问运行应用所需的浏览器存储。",
  currentBrowser: "当前浏览器：{browser}",
  unknownBrowser: "未识别",
  guidance: {
    secureConnection:
      "请通过 HTTPS 访问本站；本地开发可使用 localhost。如果无法更改访问地址，请联系网站维护者。",
    chromium:
      "请将 {browser} 更新到最新版本，并在普通窗口（非无痕模式）中重试。如果存储仍不可用，请联系网站维护者。",
    firefox:
      "请更新 Firefox，并在普通窗口中重试。Firefox 可通过浏览器存储进行在线对话，但不支持直接打开本地文件夹。",
    safari:
      "请更新 Safari 或设备操作系统，并在普通窗口中重试。Safari 可通过浏览器存储进行在线对话，但不支持直接打开本地文件夹。",
    ios: "请更新 iOS 或 iPadOS，并在浏览器的普通标签页中打开本站。如果当前在其他应用内打开，请尝试使用 Safari。",
    unknown:
      "请更新浏览器，并在普通浏览器窗口中打开本站，避免使用其他应用的内置浏览器。也可以尝试最新版 Chrome 或 Edge。如果问题持续，请联系网站维护者。",
  },
  download: "下载 {browser}",
  technicalDetails: "技术详情",
  secureContext: "安全连接",
  browserStorage: "浏览器存储（OPFS）",
  localFolders: "本地文件夹访问",
  siteIsolation: "站点隔离",
  available: "可用",
  unavailable: "不可用",
  isolationHelp:
    "站点隔离也未启用。SQLite 存储可能需要 COOP/COEP 响应头，请联系网站维护者检查部署配置。更换浏览器无法补齐网站缺失的响应头。",
  compatibilityTitle: "桌面浏览器 API 支持参考",
  browser: "浏览器",
  notSupported: "不支持",
  compatibilityNote:
    "表中版本仅表示 API 开始可用，不代表应用的完整兼容性，建议使用最新版浏览器。手机端支持情况有所不同，iOS/iPadOS 请使用较新的系统。存储还取决于 HTTPS、浏览器策略及站点配置。",
} as const;
