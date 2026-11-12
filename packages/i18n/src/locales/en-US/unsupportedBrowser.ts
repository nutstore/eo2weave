export const unsupportedBrowser = {
  title: "Browser storage is unavailable",
  insecureTitle: "A secure connection is required",
  description:
    "This page cannot access the browser storage needed to open the app.",
  currentBrowser: "Current browser: {browser}",
  unknownBrowser: "Not identified",
  guidance: {
    secureConnection:
      "Open this site over HTTPS, or use localhost for local development. If you cannot change the address, contact the site owner.",
    chromium:
      "Update {browser} to the latest version and try a regular (non-private) window. If storage is still unavailable, contact the site owner.",
    firefox:
      "Update Firefox and try a regular window. Firefox can use browser storage for online chats, but cannot open local folders.",
    safari:
      "Update Safari or your device’s operating system and try a regular window. Safari can use browser storage for online chats, but cannot open local folders.",
    ios: "Update iOS or iPadOS and open this page in a regular browser tab. If you opened it inside another app, try Safari.",
    unknown:
      "Update your browser and open this page in a regular browser window rather than inside another app. You can also try the latest Chrome or Edge. If the problem persists, contact the site owner.",
  },
  download: "Download {browser}",
  technicalDetails: "Technical details",
  secureContext: "Secure connection",
  browserStorage: "Browser storage (OPFS)",
  localFolders: "Local folder access",
  siteIsolation: "Site isolation",
  available: "Available",
  unavailable: "Unavailable",
  isolationHelp:
    "Site isolation is also unavailable. SQLite storage may require COOP/COEP response headers; contact the site owner to check the deployment. Changing browsers does not fix missing site headers.",
  compatibilityTitle: "Desktop browser API reference",
  browser: "Browser",
  notSupported: "Not supported",
  compatibilityNote:
    "These versions indicate API availability, not full app compatibility. Use the latest browser. Mobile support differs; iOS/iPadOS requires a recent OS. Storage also depends on HTTPS, browser policies and site configuration.",
} as const;
