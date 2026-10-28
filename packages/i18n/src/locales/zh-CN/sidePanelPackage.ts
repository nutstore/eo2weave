// 侧边栏 WebMCP 包开启引导弹窗（issue #100）
export const sidePanelPackage = {
  title: "开启此网站的 AI 工具注入？",
  description:
    "检测到「怡氧知知」浏览器插件支持为本站点注入 MCP 工具（共 {count} 个），开启后 AI 助手可以直接帮你搜索和操作这个网站。",
  packageLabel: "支持的站点包",
  toolsTitle: "页面将暴露的 WebMCP 工具（{count}）",
  toolsCollapse: "收起工具列表",
  toolsExpand: "展开工具列表",
  readOnly: "只读",
  write: "写入",
  privacyNote:
    "你可以随时在插件的「支持的网站」管理页关闭此授权。写入类操作仍会单独向你确认。",
  enableToggle: "确认后立即开启并刷新网页",
  confirm: "开启并刷新页面",
  enabling: "正在开启…",
  notNow: "暂不开启（1 天内不再提示）",
  enabledToast: "已开启 {name}，网页将自动刷新以加载工具",
  enableFailedToast: "开启失败，请确认插件为最新版本后重试",
}
