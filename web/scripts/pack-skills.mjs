/**
 * pack-skills.mjs — Package every skill in skill-store/ for web/public/skills.
 *
 * Replaces the former pack-skills.sh + generate-skill-manifest.py pair so the
 * build only needs Node (zip(1) and python3 are NOT guaranteed on lean CI
 * nodes — office-linux failed with "zip: command not found").
 *
 * Zipping uses fflate (already a web dependency, pure JS, no native code).
 * Per skill: skill-store/<name>/ → public/skills/<name>.zip with the skill
 * directory as the archive root (identical layout to `zip -r`), which both
 * generate-skill-manifest consumers and zip-import on the client expect.
 *
 * Usage (from web/): node scripts/pack-skills.mjs [skillStoreDir] [outDir]
 *   defaults: ../skill-store/ → public/skills/
 */
import { zipSync } from 'fflate'
import { readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const webDir = path.resolve(scriptDir, '..')
const src = path.resolve(webDir, process.argv[2] ?? '../skill-store')
const outDir = path.resolve(webDir, process.argv[3] ?? 'public/skills')

/**
 * Minimal SKILL.md frontmatter parser — same field semantics as the retired
 * generate-skill-manifest.py: top-level `key: value`, inline arrays
 * `[a, b, c]`, quoted scalars, and `metadata.skill_version` → version.
 */
function parseFrontmatter(content) {
  const fm = {}
  if (!content.startsWith('---')) return fm
  const end = content.indexOf('---', 3)
  if (end === -1) return fm
  const block = content.slice(3, end)

  let inMetadata = false
  for (const line of block.split('\n')) {
    const stripped = line.trim()
    if (!stripped || stripped.startsWith('#')) continue
    if (stripped === 'metadata:') {
      inMetadata = true
      continue
    }
    if (inMetadata && !/^[\s\t]/.test(line)) inMetadata = false

    const m = stripped.match(/^([\w.\-]+):\s*(.*)$/)
    if (!m) {
      const m2 = line.match(/^\s+(\w+):\s*(.*)$/)
      if (m2 && inMetadata && m2[1] === 'skill_version') {
        fm.version = m2[2].trim().replace(/^["']|["']$/g, '')
      }
      continue
    }
    const [, key, raw] = m
    const val = raw.trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      fm[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      fm[key] = val.replace(/^["']|["']$/g, '')
    }
  }
  return fm
}

/**
 * Recursively collect files under dir into {relativePath: Uint8Array}.
 * Also emits explicit directory entries (`dir/` with empty payload): some
 * unzip implementations only create directories from explicit entries, so
 * omitting them flattens/loses all subdirectories on extraction.
 */
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

async function countFiles(dir) {
  let n = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += await countFiles(path.join(dir, entry.name))
    else n += 1
  }
  return n
}

async function main() {
  if (!(await stat(src).then((s) => s.isDirectory()).catch(() => false))) {
    console.error(`❌ skill-store 目录不存在: ${src}`)
    process.exit(1)
  }
  await mkdir(outDir, { recursive: true })
  // Same cleanup contract as the sh version: fresh output dir each run.
  for (const entry of await readdir(outDir)) {
    if (entry.endsWith('.zip') || entry === 'manifest.json') {
      await rm(path.join(outDir, entry), { force: true })
    }
  }

  console.log('🔗 打包 skill ZIP...')
  const skills = []
  for (const name of (await readdir(src)).sort()) {
    const skillDir = path.join(src, name)
    if (!(await stat(skillDir)).isDirectory()) continue
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    if (!(await stat(skillMdPath).then(Boolean).catch(() => false))) {
      console.log(`⚠️  跳过 ${name}（无 SKILL.md）`)
      continue
    }

    // Archive layout: <skill-name>/ at root — identical to the old
    // (cd skill-store && zip -r out.zip <name>).
    const files = await collectFiles(skillDir)
    const zipped = zipSync(files, { level: 6 })
    await writeFile(path.join(outDir, `${name}.zip`), zipped)
    console.log(`  📦 ${name}.zip`)

    const content = await readFile(skillMdPath, 'utf8')
    const fm = parseFrontmatter(content)
    const localizedDescriptions = Object.fromEntries(
      Object.entries(fm)
        .filter(([k, v]) => k.startsWith('description.') && typeof v === 'string' && v)
        .map(([k, v]) => [k.slice('description.'.length), v]),
    )
    skills.push({
      id: name,
      name: fm.name || name,
      dirName: name,
      // A skill may ship only localized descriptions (`description.zh-CN:`).
      // Fall back to one of them so the base field is never empty — the
      // install page gates rendering on `entry.description` and consumers
      // reading only the base field would otherwise see nothing (#148
      // review round 7: localized skill descriptions stay hidden).
      description: fm.description ?? Object.values(localizedDescriptions)[0] ?? '',
      // Optional localized descriptions (e.g. `description.zh-CN:` in the
      // frontmatter). Purely additive: absent when a skill ships only the
      // base description, so older consumers are unaffected (#140).
      ...(Object.keys(localizedDescriptions).length > 0 ? { description_i18n: localizedDescriptions } : {}),
      category: fm.category || 'general',
      tags: Array.isArray(fm.tags) ? fm.tags : [],
      version: fm.version || '1.0.0',
      zipUrl: `/skills/${name}.zip`,
      fileCount: Object.keys(files).length,
    })
    console.log(`      ${name}: ${skills.at(-1).name} (v${skills.at(-1).version}, ${skills.at(-1).fileCount} files)`)
  }

  const manifest = {
    version: '1.0.0',
    generated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    count: skills.length,
    skills,
  }
  await writeFile(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  )
  console.log(`\n✅ 打包完成 → ${outDir} (${skills.length} skills)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
