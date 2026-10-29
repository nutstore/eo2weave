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
  additionalToolsNote: "Enabling also activates {count} additional tool(s) of this package on other supported sites.",
  privacyNote:
    "You can revoke this authorization anytime in the extension's Supported Sites page. Write actions still ask for your confirmation.",
  confirm: "Enable & reload page",
  enabling: "Enabling…",
  notNow: "Not now (no reminder for 1 day)",
  enabledReloadFailedToast: "{name} enabled, but reloading the page failed — reload it manually to activate the tools",
  enableTimeoutToast: "The enable request timed out. Please try again in a moment.",
  enabledToast: "{name} enabled — the page will reload to activate the tools",
  enableFailedToast: "Failed to enable. Please make sure the extension is up to date and try again.",
  consentRetryToast: "The confirmation expired before it could be used. Close this dialog and try again — no cooldown was recorded.",
  enabledVerificationUnavailableToast: "{name} was enabled and the page reloaded, but the change could not be verified — check the extension's Supported Sites page if the tools do not appear.",
}
