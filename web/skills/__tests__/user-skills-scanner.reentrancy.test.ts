/**
 * Regression test for the #185 review round-N HIGH finding: the skill
 * creation path DEADLOCKED.
 *
 * `createSkillSkeleton` holds the per-directory import serializer while
 * writing SKILL.md. The write helper it used (`writeUserSkillMd`) re-acquired
 * the SAME serializer, so the inner call queued behind the outer hold (the
 * in-tab mutex chain resolves the inner slot only when the outer releases)
 * while the outer waited for the inner to finish — creation never completed.
 *
 * This test drives the REAL serializer (no mocked lock) and asserts that a
 * write issued from inside a serialized section COMPLETES. Before the fix
 * the promise never settled and the test timed out.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: { getState: () => ({ skills: [] }) },
}))

import {
  writeUserSkillMd,
  writeUserSkillMdLocked,
  withSkillImportSerialization,
} from '@/skills/user-skills-scanner'

// ── Minimal OPFS test double ─────────────────────────────────────────

type FakeFile = { data: Uint8Array }
type FakeDir = { dirs: Map<string, FakeDir>; files: Map<string, FakeFile> }

const makeDir = (): FakeDir => ({ dirs: new Map(), files: new Map() })

const dirOf = (root: FakeDir, path: string, create: boolean): FakeDir | null => {
  let current = root
  for (const part of path.split('/').filter(Boolean)) {
    let next = current.dirs.get(part)
    if (!next) {
      if (!create) return null
      next = makeDir()
      current.dirs.set(part, next)
    }
    current = next
  }
  return current
}

const buildDir = (path: string, root: FakeDir): FileSystemDirectoryHandle => {
  const self: FileSystemDirectoryHandle = {
    kind: 'directory',
    name: path.split('/').pop() ?? '',
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      const dir = dirOf(root, path, true)!
      let file = dir.files.get(name)
      if (!file) {
        if (!opts?.create) throw new Error(`NotFoundError: ${path}/${name}`)
        file = { data: new Uint8Array() }
        dir.files.set(name, file)
      }
      const handle = {
        kind: 'file',
        name,
        getFile: async () => new File([file!.data], name),
        createWritable: async () =>
          ({
            write: async (data: string) => {
              file!.data = new TextEncoder().encode(data)
            },
            close: async () => {},
          }) as unknown as FileSystemWritableFileStream,
      } as unknown as FileSystemFileHandle
      return handle
    },
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      const dir = dirOf(root, path, true)!
      if (!dir.dirs.has(name)) {
        if (!opts?.create) throw new Error(`NotFoundError: ${path}/${name}`)
        dir.dirs.set(name, makeDir())
      }
      return buildDir(path ? `${path}/${name}` : name, root)
    },
    removeEntry: async (name: string) => {
      const dir = dirOf(root, path, false)
      if (!dir) throw new Error(`NotFoundError: ${path}/${name}`)
      dir.dirs.delete(name)
      dir.files.delete(name)
    },
    entries: async function* () {
      const dir = dirOf(root, path, false)
      if (!dir) return
      for (const name of dir.dirs.keys()) {
        yield [name, buildDir(path ? `${path}/${name}` : name, root)] as const
      }
    },
    values: async function* () {
      for await (const [, entry] of self.entries()) yield entry
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
  return self
}

let userRoot: FakeDir

/** A minimal Web Locks implementation: `request(name, cb)` runs `cb`
 * immediately, but a request for a name ALREADY HELD must wait for the
 * holder to release — the property the real serializer relies on. */
const heldLocks = new Map<string, Promise<void>>()

const makeLocks = () => ({
  request: async <T>(name: string, cb: (lock: unknown) => Promise<T> | T): Promise<T> => {
    const prev = heldLocks.get(name)
    let release!: () => void
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    heldLocks.set(name, mine)
    if (prev) await prev
    try {
      return await cb({ name })
    } finally {
      release()
      if (heldLocks.get(name) === mine) heldLocks.delete(name)
    }
  },
})

beforeEach(() => {
  userRoot = makeDir()
  heldLocks.clear()
  ;(navigator as unknown as { storage: unknown }).storage = {
    getDirectory: async () => buildDir('', userRoot),
  }
  Object.defineProperty(navigator, 'locks', {
    value: makeLocks(),
    configurable: true,
  })
})

describe('per-directory serializer reentrancy (#185 review round N)', () => {
  it('completes a write issued from INSIDE a serialized section', async () => {
    // The exact shape that deadlocked: the caller holds the serializer and
    // then writes the file. The write must NOT try to re-acquire it.
    const write = withSkillImportSerialization(['demo'], async () => {
      await writeUserSkillMdLocked('demo', '# demo')
      return 'done'
    })

    await expect(
      Promise.race([
        write,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('TIMEOUT: the write deadlocked')), 2000),
        ),
      ]),
    ).resolves.toBe('done')

    const dir = dirOf(userRoot, '.skills/user/demo', false)
    expect(dir?.files.get('SKILL.md')?.data).toBeTruthy()
  })

  it('keeps the public writeUserSkillMd lock-acquiring (no behaviour change)', async () => {
    // The public helper still takes the lock itself — callers that are NOT
    // inside a serialized section keep the cross-tab guarantee.
    await writeUserSkillMd('solo', '# solo')
    const dir = dirOf(userRoot, '.skills/user/solo', false)
    expect(dir?.files.get('SKILL.md')?.data).toBeTruthy()
  })

  it('serializes two overlapping writes to the same directory', async () => {
    const order: string[] = []
    const a = withSkillImportSerialization(['same'], async () => {
      order.push('a-start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('a-end')
    })
    const b = withSkillImportSerialization(['same'], async () => {
      order.push('b-start')
      order.push('b-end')
    })
    await Promise.all([a, b])
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })
})
