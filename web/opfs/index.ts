/**
 * OPFS (Origin Private File System) Module
 *
 * Multi-workspace architecture for browser file system operations.
 *
 * This module provides:
 * - Type definitions for OPFS operations
 * - Utility functions for path handling, hashing, and storage management
 * - Workspace management for isolated file operations per workspace
 * - Project management with multi-agent support
 *
 * Architecture:
 * - ProjectManager: Top-level manager for projects, each with its own agents
 * - AgentManager: Manages agents within a project
 * - WorkspaceManager: Top-level manager for multiple workspaces
 * - WorkspaceRuntime: Encapsulates single workspace OPFS operations
 * - (Undo history is stored in SQLite, not OPFS)
 */

// Types
export type {
  FileContent,
  FileMetadata,
  FileStatus,
  PendingChange,
  UndoRecord,
  SyncResult,
  ConflictInfo,
  StorageEstimate,
  StorageStatus,
  WorkspaceIndex,
  WorkspaceMetadata,
} from './types/opfs-types'
export { STORAGE_THRESHOLDS } from './types/opfs-types'

// Utils
export {
  encodePath,
  decodePath,
  calculateHash,
  getFileContentType,
  isImageFile,
  isPdfFile,
  getStorageEstimate,
  requestPersistentStorage,
  getStorageStatus,
  hasEnoughSpace,
  estimateWriteSize,
  getDirectorySize,
  formatBytes,
  formatRelativeTime,
  isContentEqual,
  getFileMetadata,
  deepClone,
  generateId,
  safeJsonParse,
  delay,
  processBatch,
  getFileExtension,
  getFileName,
  normalizePath,
  joinPath,
  getDirectoryPath,
} from './utils/opfs-utils'

// File reader for diff operations
export {
  readFileFromOPFS,
  readFileFromNativeFS,
  readFileFromNativeFSMultiRoot,
  readFileFromOPFSWithMeta,
  fileExistsInOPFS,
  fileExistsInNativeFS,
  fileExistsInNativeFSMultiRoot,
  readBinaryFileFromOPFS,
  readBinaryFileFromNativeFS,
  readBinaryFileFromNativeFSMultiRoot,
} from './utils/file-reader'

// Workspace runtime (workspace-first API)
export {
  WorkspaceManager,
  WorkspaceRuntime,
  WorkspacePendingManager,
  getWorkspaceManager,
  resetWorkspaceManager,
} from './workspace'
export type { WorkspaceFiles } from './workspace'

// Project
export { ProjectManager, type ProjectInfo } from './project'

// Full OPFS backup (zip) — export & import (full restore)
export {
  exportOPFSBackup,
  downloadOPFSBackup,
  writeOPFSBackupToDirectory,
  DIRECTORY_BACKUP_FILENAME,
  importOPFSBackup,
} from './backup'

// Agent
export {
  AgentManager,
  type AgentMeta,
  type AgentInfo,
  getDefaultAgentTemplate,
  DEFAULT_AGENT_TEMPLATE,
  type AgentTemplate,
} from './agent'
