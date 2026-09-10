// @ts-nocheck - Worker file with dynamic imports cannot be fully typed
/**
 * Pyodide Worker - Runs Python code in a separate thread using Pyodide
 *
 * Features:
 * - Lazy loads Pyodide from local bundle on first use
 * - Mounts native directories using mountNativeFS
 * - Automatic package loading via loadPackagesFromImports
 * - Captures stdout/stderr for print output
 * - Handles matplotlib image output
 * - Supports file input/output from /mnt
 */

//=============================================================================
// Constants
//=============================================================================

/** Default execution timeout in milliseconds */
const DEFAULT_TIMEOUT = 30000

/** Non-built-in packages to auto-install via micropip when detected in user code.
 *  Key: import name used in Python code
 *  Value: pip package name to install
 */
const MICROPIP_WHITELIST = {
  openpyxl: 'openpyxl',       // Excel (.xlsx) read/write
  docx: 'python-docx',        // Word (.docx) read/write
}

//=============================================================================
// Type Definitions
//=============================================================================

/**
 * @typedef {Object} ImageOutput
 * @property {string} filename
 * @property {string} data - base64
 */

/**
 * @typedef {Object} ExecuteResult
 * @property {boolean} success
 * @property {unknown} [result]
 * @property {string} [stdout]
 * @property {string} [stderr]
 * @property {ImageOutput[]} [images]
 * @property {number} executionTime
 * @property {string} [error]
 */

//=============================================================================
// Worker State
//=============================================================================

/** @type {any} */
let pyodide = null

/** @type {Promise<any>} */
let pyodideReadyPromise = null

/** @type {any} NativeFS handle for syncing changes back */
let nativefs = null

/** @type {FileSystemDirectoryHandle | null} Currently mounted directory handle (to detect workspace switches) */
let mountedDirHandle = null

/** @type {any} NativeFS handle for /mnt_assets syncing */
let nativefsAssets = null

/** @type {FileSystemDirectoryHandle | null} Currently mounted assets directory handle */
let mountedAssetsDirHandle = null

/** @type {any} NativeFS handle for /mnt_skills syncing */
let nativefsSkills = null

/** @type {FileSystemDirectoryHandle | null} Currently mounted skills directory handle */
let mountedSkillsDirHandle = null

/** @type {Promise<void>} Serialize mount/unmount operations to avoid /mnt races */
let fsOpQueue = Promise.resolve()

// Stdout/stderr capture
/** @type {string[]} */
let stdoutBuffer = []
/** @type {string[]} */
let stderrBuffer = []

/** Names injected by the previous execution, used to remove secrets that the
 * user has since deleted from Settings → Secret Manager. */
let injectedRuntimeSecretNames = new Set()

/**
 * Synchronize browser-local secrets into Pyodide's process environment.
 * Values travel through a Pyodide global rather than being interpolated into
 * Python source code, so quote characters in a secret cannot alter the wrapper.
 *
 * @param {Record<string, string> | undefined} runtimeSecrets
 */
async function syncRuntimeSecrets(runtimeSecrets) {
  const secrets = runtimeSecrets || {}
  const previousNames = [...injectedRuntimeSecretNames]

  pyodide.globals.set('__cw_runtime_secrets_json', JSON.stringify(secrets))
  pyodide.globals.set('__cw_previous_runtime_secret_names_json', JSON.stringify(previousNames))

  try {
    await pyodide.runPythonAsync(`
import json as _cw_json
import os as _cw_os

_cw_runtime_secrets = _cw_json.loads(__cw_runtime_secrets_json)
_cw_previous_runtime_secret_names = _cw_json.loads(__cw_previous_runtime_secret_names_json)
for _cw_name in _cw_previous_runtime_secret_names:
    if _cw_name not in _cw_runtime_secrets:
        _cw_os.environ.pop(_cw_name, None)
for _cw_name, _cw_value in _cw_runtime_secrets.items():
    _cw_os.environ[_cw_name] = _cw_value

del _cw_runtime_secrets, _cw_previous_runtime_secret_names
try:
    del _cw_name, _cw_value
except NameError:
    pass
`)
  } finally {
    pyodide.globals.delete('__cw_runtime_secrets_json')
    pyodide.globals.delete('__cw_previous_runtime_secret_names_json')
  }

  injectedRuntimeSecretNames = new Set(Object.keys(secrets))
}

//=============================================================================
// Message Handler
//=============================================================================

/**
 * Initialize Pyodide dynamically (works with classic workers)
 */
async function initPyodide() {
  if (pyodideReadyPromise) return pyodideReadyPromise

  pyodideReadyPromise = (async () => {
    // Keep Pyodide outside Webpack's module graph: its ESM entry exposes
    // Node-only imports (such as node:child_process), which do not belong in
    // a browser worker. The build copies this browser bundle to public/assets.
    importScripts('/assets/pyodide/pyodide.js')
    const { loadPyodide } = self

    // Static-export deployments publish Pyodide at the origin root. A future
    // basePath can be supplied explicitly instead of relying on Vite globals.
    const baseUrl = self.location.pathname.startsWith('/') ? '/' : ''
    const normalizedBaseUrl = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
    const localIndexURL = new URL(`assets/pyodide/`, self.location.origin + normalizedBaseUrl).toString()
    console.log('[Pyodide Worker] Initializing with local indexURL:', localIndexURL)
    const instance = await loadPyodide({ indexURL: localIndexURL })

    // Set up stdout/stderr capture
    instance.setStdout({
      batched: (text) => {
        stdoutBuffer.push(text)
      }
    })
    instance.setStderr({
      batched: (text) => {
        stderrBuffer.push(text)
      }
    })

    return instance
  })()

  return pyodideReadyPromise
}

/**
 * Convert ArrayBuffer to base64 efficiently (without spread operator)
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

/**
 * Send response message to main thread
 * @param {string} id
 * @param {boolean} success
 * @param {object} result
 */
function sendResponse(id, success, result) {
  self.postMessage({ id, success, result })
}

/**
 * Send error response to main thread
 * @param {string} id
 * @param {string} errorMessage
 */
function sendError(id, errorMessage) {
  console.error('[Pyodide Worker] Operation failed:', errorMessage)
  sendResponse(id, false, { success: false, error: errorMessage })
}

/**
 * Run filesystem mount-point mutations sequentially to avoid race conditions.
 * @template T
 * @param {() => Promise<T>} operation
 * @returns {Promise<T>}
 */
async function runExclusiveFSOperation(operation) {
  let release
  const next = new Promise((resolve) => {
    release = resolve
  })
  const previous = fsOpQueue
  fsOpQueue = next
  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

/**
 * Cleanup nativefs references (no sync - caller handles sync if needed)
 */
async function cleanupNativeFS() {
  if (!nativefs) return
  nativefs = null
  mountedDirHandle = null
}

/**
 * Cleanup nativefsAssets references
 */
async function cleanupAssetsFS() {
  if (!nativefsAssets) return
  nativefsAssets = null
  mountedAssetsDirHandle = null
}

/**
 * Cleanup nativefsSkills references
 */
async function cleanupSkillsFS() {
  if (!nativefsSkills) return
  nativefsSkills = null
  mountedSkillsDirHandle = null
}

/**
 * Unmount and remove /mnt directory completely
 */
async function unmountAndRemoveMnt() {
  if (!pyodide) return

  // Cleanup nativefs first
  await cleanupNativeFS()

  // Unmount /mnt first (idempotent: ignore "not mounted" failures)
  try {
    pyodide.FS.unmount('/mnt')
    console.log('[Pyodide Worker] Unmounted /mnt')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] Unmount skipped/failed:', msg)
  }

  // Remove /mnt and all child entries if it exists
  try {
    const mntPath = pyodide.FS.analyzePath('/mnt')
    if (mntPath.exists) {
      rmrf('/mnt')
      console.log('[Pyodide Worker] Removed /mnt directory')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] Directory removal failed:', msg)
  }
}

/**
 * Recursively remove all entries under a path, then remove the directory itself.
 * @param {string} path
 */
function rmrf(path) {
  try {
    const stat = pyodide.FS.stat(path)
    if (!pyodide.FS.isDir(stat.mode)) {
      try {
        pyodide.FS.unlink(path)
      } catch {
        // ignore: entry already gone, nothing to clean up
      }
      return
    }
  } catch {
    return
  }

  try {
    const entries = pyodide.FS.readdir(path).filter((e) => e !== '.' && e !== '..')
    for (const entry of entries) {
      rmrf(`${path}/${entry}`)
    }
  } catch {
    // ignore: readdir failed mid-recursion, best-effort cleanup
  }

  try {
    pyodide.FS.rmdir(path)
  } catch {
    // ignore: directory already removed or still in use
  }
}

/**
 * Unmount and remove /mnt_assets directory completely (internal, no mutex).
 * Caller must hold runExclusiveFSOperation if needed.
 */
async function unmountAndRemoveMntAssetsRaw() {
  if (!pyodide) return

  await cleanupAssetsFS()

  try {
    pyodide.FS.unmount('/mnt_assets')
    console.log('[Pyodide Worker] Unmounted /mnt_assets')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] /mnt_assets unmount skipped/failed:', msg)
  }

  try {
    const mntAssetsPath = pyodide.FS.analyzePath('/mnt_assets')
    if (mntAssetsPath.exists) {
      rmrf('/mnt_assets')
      console.log('[Pyodide Worker] Removed /mnt_assets directory')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] /mnt_assets directory removal failed:', msg)
  }
}

/**
 * Unmount and remove /mnt_skills directory completely (internal, no mutex).
 * Caller must hold runExclusiveFSOperation if needed.
 */
async function unmountAndRemoveMntSkillsRaw() {
  if (!pyodide) return

  await cleanupSkillsFS()

  try {
    pyodide.FS.unmount('/mnt_skills')
    console.log('[Pyodide Worker] Unmounted /mnt_skills')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] /mnt_skills unmount skipped/failed:', msg)
  }

  try {
    const mntSkillsPath = pyodide.FS.analyzePath('/mnt_skills')
    if (mntSkillsPath.exists) {
      rmrf('/mnt_skills')
      console.log('[Pyodide Worker] Removed /mnt_skills directory')
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] /mnt_skills directory removal failed:', msg)
  }
}

/**
 * Mount assets directory handle to /mnt_assets using mountNativeFS.
 * Remounts only when the handle changes; uses syncfs(true) for same-handle refresh.
 * @param {FileSystemDirectoryHandle} dirHandle - Assets directory to mount
 */
async function ensureAssetsMounted(dirHandle) {
  return runExclusiveFSOperation(async () => {
    if (!pyodide) {
      throw new Error('Pyodide not initialized. Call initPyodide() first.')
    }

    // Check if the same handle is already mounted
    const sameHandle = mountedAssetsDirHandle && mountedAssetsDirHandle.isSameEntry
      ? await mountedAssetsDirHandle.isSameEntry(dirHandle)
      : false

    if (nativefsAssets && sameHandle) {
      try {
        await new Promise((resolve, reject) => {
          pyodide.FS.syncfs(true, (err) => {
            if (err) reject(err)
            else resolve(undefined)
          })
        })
        console.log('[Pyodide Worker] /mnt_assets refreshed via syncfs')
        return
      } catch {
        // ignore: refresh failure is non-fatal, fall through to a full remount below
      }
    }

    console.log('[Pyodide Worker] Mounting assets directory:', dirHandle.name)

    // Clean up stale mount
    await unmountAndRemoveMntAssetsRaw()

    // Create /mnt_assets mount point
    if (!pyodide.FS.analyzePath('/mnt_assets').exists) {
      pyodide.FS.mkdir('/mnt_assets')
    }

    try {
      nativefsAssets = await pyodide.mountNativeFS('/mnt_assets', dirHandle)
      mountedAssetsDirHandle = dirHandle
      console.log(`[Pyodide Worker] Assets directory "${dirHandle.name}" mounted at /mnt_assets`)
    } catch (mountError) {
      const mountMsg = mountError instanceof Error ? mountError.message : String(mountError)
      if (mountMsg.includes('already a file system mount point')) {
        console.warn('[Pyodide Worker] Detected stale /mnt_assets mount point, retrying')
        await unmountAndRemoveMntAssetsRaw()
        if (!pyodide.FS.analyzePath('/mnt_assets').exists) {
          pyodide.FS.mkdir('/mnt_assets')
        }
        nativefsAssets = await pyodide.mountNativeFS('/mnt_assets', dirHandle)
        mountedAssetsDirHandle = dirHandle
        console.log(`[Pyodide Worker] Assets directory "${dirHandle.name}" mounted at /mnt_assets (retry)`)
      } else {
        console.error('[Pyodide Worker] /mnt_assets mount failed:', mountMsg)
        throw mountError
      }
    }
  })
}

/**
 * Mount global .skills directory handle to /mnt_skills using mountNativeFS.
 * Remounts only when the handle changes; uses syncfs(true) for same-handle refresh.
 * @param {FileSystemDirectoryHandle} dirHandle - Skills directory to mount
 */
async function ensureSkillsMounted(dirHandle) {
  return runExclusiveFSOperation(async () => {
    if (!pyodide) {
      throw new Error('Pyodide not initialized. Call initPyodide() first.')
    }

    const sameHandle = mountedSkillsDirHandle && mountedSkillsDirHandle.isSameEntry
      ? await mountedSkillsDirHandle.isSameEntry(dirHandle)
      : false

    if (nativefsSkills && sameHandle) {
      try {
        await new Promise((resolve, reject) => {
          pyodide.FS.syncfs(true, (err) => {
            if (err) reject(err)
            else resolve(undefined)
          })
        })
        console.log('[Pyodide Worker] /mnt_skills refreshed via syncfs')
        return
      } catch {
        console.warn('[Pyodide Worker] /mnt_skills syncfs failed, falling back to remount')
      }
    }

    console.log('[Pyodide Worker] Mounting skills directory:', dirHandle.name)

    await unmountAndRemoveMntSkillsRaw()

    if (!pyodide.FS.analyzePath('/mnt_skills').exists) {
      pyodide.FS.mkdir('/mnt_skills')
    }

    try {
      nativefsSkills = await pyodide.mountNativeFS('/mnt_skills', dirHandle)
      mountedSkillsDirHandle = dirHandle
      console.log(`[Pyodide Worker] Skills directory "${dirHandle.name}" mounted at /mnt_skills`)
    } catch (mountError) {
      const mountMsg = mountError instanceof Error ? mountError.message : String(mountError)
      if (mountMsg.includes('already a file system mount point')) {
        console.warn('[Pyodide Worker] Detected stale /mnt_skills mount point, retrying')
        await unmountAndRemoveMntSkillsRaw()
        if (!pyodide.FS.analyzePath('/mnt_skills').exists) {
          pyodide.FS.mkdir('/mnt_skills')
        }
        nativefsSkills = await pyodide.mountNativeFS('/mnt_skills', dirHandle)
        mountedSkillsDirHandle = dirHandle
        console.log(`[Pyodide Worker] Skills directory "${dirHandle.name}" mounted at /mnt_skills (retry)`)
      } else {
        console.error('[Pyodide Worker] /mnt_skills mount failed:', mountMsg)
        throw mountError
      }
    }
  })
}

/**
 * Populate /mnt from OPFS using FS.syncfs(true).
 * This refreshes the PROXYFS cache to reflect external OPFS changes
 * (e.g. files written by agent tools on the main thread)
 * without the overhead of a full unmount + remount cycle.
 */
async function syncFromOPFSRaw() {
  if (!pyodide || !nativefs) return
  try {
    await new Promise((resolve, reject) => {
      pyodide.FS.syncfs(true, (err) => {
        if (err) reject(err)
        else resolve(undefined)
      })
    })
    console.log('[Pyodide Worker] syncfs(true) populated from OPFS')
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[Pyodide Worker] syncfs(true) failed:', msg)
    throw error
  }
}

/**
 * Mount directory handle to /mnt using mountNativeFS.
 * Only mounts on first call; subsequent calls use syncfs(true) to refresh.
 * @param {FileSystemDirectoryHandle} dirHandle - Directory to mount
 */
async function ensureMounted(dirHandle) {
  return runExclusiveFSOperation(async () => {
    // Validate pyodide is initialized
    if (!pyodide) {
      throw new Error('Pyodide not initialized. Call initPyodide() first.')
    }

    // Check if the same directory handle is already mounted
    const sameHandle = mountedDirHandle && mountedDirHandle.isSameEntry
      ? await mountedDirHandle.isSameEntry(dirHandle)
      : false

    // If already mounted with the same handle, just sync from OPFS to refresh cache
    if (nativefs && sameHandle) {
      try {
        // IMPORTANT: already inside runExclusiveFSOperation in ensureMounted.
        // Calling the locked wrapper here causes lock re-entry deadlock.
        await syncFromOPFSRaw()
        return
      } catch (syncErr) {
        // syncfs failed — OPFS mount state is likely corrupted.
        // Fall through to full remount to recover.
        console.warn('[Pyodide Worker] syncfs refresh failed, forcing full remount:', syncErr instanceof Error ? syncErr.message : String(syncErr))
      }
    }

    if (nativefs && !sameHandle) {
      console.log('[Pyodide Worker] Different workspace detected, switching mount')
    }

    if (!nativefs && !sameHandle && mountedDirHandle) {
      // nativefs is null but mountedDirHandle is set — previous mount was lost
      // (e.g. OPFS DOMException corrupted the worker state). Force cleanup.
      console.warn('[Pyodide Worker] Mount state lost (nativefs=null but handle set), forcing remount')
      mountedDirHandle = null
    }

    console.log('[Pyodide Worker] Mounting directory:', dirHandle.name)

    // Clean up any stale mount
    await unmountAndRemoveMnt()

    // Create /mnt directory for mount point
    if (!pyodide.FS.analyzePath('/mnt').exists) {
      pyodide.FS.mkdir('/mnt')
    }

    // Mount using mountNativeFS
    try {
      nativefs = await pyodide.mountNativeFS('/mnt', dirHandle)
      mountedDirHandle = dirHandle
      console.log(`[Pyodide Worker] Directory "${dirHandle.name}" mounted at /mnt`)
    } catch (mountError) {
      const mountMsg = mountError instanceof Error ? mountError.message : String(mountError)
      if (mountMsg.includes('already a file system mount point')) {
        console.warn('[Pyodide Worker] Detected stale mount point, retrying mount once')
        await unmountAndRemoveMnt()
        if (!pyodide.FS.analyzePath('/mnt').exists) {
          pyodide.FS.mkdir('/mnt')
        }
        nativefs = await pyodide.mountNativeFS('/mnt', dirHandle)
        mountedDirHandle = dirHandle
        console.log(`[Pyodide Worker] Directory "${dirHandle.name}" mounted at /mnt (retry)`)
        return
      }
      console.error('[Pyodide Worker] Mount failed:', mountMsg)
      throw mountError
    }
  })
}

/**
 * Unmount directory and remove /mnt
 * Called when user releases the folder
 */
async function unmountDir() {
  return runExclusiveFSOperation(async () => {
    console.log('[Pyodide Worker] Unmounting directory and removing /mnt')
    await unmountAndRemoveMnt()
  })
}

/**
 * Capture and clear stdout/stderr buffers
 * @returns {{ stdout?: string, stderr?: string }}
 */
function captureOutput() {
  const stdout = stdoutBuffer.join('\n')
  const stderr = stderrBuffer.join('\n')
  stdoutBuffer = []
  stderrBuffer = []
  return {
    stdout: stdout || undefined,
    stderr: stderr || undefined,
  }
}

self.onmessage = (/** @type {MessageEvent<any>} */ e) => {
  // Queue all messages for serial execution to prevent concurrent access
  // to shared pyodide instance and /mnt filesystem
  const previous = messageQueue
  messageQueue = previous
    .catch((error) => {
      // Keep queue alive after any unexpected prior failure.
      console.error('[Pyodide Worker] Recovered from prior queue failure:', error)
    })
    .then(() => handleMessage(e.data))
    .catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error('[Pyodide Worker] Unhandled message failure:', errorMessage)
      try {
        const requestId =
          e.data && typeof e.data === 'object' && 'id' in e.data ? String(e.data.id) : 'unknown'
        sendError(requestId, errorMessage)
      } catch {
        // Ignore secondary failures while reporting fatal worker errors.
      }
    })
}

/**
 * Serial message queue - ensures only one message is processed at a time.
 * This prevents concurrent pyodide.runPythonAsync calls which would corrupt
 * shared state (global Python scope, /mnt filesystem, stdout/stderr buffers).
 */
let messageQueue = Promise.resolve()

/**
 * Handle a single message (called serially via messageQueue)
 */
async function handleMessage(/** @type {any} */ data) {
  const { id, type } = data

  // Handle 'warmup' type - pre-initialize Pyodide without executing code
  if (type === 'warmup') {
    try {
      if (!pyodide) {
        console.log('[Pyodide Worker] Warmup: initializing Pyodide...')
        pyodide = await initPyodide()
        console.log('[Pyodide Worker] Warmup complete')
      }
      sendResponse(id, true, { success: true })
    } catch (error) {
      sendError(id, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // Handle 'mount' type - mount a directory to /mnt
  if (type === 'mount') {
    try {
      if (!pyodide) {
        pyodide = await initPyodide()
      }
      await ensureMounted(data.dirHandle)
      sendResponse(id, true, { success: true })
    } catch (error) {
      sendError(id, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // Handle 'mountSkills' type - mount global .skills directory to /mnt_skills
  if (type === 'mountSkills') {
    try {
      if (!pyodide) {
        pyodide = await initPyodide()
      }
      await ensureSkillsMounted(data.dirHandle)
      sendResponse(id, true, { success: true })
    } catch (error) {
      sendError(id, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // Handle 'sync' type - sync changes back to native filesystem
  if (type === 'sync') {
    try {
      if (nativefs) {
        await nativefs.syncfs()
        console.log('[Pyodide Worker] Filesystem synced successfully')
        sendResponse(id, true, { success: true })
      } else {
        sendError(id, 'No mounted filesystem to sync')
      }
    } catch (error) {
      sendError(id, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // Handle 'unmount' type - cleanup filesystem and remove /mnt
  if (type === 'unmount') {
    try {
      await unmountDir()
      await runExclusiveFSOperation(() => unmountAndRemoveMntAssetsRaw())
      await runExclusiveFSOperation(() => unmountAndRemoveMntSkillsRaw())
      console.log('[Pyodide Worker] Filesystem unmounted and /mnt, /mnt_assets, /mnt_skills removed')
      sendResponse(id, true, { success: true })
    } catch (error) {
      sendError(id, error instanceof Error ? error.message : String(error))
    }
    return
  }

  // Handle 'execute' type - run Python code
  const { code, timeout = DEFAULT_TIMEOUT, mountDir, assetsDir, syncFs = true, runtimeSecrets } = data

  const startTime = performance.now()
  /** @type {number | undefined} */
  let timeoutId = undefined

  try {
    // Initialize Pyodide on first use
    if (!pyodide) {
      pyodide = await initPyodide()
    }

    // Handle mountDir if provided (mountNativeFS)
    if (mountDir) {
      await ensureMounted(mountDir)
    }

    // Handle assetsDir if provided — mount at /mnt_assets
    if (assetsDir) {
      await ensureAssetsMounted(assetsDir)
    }

    // Handle skillsDir if provided — mount at /mnt_skills
    if (data.skillsDir) {
      await ensureSkillsMounted(data.skillsDir)
    }

    // Synchronize browser-local secrets immediately before loading/running the
    // submitted code. Every Python execution receives the latest settings.
    await syncRuntimeSecrets(runtimeSecrets)

    // Step 1: Load built-in Pyodide packages via import scanning
    // loadPackagesFromImports automatically scans imports and loads all built-in
    // Pyodide packages (numpy, pandas, matplotlib, etc.). Already-loaded packages
    // are skipped with zero network overhead.
    try {
      await pyodide.loadPackagesFromImports(code)
    } catch {
      // If find_imports fails (e.g. syntax error in user code), skip silently.
      // runPythonAsync below will produce a more precise error message.
    }

    // Step 1.5: Pandas dependency patch
    // Pyodide's loadPackagesFromImports loads pandas but does NOT auto-activate
    // its runtime dependency 'six' (included in Pyodide distribution but not
    // installed). This causes a circular-import crash on `import pandas`:
    //   dateutil → six (missing) → pandas partially initialized → _pandas_datetime_CAPI not found
    // Pre-loading 'six' when pandas is detected prevents this.
    // Ref: https://github.com/pandas-dev/pandas/issues/59527
    if (/(?:^|\n)\s*(?:import|from)\s+pandas\b/.test(code)) {
      try {
        await pyodide.loadPackage('six')
      } catch {
        // six may already be loaded, safe to ignore
      }
    }

    // Step 2: Auto-install non-built-in packages from micropip whitelist
    // These are pure-Python packages not included in Pyodide's built-in set.
    // micropip.install() skips already-installed packages, so repeated calls
    // have zero cost.
    const packagesToInstall = []
    for (const [importName, pipName] of Object.entries(MICROPIP_WHITELIST)) {
      const importRegex = new RegExp('(?:^|\\n)\\s*(?:import|from)\\s+' + importName + '\\b')
      if (importRegex.test(code)) {
        packagesToInstall.push(pipName)
      }
    }

    if (packagesToInstall.length > 0) {
      console.log(`[Pyodide Worker] Auto-installing via micropip: ${packagesToInstall.join(', ')}`)
      await pyodide.loadPackage('micropip')
      const micropip = pyodide.pyimport('micropip')
      await micropip.install(packagesToInstall)
    }

    // Step 3: Execute user code
    const executePromise = pyodide.runPythonAsync(code)
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`Execution timeout after ${timeout}ms`)), timeout)
    })
    const result = await Promise.race([executePromise, timeoutPromise])

    const executionTime = performance.now() - startTime

    // Check if result is an error
    if (result && typeof result === 'object' && 'error' in result) {
      throw new Error(`${result.error}\n\n${result.traceback}`)
    }

    // Sync changes back to native filesystem if requested
    if (syncFs && nativefs) {
      await nativefs.syncfs()
      console.log('[Pyodide Worker] Synced changes back to native filesystem')
    }

    // Sync assets changes back if assets were mounted
    if (syncFs && nativefsAssets) {
      await nativefsAssets.syncfs()
      console.log('[Pyodide Worker] Synced assets changes back to native filesystem')
    }

    // Collect matplotlib images
    const images = await collectMatplotlibImages(pyodide)

    // Get captured output and clear buffers
    const output = captureOutput()

    sendResponse(id, true, {
      success: true,
      result,
      images: images.length > 0 ? images : undefined,
      executionTime,
      ...output,
    })
  } catch (error) {
    const executionTime = performance.now() - startTime
    const errorMessage = error instanceof Error ? error.message : String(error)


    // Capture output before clearing (for error context)
    const output = captureOutput()

    sendResponse(id, true, {
      success: false,
      executionTime,
      error: errorMessage,
      ...output,
    })
  } finally {
    // Always cleanup timeout
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId)
    }
  }
}

//=============================================================================
// Image Collection
//=============================================================================

/**
 * Collect matplotlib images from /mnt and in-memory figures
 * @param {any} pyodide
 * @returns {Promise<ImageOutput[]>}
 */
async function collectMatplotlibImages(pyodide) {
  try {
    // Check /mnt for saved images
    const checkMntCode = `
import os
image_paths = []
if os.path.exists('/mnt'):
    for file in os.listdir('/mnt'):
        if file.endswith('.png') or file.endswith('.jpg') or file.endswith('.jpeg'):
            image_paths.append(f'/mnt/{file}')
image_paths
`

    /** @type {any} */
    const imagePaths = await pyodide.runPythonAsync(checkMntCode)

    /** @type {ImageOutput[]} */
    const images = []

    // Read saved image files from /mnt
    for (const imagePath of imagePaths) {
      if (String(imagePath).startsWith('/mnt/')) {
        const fileName = String(imagePath).split('/').pop()
        try {
          const data = pyodide.FS.readFile(imagePath)
          const base64 = arrayBufferToBase64(data)
          images.push({
            filename: fileName,
            data: base64,
          })
        } catch (error) {
          console.warn(`[Pyodide Worker] Failed to read image ${imagePath}:`, error)
        }
      }
    }

    // Try to collect in-memory matplotlib figures
    try {
      const figureCode = `
import io
import base64
import matplotlib.pyplot as plt

figure_data = []
if len(plt.get_fignums()) > 0:
    for i, fig_num in enumerate(plt.get_fignums()):
        fig = plt.figure(fig_num)
        buf = io.BytesIO()
        fig.savefig(buf, format='png', bbox_inches='tight')
        buf.seek(0)
        img_data = base64.b64encode(buf.read()).decode('utf-8')
        figure_data.append({'index': i, 'data': img_data})
    plt.close('all')
figure_data
`
      /** @type {any} */
      const figureData = await pyodide.runPythonAsync(figureCode)

      for (const fig of figureData) {
        images.push({
          filename: `figure_${fig.index}.png`,
          data: fig.data,
        })
      }
    } catch {
      // matplotlib not loaded or no figures
    }

    return images
  } catch (error) {
    console.warn('[Pyodide Worker] Failed to collect matplotlib images:', error)
    return []
  }
}
