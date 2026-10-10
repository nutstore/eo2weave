// Browser Extension related
export const extension = {
  // Banner
  bannerTitle: "Unlock Web Search!",
  bannerDescription: "Install the browser extension to let AI search and read web pages.",
  bannerAction: "Learn & Install",
  bannerDismiss: "Maybe Later",

  // Install Guide Dialog
  guideTitle: "Install eo2weave Browser Extension",
  guideSubtitle: "Connect your AI assistant to the internet",
  guideAlreadyInstalled: "Already installed?",
  verifyInstallLink: "Refresh Page",
  estimatedTime: "Estimated time: 3-5 minutes",
  prerequisite: "You'll need: Chrome or Edge browser",

  // Install method choice (step 1)
  methodChoose: "Choose how you want to install:",
  methodRecommended: "Recommended",
  methodStoreTitle: "Install from Chrome Web Store",
  methodStoreDesc: "One-click install with automatic updates. Requires access to chromewebstore.google.com.",
  methodStoreBadge: "Auto-updates",
  methodEdgeStoreTitle: "Install from Edge Add-ons",
  methodEdgeStoreDesc: "One-click install with automatic updates. The Edge-native store, directly accessible from mainland-China networks.",
  methodZipTitle: "Manual install (download package)",
  methodZipDesc: "Download the extension package and load it manually. Works even if the store is unreachable.",
  methodZipBadge: "Works offline from store",

  // Feature list
  featureSearch: "Search the internet",
  featureFetch: "Read web page content",

  // Chrome Web Store flow (international build)
  stepStoreOpen: "Open Chrome Web Store",
  stepStoreInstall: "Add to Chrome",
  storeOpenDesc: "The extension is published on the Chrome Web Store — installing takes one click and updates are automatic.",
  storeOpenButton: "Open Chrome Web Store",
  storeOpenHint: "The store page opens in a new tab. Click “Add to Chrome” there, then come back and click Next.",
  storeNeedsChromium: "This browser doesn't support Chrome Web Store extensions. Please open this page in Chrome or Edge.",
  storeInstallDesc: "Complete the installation on the Chrome Web Store page",
  storeInstallStepA: "Click “Add to Chrome” on the store page",
  storeInstallStepADesc: "The button is in the top-right corner of the store listing",
  storeInstallStepB: "Confirm by clicking “Add extension” in the browser dialog",
  storeInstallStepBDesc: "No developer mode needed — the extension installs and updates automatically",
  storeInstallHint: "Once installed, “EO2Weave” appears in your extensions list",

  // Edge Add-ons flow (Edge browser users)
  edgeStepStoreOpen: "Open Edge Add-ons",
  edgeStepStoreInstall: "Get",
  edgeStoreOpenDesc: "The extension is published on Edge Add-ons — installing takes one click and updates are automatic.",
  edgeStoreOpenButton: "Open Edge Add-ons",
  edgeStoreOpenHint: "The store page opens in a new tab. Click “Get” there, then come back and click Next.",
  edgeStoreInstallDesc: "Complete the installation on the Edge Add-ons page",
  edgeStoreInstallStepA: "Click “Get” on the store page",
  edgeStoreInstallStepADesc: "The button is in the top-right corner of the store listing",
  edgeStoreInstallStepB: "Confirm adding the extension in the browser dialog",
  edgeStoreInstallStepBDesc: "No developer mode needed — the extension installs and updates automatically",

  // Steps
  stepIntro: "Introduction",
  stepDownload: "Download",
  stepExtract: "Extract",
  stepInstall: "Install",
  stepRefresh: "Refresh",

  stepIntroDesc: "Learn what this extension can do",
  stepDownloadDesc: "Download the extension package",
  stepExtractDesc: "Extract the downloaded file",
  stepInstallDesc: "Load the extension in your browser",
  stepRefreshDesc: "Refresh the page to activate",

  // Download step
  downloadButton: "Download Extension Package",
  downloadHint: "Remember where you save the file — you'll need it in the next step",
  downloadSize: "~500KB",

  // Extract step
  extractTitle: "Extract the downloaded file",
  extractWindows: "Windows: Right-click → Extract All",
  extractMac: "macOS: Double-click the zip file to extract",
  extractLinux: "Linux: Right-click → Extract To...",

  // Install step
  installStepA: "Open the extensions page",
  installStepAChrome: "Chrome: Type chrome://extensions in the address bar",
  installStepAEdge: "Edge: Type edge://extensions in the address bar",
  installCopyLink: "Copy link",
  installStepB: "Enable \"Developer mode\" toggle (top right)",
  installStepC: "Click \"Load unpacked\"",
  installStepCSelect: "Select the extracted chrome-extension folder",
  installSuccessHint: "You should see \"EO2Weave\" appear in the extensions list",

  // Verify step (kept for backwards compat)
  verifyTitle: "Refresh the Page",
  verifyChecking: "Detecting extension status...",
  verifySuccess: "Extension is ready!",
  verifyFailed: "Extension not detected",
  verifyRetry: "Retry",
  verifyTroubleshootTitle: "Troubleshooting",
  verifyTroubleshoot1: "Make sure the extension is enabled in chrome://extensions",
  verifyTroubleshoot2: "Try refreshing this page and checking again",
  verifyTroubleshoot3: "Confirm you selected the correct extracted folder",

  // Refresh step
  refreshTitle: "Final Step: Refresh the Page",
  refreshDescription: "The extension needs a page refresh to take effect. Click the button below to reload.",
  refreshButton: "Refresh Page",
  refreshHint: "After refreshing, the extension will be active and you can start using web search.",
  refreshPageLink: "Refresh Page",

  // Success
  successTitle: "Installation Successful!",
  successDescription: "Your AI assistant can now search the internet. Try asking \"What's in the news today?\"",

  // Navigation
  nextStep: "Next",
  prevStep: "Previous",
  finish: "Finish",
  skip: "Skip for now",

  // Error Card (in conversation)
  errorCardTitle: "Web Search Unavailable",
  errorCardDescription: "AI cannot search the internet because the browser extension is not installed.",
  errorCardFeature1: "Search the internet (DuckDuckGo)",
  errorCardFeature2: "Read any web page content",
  errorCardFeature3: "Render dynamic pages (e.g. Twitter, Reddit)",
  errorCardAction: "Install Browser Extension",
  errorCardDismiss: "Skip for now",

  // Settings tab
  settingsTab: "Browser Extension",
  settingsInstalled: "Extension Ready",
  settingsNotInstalled: "Not Installed",
  settingsInstallButton: "Install Extension",
  settingsStoreButton: "Install from Chrome Web Store",
  settingsEdgeStoreButton: "Install from Edge Add-ons",
  settingsVersion: "Version",
  settingsDescription: "The browser extension provides web search and content reading capabilities for the AI assistant",
  settingsCapabilities: "Extension Capabilities",

  // Settings — Version display
  settingsVersionTitle: "Version",
  settingsLatestVersion: "Latest available",
  settingsBundledVersion: "Bundled ZIP version",
  settingsUpdateChannel: "Update channel",
  settingsStoreAutoUpdates: "Managed automatically by the browser store",
  settingsCurrentVersion: "Currently installed",
  settingsUpdateAvailable: "Update available",
  settingsNewerThanWeb: "Newer than web",

  // Outdated banner
  outdatedBannerTitle: "Extension Update Available",
  outdatedBannerDescription: "Your extension (v{current}) is outdated. Latest: v{latest}",
  outdatedBannerStoreAction: "Update from Store",
  storeButtonEdgeTitle: "Opens the Edge Add-ons listing",
  outdatedBannerZipAction: "Download Package",

  // Newer-than-web banner

  // Mobile notice
  mobileNotice: "The browser extension is only available on desktop. Please open this page in Chrome or Edge on your computer to install.",
}