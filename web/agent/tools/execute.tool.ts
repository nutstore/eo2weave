/**
 * run_python tool - Python code execution.
 *
 * NOTE: This tool is registered as `run_python` (not `python`) to avoid
 * collisions with provider/model built-in tools of the same name (e.g. some
 * Codex/CodeX-compatible models advertise a built-in `python` tool). The
 * runtime executes Python via Pyodide exactly as before; only the tool name
 * exposed to the model has changed.
 */

import { Mutex } from 'async-mutex'
import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { pythonExecutor as runtimePythonExecutor } from '@/python'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useConversationStore } from '@/store/conversation.store'
import type { AssetMeta, FileSnapshot } from '@/types/asset'
import { inferMimeType } from '@/types/asset'
import { toolOkJson, toolErrorJson } from './tool-envelope'

/**
 * Mutex to serialize Python execution on the main thread.
 *
 * The Pyodide worker already serializes actual Python execution via its internal
 * messageQueue, but the main-thread side (OPFS snapshot → execute → diff → register)
 * has shared mutable state that can be corrupted if pi-agent-core dispatches
 * multiple python tool_calls concurrently (e.g. Promise.all).
 *
 * This lock ensures the full snapshot→execute→diff→register cycle runs exclusively,
 * preventing race conditions on:
 *   - OPFS file snapshots (scanFilesWithCache / detectChanges)
 *   - Asset directory snapshots (snapshotAssetsDir / diffAssets)
 *   - Overlay ledger writes (registerDetectedChanges)
 *   - Pending changes refresh (refreshPendingChanges)
 */
const pythonMutex = new Mutex()

//=============================================================================
// Tool Definition
//=============================================================================

export const pythonDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'run_python',
    description: `Execute Python code in browser.

LANGUAGE: python
- Runs via Pyodide (WebAssembly Python runtime)
- Built-in packages (auto-loaded): pandas, numpy, matplotlib, openpyxl, pillow, scipy, sklearn
- For matplotlib: set matplotlib.use('Agg') BEFORE creating figures

Two mounted directories:
- \`/mnt/\` — workspace project files. Read/write project source files here. ALWAYS use /mnt/ prefix. Example: \`open('/mnt/output.csv', 'w')\`
- \`/mnt_assets/\` — asset files (user uploads & generated outputs). Read user-uploaded files and write output files for the user here. Example: \`pd.read_csv('/mnt_assets/data.csv')\`

Workspace files are accessible under \`/mnt/{rootName}/path/to/file\` (always include rootName).

Important:
- The default working directory is /home/pyodide, which is NOT synced. Files written there will be lost.
- /mnt/ reads from OPFS, NOT directly from disk. If you see "A requested file or directory could not be found", the file exists on disk but not in OPFS. Use \`sync(paths=["path/to/file"])\` to copy it to OPFS first, then retry.
- For user-uploaded files (CSV, images, etc.), read from /mnt_assets/.
- Output path policy (must follow strictly):
  - In Plan Mode: write to /mnt_assets/ ONLY — workspace files under /mnt/{rootName}/... must NOT be modified. To work on a workspace file, copy it into the assets sandbox first (shutil.copy2('/mnt/{rootName}/data.csv', '/mnt_assets/data.csv')) and do all reads/writes/execution on that copy. Use sync-to-opfs to pull the file from disk into OPFS if it is not there yet.
  - In Act Mode: if the final result is a normal workspace/project file, write it to /mnt/{rootName}/...
  - /mnt_assets/ is temporary asset storage in OPFS assets and is NOT the default location for normal project deliverables.
  - Use /mnt_assets/ only for temporary intermediate files or when the user explicitly asks for asset-style attachments.
  - Do not default final deliverables to /mnt_assets/ when the expected outcome is a regular workspace file.
- Project skill scripts in .skills/ directory are auto-synced and can be imported directly.
  Example (root "lxy"): \`exec(open('/mnt/lxy/.skills/word-processor/scripts/convert.py').read())\`
  For imports, add the matching scripts directory to \`sys.path\` first.
- Secrets configured in Settings → Secret Manager for the current project are available as Python environment variables. Read a named secret with \`os.getenv("ASSEMBLYAI_API_KEY")\`; never put secret values in code, files, or output.
- For packages NOT in the built-in list, use micropip to install from PyPI before importing:
  Example: \`import micropip; await micropip.install('beautifulsoup4'); from bs4 import BeautifulSoup\`
  Note: Only pure-Pinux packages work with micropip. C-extension packages must be pre-built in Pyodide.

**Network Requests (IMPORTANT)**:
Pyodide runs in the browser and does NOT have native socket access. This means:
- \`urllib.request\`, \`http.client\`, \`requests\`, \`aiohttp\` etc. will NOT work (they depend on OS-level sockets).
- To make HTTP requests in Python, use \`pyodide.http\`:
  - Sync GET: \`from pyodide.http import open_url; response = open_url("https://example.com/api"); data = response.read()\`
  - Async: \`from pyodide.http import pyfetch; resp = await pyfetch("https://example.com/api"); text = await resp.string()\`
- Alternatively, use the browser's fetch API via \`from js import fetch; resp = await fetch(url)\`.
- Do NOT attempt to install \`requests\` or \`urllib3\` via micropip — they cannot work without sockets.

**CJK Font for Matplotlib Charts**:
Pyodide has no CJK fonts. When chart labels/titles contain Chinese/Japanese/Korean characters, fetch and load the bundled font on demand:
\`\`\`python
import matplotlib; matplotlib.use('Agg')
import matplotlib.font_manager as fm, matplotlib.pyplot as plt, tempfile, os
async def load_cjk_font():
    font_name = 'NotoSansSC-Regular.otf'
    tmp_path = os.path.join(tempfile.gettempdir(), font_name)
    if not os.path.exists(tmp_path):
        from pyodide.http import pyfetch
        resp = await pyfetch(f'/assets/fonts/{font_name}')
        with open(tmp_path, 'wb') as f: f.write(await resp.bytes())
    fm.fontManager.addfont(tmp_path)
    plt.rcParams['font.sans-serif'] = ['Noto Sans SC'] + plt.rcParams['font.sans-serif']
    plt.rcParams['axes.unicode_minus'] = False
await load_cjk_font()
\`\`\`
Font file is at \`/assets/fonts/NotoSansSC-Regular.otf\` (bundled, SIL OFL). Only fetch when needed.

**Emoji Limitation**:
matplotlib uses FreeType which cannot render color emoji (COLRv1/CBDT/SBIX formats). All emoji glyphs (🎉🍎🍌 etc.) will appear as empty boxes (tofu). **Do NOT use emoji in chart labels/titles — use plain text labels instead.** This is a fundamental matplotlib limitation, not fixable by adding fonts.

Examples:
- run_python(code="print('hello')")
- run_python(code="import micropip\\nawait micropip.install('beautifulsoup4')\\nfrom bs4 import BeautifulSoup\\nprint(BeautifulSoup('<h1>Hello</h1>', 'html.parser').h1.text)")`,
    parameters: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Python code to execute',
        },
        timeout: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 60000)',
        },
      },
      required: ['code'],
    },
  },
}

const TOOL_NAME = 'run_python'

export const pythonToolExecutor: ToolExecutor = async (args, context) => {
  const code = args.code as string
  const timeout = (args.timeout as number) || 60000

  // Direct conversations have no folder authorization: the (host-inherited)
  // directoryHandle must never reach the python sandbox path. It is only
  // used by registerDetectedChanges to read native host files when recording
  // pending changes — pass null so detection stays OPFS-scoped (same
  // boundary as bash.tool's VFS handler).
  return pythonMutex.runExclusive(() =>
    executePython(
      code,
      timeout,
      context.workspaceId,
      context.directMode ? null : context.directoryHandle,
      context.onWorkspacePathsChanged,
      context.directMode === true,
    )
  )
}

//=============================================================================
// Python Execution
//=============================================================================

interface PythonOutputData {
  stdout?: string
  stderr?: string
  executionTime?: number
}

/**
 * Execute Python code with full OPFS change detection.
 *
 * IMPORTANT: Callers MUST wrap this in pythonMutex.runExclusive() to prevent
 * concurrent snapshot/diff races. Do NOT call this function directly without
 * holding the mutex.
 */
async function executePython(
  code: string,
  timeout: number,
  workspaceId?: string | null,
  directoryHandle?: FileSystemDirectoryHandle | null,
  onWorkspacePathsChanged?: (paths: readonly string[]) => void,
  directMode?: boolean,
): Promise<string> {
  // workspaceId is always provided by the agent loop (= conversationId).
  // If missing, that's a programming error — fail fast.
  if (!workspaceId) {
    return toolErrorJson(TOOL_NAME, 'NO_WORKSPACE', 'workspaceId is required but was not provided (caller bug)')
  }

  const { getWorkspaceManager } = await import('@/opfs')
  const manager = await getWorkspaceManager()
  const workspace = await manager.getWorkspace(workspaceId)
  if (!workspace) {
    return toolErrorJson(TOOL_NAME, 'NO_WORKSPACE', `Workspace not found for id: ${workspaceId}`)
  }
  const active = { conversation: workspace, conversationId: workspaceId }

  try {
    const beforeSnapshot = await active.conversation.scanFilesWithCache()

    // Mount OPFS files/ directory to /mnt so Python writes sync to OPFS directly
    const filesDirHandle = await active.conversation.getFilesDir()

    // Mount OPFS assets/ directory to /mnt_assets for asset file I/O
    const assetsDirHandle = await active.conversation.getAssetsDir()

    // Mount OPFS .skills/ directory to /mnt_skills for builtin skill scripts
    let skillsDirHandle: FileSystemDirectoryHandle | undefined
    try {
      const { getSkillsDirectoryHandle } = await import('@/skills/skills-mount')
      skillsDirHandle = await getSkillsDirectoryHandle()
    } catch (error) {
      console.warn('[execute.tool] Skills dir not available (non-fatal):', error)
    }

    // Take assets snapshot BEFORE execution
    const beforeAssets = await snapshotAssetsDir(assetsDirHandle)

    // Load browser-local secrets for every Python execution. Their values are
    // intentionally kept out of the agent tool schema, workspace files, and logs.
    // In directMode this resolves to {} — see loadRuntimeSecrets.
    const runtimeSecrets = await loadRuntimeSecrets({ directMode })

    // Execute Python code
    const result = await runtimePythonExecutor.execute({
      code,
      timeout,
      mountDir: filesDirHandle,
      assetsDir: assetsDirHandle,
      skillsDir: skillsDirHandle,
      runtimeSecrets,
    })
    const safeResult = redactPythonResult(result, Object.values(runtimeSecrets))

    // Register OPFS delta into overlay ledger for pending/review/sync.
    await active.conversation.scanFilesWithCache()
    const detected = active.conversation.detectChanges(beforeSnapshot)
    if (detected.changes.length > 0) {
      await active.conversation.registerDetectedChanges(detected.changes, directoryHandle)
      onWorkspacePathsChanged?.(detected.changes.map((change) => change.path))
    }
    await useConversationContextStore.getState().refreshPendingChanges(true)

    // Take assets snapshot AFTER execution and diff
    const afterAssets = await snapshotAssetsDir(assetsDirHandle)
    const newAssets = diffAssets(beforeAssets, afterAssets)

    if (safeResult.error) {
      return toolErrorJson(TOOL_NAME, 'EXEC_ERROR', safeResult.error, { retryable: true })
    }

    // Build structured output for PythonRenderer
    const stdoutParts: string[] = []
    if (safeResult.stdout) {
      stdoutParts.push(safeResult.stdout)
    }
    if (safeResult.result !== undefined) {
      stdoutParts.push(redactText(String(safeResult.result), Object.values(runtimeSecrets)))
    }
    if (detected.changes.length > 0) {
      stdoutParts.push(`[conversation] detected ${detected.changes.length} file change(s)`)
    }
    if (newAssets.length > 0) {
      stdoutParts.push(`[assets] generated ${newAssets.length} file(s): ${newAssets.map(a => a.name).join(', ')}`)

      // Accumulate assets into the conversation store's collectedAssets
      // These will be attached to the final assistant message when the draft is committed
      const targetConvId = active.conversationId
      if (targetConvId) {
        useConversationStore.getState().collectAssets(targetConvId, newAssets)
      } else {
        console.warn('[execute.tool] No conversationId! Assets will be lost.')
      }
    }

    const data: PythonOutputData = {
      stdout: stdoutParts.join('\n') || undefined,
      stderr: safeResult.stderr || undefined,
      executionTime: safeResult.executionTime,
    }

    return toolOkJson(TOOL_NAME, data)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Worker timeout/terminate errors are retryable — the worker will be recreated on next call.
    const isTimeout = message.includes('timeout') || message.includes('terminated')
    return toolErrorJson(TOOL_NAME, 'INTERNAL_ERROR', message, { retryable: isTimeout })
  }
}

/** Redact configured secret values from text returned to the agent or UI. */
function redactText(value: string, secretValues: string[]): string {
  return secretValues.reduce(
    (safeValue, secret) => (secret ? safeValue.split(secret).join('[REDACTED]') : safeValue),
    value
  )
}

function redactPythonResult<T extends { stdout?: string; stderr?: string; error?: string; result?: unknown }>(
  result: T,
  secretValues: string[]
): T {
  return {
    ...result,
    stdout: result.stdout === undefined ? undefined : redactText(result.stdout, secretValues),
    stderr: result.stderr === undefined ? undefined : redactText(result.stderr, secretValues),
    error: result.error === undefined ? undefined : redactText(result.error, secretValues),
    result: typeof result.result === 'string' ? redactText(result.result, secretValues) : result.result,
  }
}

/**
 * Load all browser-local secrets into an ephemeral map for the Pyodide worker.
 * The map is created per execution so additions, updates, and deletions in
 * Settings → Secret Manager take effect on the next Python tool call.
 *
 * In directMode (standalone chats) NOTHING is loaded — no project and no
 * global secrets. The sandbox executes model-supplied code that untrusted
 * conversation or fetched content can steer, so any injected value is one
 * `pyfetch` away from exfiltration; output redaction cannot prevent an
 * outbound transfer. This matches web_fetch's direct-mode behavior (secret
 * templates stay unresolved there for the same reason).
 */
async function loadRuntimeSecrets(options?: { directMode?: boolean }): Promise<Record<string, string>> {
  if (options?.directMode) return {}
  try {
    const [{ getAllSecretNames, loadSecret }, { useProjectStore }] = await Promise.all([
      import('@/security/secret-store'),
      import('@/store/project.store'),
    ])
    const projectId = useProjectStore.getState().activeProjectId
    // Even without an active project, global-scoped secrets are still useful.
    // getAllSecretNames(undefined) returns the global-only set.
    const names = await getAllSecretNames(projectId || undefined)
    const entries = await Promise.all(
      names.map(async (name) => {
        const value = await loadSecret(projectId, name)
        return value === null ? null : ([name, value] as const)
      })
    )

    return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => entry !== null))
  } catch (error) {
    // Secret storage must not make unrelated Python work unavailable. The next
    // execution retries the load, and the error never includes a secret value.
    console.warn('[execute.tool] Runtime secrets unavailable; continuing without them:', error)
    return {}
  }
}

//=============================================================================
// Assets Snapshot Helpers
//=============================================================================

/**
 * Scan the assets directory and build a snapshot map of filename → { size, lastModified }.
 * Does NOT read file contents — only fetches lightweight File metadata.
 */
async function snapshotAssetsDir(
  dirHandle: FileSystemDirectoryHandle
): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map()
  for await (const entry of dirHandle.values()) {
    if (entry.kind === 'file') {
      const file = await (entry as FileSystemFileHandle).getFile()
      snapshot.set(entry.name, {
        size: file.size,
        lastModified: file.lastModified,
      })
    }
  }
  return snapshot
}

/**
 * Diff two snapshots and return AssetMeta[] for new or modified files.
 * Reads size from the after snapshot; generates a fresh id and timestamp.
 */
function diffAssets(
  before: FileSnapshot,
  after: FileSnapshot,
): AssetMeta[] {
  const assets: AssetMeta[] = []
  for (const [name, afterEntry] of after) {
    const beforeEntry = before.get(name)
    const isNew = !beforeEntry
    const isModified =
      beforeEntry !== undefined &&
      (beforeEntry.size !== afterEntry.size || beforeEntry.lastModified !== afterEntry.lastModified)

    if (isNew || isModified) {
      assets.push({
        id: crypto.randomUUID(),
        name,
        size: afterEntry.size,
        mimeType: inferMimeType(name),
        direction: 'generated',
        createdAt: Date.now(),
      })
    }
  }
  return assets
}

export const pythonPromptDoc: ToolPromptDoc = {
  category: 'execution',
  section: '### Code Execution (for data/analysis tasks)',
  lines: [
    '- `run_python(code)` - Execute Python with pandas, numpy, matplotlib',
    '  Example: run_python(code="print(\'hello\')")',
  ],
}
