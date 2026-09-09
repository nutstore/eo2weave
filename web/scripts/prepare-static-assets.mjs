import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'
import { realpath } from 'node:fs/promises'

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const rootDir = path.resolve(webDir, '..')
const publicDir = path.join(webDir, 'public')

// Deterministic recursive copy — deliberately NOT fs.cp({dereference: true}).
//
// Why: pnpm installs packages as symlinks, and pyodide's package directory
// itself contains symlinks (node_modules/ws, node_modules/@types/emscripten —
// sibling .pnpm deps). fs.cp with dereference walks those and intermittently
// throws EEXIST/ERR_FS_CP_EINVAL from its internal destination mkdir (verified
// on Node v22.22, timing-dependent). Copying entries explicitly keeps the
// behavior fixed.
//
// Symlinks are SKIPPED: they are node-side deps the browser never requests
// (the python worker only fetches pyodide.js/*.wasm/*.whl via /assets/pyodide).
async function copyDirContents(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(destination, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await copyDirContents(from, to)
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from))
    }
  }
}

async function copy(source, destination) {
  await rm(destination, { recursive: true, force: true })
  // Resolve the pnpm top-level symlink so the walk starts inside the real
  // package directory (entry.isDirectory() etc. on a symlink Dirent would
  // report the link, not the target).
  const realSource = await realpath(source)
  await copyDirContents(realSource, destination)
}

await copy(path.join(webDir, 'node_modules', 'pyodide'), path.join(publicDir, 'assets', 'pyodide'))

// Docs no longer need a build-time copy into public/: the App Router docs
// route resolves them server-side from the repository docs/ tree at build
// time (see lib/docs-server.ts and app/(app)/docs/[[...path]]/page.tsx).

execFileSync('node', ['scripts/pack-skills.mjs', '../skill-store', 'public/skills'], {
  cwd: webDir,
  stdio: 'inherit',
})

execFileSync('pnpm', ['run', 'build'], {
  cwd: path.join(rootDir, 'browser-extension'),
  stdio: 'inherit',
})

const extensionDir = path.join(rootDir, 'browser-extension', 'dist', 'chrome-mv3')
await copy(extensionDir, path.join(publicDir, 'extension'))
// Zip with fflate: CI nodes (office-linux) have no zip(1). Layout matches the
// former `zip -r chrome-extension.zip extension` (files under extension/).
// Collects files plus explicit directory entries (`dir/`): some unzip
// implementations only recreate directories from explicit entries, so
// omitting them loses all subdirectories on extraction.
async function collectFiles(dir, base = dir, acc = {}) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const dirRel = path.relative(base, full).split(path.sep).join('/')
      if (dirRel) acc[`${dirRel}/`] = new Uint8Array(0)
      await collectFiles(full, base, acc)
    } else {
      const rel = path.relative(base, full).split(path.sep).join('/')
      acc[rel] = new Uint8Array(await readFile(full))
    }
  }
  return acc
}
{
  const extDir = path.join(publicDir, 'extension')
  const files = await collectFiles(extDir)
  // Store paths relative to publicDir's `extension/` root so the archive
  // matches the previous `cd public && zip -r chrome-extension.zip extension`:
  // every entry starts with `extension/`.
  const prefixed = Object.fromEntries(
    Object.entries(files).map(([rel, data]) => [`extension/${rel}`, data]),
  )
  await writeFile(path.join(publicDir, 'chrome-extension.zip'), zipSync(prefixed, { level: 6 }))
}
