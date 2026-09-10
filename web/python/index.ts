/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Python Execution Module - Pyodide integration for browser-based Python
 *
 * This module provides Python code execution capabilities in the browser using Pyodide:
 * - Main API through PythonExecutor class
 * - Web Worker for non-blocking Python execution
 * - Type definitions for execution interfaces
 * - Configuration constants
 * - Package management for Python dependencies
 * - Utility functions for result handling
 *
 * @example
 * ```ts
 * import { pythonExecutor } from '@/python'
 *
 * // Execute simple Python code
 * const result = await pythonExecutor.execute({
 *   code: 'print("Hello, World!")'
 * })
 * ```
 */

//=============================================================================
// Main Python Execution API
//=============================================================================

/**
 * PythonExecutor - Main class for Python code execution
 *
 * Provides a high-level API for executing Python code using Pyodide worker.
 * Manages worker lifecycle, file I/O, package loading, and image output.
 */
export { PythonExecutor } from './api'
export type { PyodideState } from './api'
export type {
  ExecuteRequest,
  ExecuteResult,
  FileOutput,
  ImageOutput,
  WorkerResponse,
} from './worker-types'

//=============================================================================
// Utility Functions
//=============================================================================

/**
 * Utility functions for Python execution
 *
 * - generateId: Generate unique execution IDs
 * - formatTime: Format execution time
 * - serializeResult: Serialize Python results to JSON
 * - detectMatplotlibImages: Detect matplotlib output
 * - logger: Module logging
 * - cleanupTempFiles: Clean up Pyodide filesystem
 * - formatExecutionResult: Format execution results
 * - isExecutionSuccessful: Check result status
 * - fileOutputToBlob / fileOutputToText / fileOutputToDataUrl / downloadFileOutput
 */
export * from './utils'

//=============================================================================
// Core types (for file bridge layer)
//=============================================================================

export type {
  PyodideFileMeta,
  BridgeResult,
  PyodideInstance,
} from './types'

// Constants
export {
  PYODIDE_BASE_URL,
  DEFAULT_TIMEOUT,
  MOUNT_POINT,
  PYTHON_PACKAGES,
  type PythonPackage,
  MAX_CODE_SIZE,
  MAX_OUTPUT_SIZE,
} from './constants'

// Package management
export { PackageManager } from './packages'

//=============================================================================
// Singleton Instance
//=============================================================================

/**
 * Global Python executor singleton
 *
 * Pre-configured instance ready for use throughout the application.
 * Automatically manages worker lifecycle on first use.
 *
 * @example
 * ```ts
 * import { pythonExecutor } from '@/python'
 *
 * // Execute code
 * const result = await pythonExecutor.execute({
 *   code: 'print("Hello!")'
 * })
 * ```
 */
export { pythonExecutor } from './api'
import { pythonExecutor } from './api'

//=============================================================================
// Window Binding (for Agent Tool Integration)
//=============================================================================

/**
 * Bind pythonExecutor to window object for Agent tool access.
 * This allows the Agent to execute Python code through the global scope.
 */
if (typeof window !== 'undefined') {
  (window as any).pythonExecutor = pythonExecutor
}
