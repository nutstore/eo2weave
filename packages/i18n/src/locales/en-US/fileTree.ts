// File Tree
export const fileTree = {
    pending: {
      create: "Added",
      modify: "Modified",
      delete: "Deleted",
    },
    copyPath: "Copy Path",
    inspectElement: "Inspect Element",
    deleteFile: "Delete",
    deleteConfirm: "Are you sure you want to delete \"{name}\"?",
    deleteFileTitle: "Confirm Delete",
    emptyStateHint: "You can continue without selecting a local directory",
    emptyStateDescription:
      "AI file changes are stored here temporarily. Confirm to save them to your local files",
    draftFiles: "Unconfirmed Changes",
    gitBranch: "Git branch",
    detachedHead: "detached HEAD",
    approvedNotSynced: "Confirmed, waiting to be written to disk",
    loadFailed: "Directory inaccessible",
    opfsDraftRoot: "OPFS Drafts",
} as const
