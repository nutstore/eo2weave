// Side-panel WebMCP package opt-in prompt (issue #100)
export const sidePanelPackage = {
  title: "Enable AI tools on this site?",
  description:
    "The eo2weave browser extension can inject MCP tools into this site ({count} tools). Once enabled, your AI assistant can search and operate this site for you directly.",
  packageLabel: "Supported site package",
  toolsTitle: "WebMCP tools this page will expose ({count})",
  toolsCollapse: "Collapse tool list",
  toolsExpand: "Expand tool list",
  readOnly: "Read only",
  write: "Write",
  privacyNote:
    "You can revoke this authorization anytime in the extension's Supported Sites page. Write actions still ask for your confirmation.",
  enableToggle: "Enable and reload the page on confirm",
  confirm: "Enable & reload page",
  enabling: "Enabling…",
  notNow: "Not now (no reminder for 1 day)",
  enabledToast: "{name} enabled — the page will reload to activate the tools",
  enableFailedToast: "Failed to enable. Please make sure the extension is up to date and try again.",
}
