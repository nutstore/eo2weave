// Side-panel WebMCP package opt-in prompt (issue #100)
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
  additionalToolsNote: "开启后，该包还有 {count} 个工具会在其他支持的网站上生效。",
  privacyNote:
    "你可以随时在插件的「支持的网站」管理页关闭此授权。写入类操作仍会单独向你确认。",
  confirm: "开启并刷新页面",
  enabling: "正在开启…",
  notNow: "暂不开启（1 天内不再提示）",
  enabledReloadFailedToast: "已开启 {name}，但网页刷新失败——请手动刷新网页以加载工具",
  enableTimeoutToast: "开启请求超时，请稍后重试",
  enabledToast: "已开启 {name}，网页将自动刷新以加载工具",
  enableFailedToast: "开启失败，请确认插件为最新版本后重试",
  consentRetryToast: "确认凭据已过期，关闭本窗口后即可重试（不会计入冷却时间）。",
  enabledVerificationUnavailableToast: "已开启 {name} 并刷新了网页，但未能完成写入校验——若工具未出现，请到插件的「支持的网站」管理页确认。",
}
