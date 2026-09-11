/**
 * Folder Access Types - Unified type definitions
 *
 * Single source of truth for permission state management:
 * solves scattered state, incomplete release, and re-add failure issues
 */

/**
 * Folder access state machine
 */
export type FolderAccessStatus =
  | 'idle' // Initial state, no folder selected
  | 'checking' // Checking permissions
  | 'ready' // Folder selected and permission valid
  | 'needs_user_activation' // Needs user interaction to restore permission
  | 'requesting' // User interaction in progress (select/request permission)
  | 'releasing' // Releasing
  | 'error' // Error state

/**
 * Folder access record
 */
export interface FolderAccessRecord {
  /** Project ID */
  projectId: string
  /** Root name (handle.name or projectId for default root) */
  rootName?: string
  /** Folder name */
  folderName: string | null
  /** Directory handle (in-memory, currently available) */
  handle: FileSystemDirectoryHandle | null
  /** Persisted handle (permission-restorable) */
  persistedHandle: FileSystemDirectoryHandle | null
  /** Current status */
  status: FolderAccessStatus
  /** Error message */
  error?: string
  /** Created at */
  createdAt: number
  /** Last updated at */
  updatedAt: number
}

/**
 * Store action types
 */
export interface FolderAccessActions {
  /** Set active project */
  setActiveProject: (projectId: string | null) => Promise<void>
  /** Initialize project data (hydration) */
  hydrateProject: (projectId: string) => Promise<void>
  /** Pick a new folder (shows folder picker dialog) */
  pickDirectory: (projectId: string) => Promise<boolean>
  /** Set folder handle directly (no dialog, for externally obtained handles) */
  setHandle: (projectId: string, handle: FileSystemDirectoryHandle) => Promise<void>
  /** Request permission restoration (from pending state) */
  requestPermission: (projectId: string) => Promise<boolean>
  /** Fully release (delete record) */
  release: (projectId: string) => Promise<void>
  /** Clear error state */
  clearError: (projectId: string) => void
}

/**
 * Which disk backend granted / backs this root.
 *
 * - `'fsaccess'`     — File System Access API (browser `showDirectoryPicker`).
 *                      Permission may lapse on browser restart → needs re-activation.
 * - `'native-host'`  — CreatorWeave native host (Chrome Native Messaging).
 *                      Permission persisted in the host's scopes file; does not lapse
 *                      across browser restarts as long as the host is installed.
 *
 * Defaults to `'fsaccess'` for backward compatibility (pre-native-host roots).
 * The UI uses this to badge native-host roots distinctly so that, during
 * testing and operation, the two backends are visually distinguishable.
 */
export type DiskBackend = 'fsaccess' | 'native-host'

/**
 * Root info for multi-root display
 */
export interface RootInfo {
  id: string
  name: string
  isDefault: boolean
  readOnly: boolean
  /** Which backend backs this root. */
  backend: DiskBackend
  /** Native Host scope ID; null for File System Access roots. */
  scopeId: string | null
  /** In-memory handle (null if permission lost) */
  handle: FileSystemDirectoryHandle | null
  /** Persisted handle (permission-restorable) */
  persistedHandle: FileSystemDirectoryHandle | null
  status: FolderAccessStatus
  error?: string
}

/**
 * Full store type
 */
export interface FolderAccessStore extends FolderAccessActions {
  /** Active project ID */
  activeProjectId: string | null
  /** Permission records for all projects */
  records: Record<string, FolderAccessRecord>

  // ---- Multi-root state ----

  /** All roots for the active project (hydrated from SQLite) */
  roots: RootInfo[]
  /**
   * True once `loadRoots()` has completed at least once for the active
   * project (regardless of whether roots is empty). UI components that gate
   * on `roots.length === 0` should also gate on `rootsHydrated` to avoid
   * flashing the "no folder mounted" state during the initial async
   * hydration (which defaults `roots` to `[]`). Mirrors `hasApiKeyLoaded`
   * in `useSettingsStore`.
   */
  rootsHydrated: boolean

  // ---- Shared file path cache ----

  /** File path cache per project (keyed by projectId, flat path list for search etc.) */
  allFilePaths: Record<string, string[]>

  /** Get the current project's record */
  getRecord: () => FolderAccessRecord | null
  /** Current project status */
  getCurrentStatus: () => FolderAccessStatus | null
  /** Current project's directory handle */
  getCurrentHandle: () => FileSystemDirectoryHandle | null
  /** Whether the current project is ready */
  isReady: () => boolean
  /** Ensure file path cache is loaded (traverses directory on first call, returns cache on subsequent calls) */
  ensureFilePaths: () => Promise<string[]>
  /** Refresh file path cache (forces re-traversal) */
  refreshFilePaths: () => Promise<string[]>
  /** Scan native-host roots for file paths (no FS Access handle) */
  refreshFilePathsNativeHost: (projectId: string) => Promise<string[]>
  /** Clear file path cache (called automatically on project switch/release) */
  clearFilePaths: () => void

  // ---- Multi-root actions ----

  /** Load all roots for the active project */
  loadRoots: () => Promise<void>
  /** Add a new root (shows folder picker) */
  addRoot: () => Promise<boolean>
  /** Add a root through the explicitly selected Native Host picker. */
  /** Add a root through the explicitly selected Native Host picker. `projectIdOverride` binds the new root to a specific project (e.g. the conversation's project for exec in-flow authorization); defaults to the active project. */
  addNativeHostRoot: (projectIdOverride?: string) => Promise<boolean>
  /** Remove a root by ID */
  removeRoot: (rootId: string) => Promise<void>
  /** Set a root as default */
  setDefaultRoot: (rootId: string) => Promise<void>
  /** Toggle read-only flag for a root */
  toggleReadOnly: (rootId: string) => Promise<void>
}
