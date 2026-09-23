// Folder Selector
export const folderSelector = {
    openFolder: "Select Folder",
    browserAccess: "Browser access",
    browserAccessDescription: "Choose and authorize a folder through your browser",
    localConnection: "Local connection",
    localConnectionDescription: "Recommended — connects through the eo2weave local service and stays authorized across sessions",
    switchFolder: "Switch Folder",
    releaseHandle: "Release Handle",
    copyPath: "Copy Folder Name",
    permissionDenied: "Permission denied",
    selectionFailed: "Selection failed",
    sandboxMode: "Sandbox Mode (OPFS)",
    restorePermission: "Restore Permission",
    needsPermissionRestore: "Needs permission restore",
    loading: "Loading...",
    unknown: "Unknown",
    // Persistent storage
    storageWarning: "Cache",
    storageTooltip:
      "Persistent storage not granted. Click to retry. Cache may be cleared on refresh.",
    storageSuccess: "Storage persisted",
    storageFailed: "Cannot get persistent storage",
    storageRequestFailed: "Request failed",
} as const
