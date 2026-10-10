# Injected filesystem providers

External filesystems mount at `vfs://external/<mountName>`. Bash exposes the
same mount as `/external/<mountName>`. The Web host discovers providers and
adapts their file semantics to `VfsBackend`; it does not select their transport
or require a `FileSystemDirectoryHandle`.

The shared contract lives in `packages/fs-provider`. A provider implements
`stat`, `readdir`, `readFile`, `writeFile`, `mkdir`, and `remove`. Reads and writes
use `Uint8Array`, including for text. Paths are relative POSIX paths; `''` is
the mount root. Absolute paths, backslashes, NUL, `.` and `..` are rejected.
Directory entries contain child names, kinds, and optional size/mtime, never
host-controlled VFS paths. `readOnly`, `rename`, and `dispose` are optional.
Errors should expose an errno-style `code`, such as `ENOENT` or `EROFS`.

Install the announcement in the application's page context (MAIN world for
extensions):

```ts
import { announceProvider } from '@creatorweave/fs-provider'
import { memoryProvider } from '@creatorweave/fs-provider/memory'

let alive = true
const stopAnnouncing = announceProvider({
  version: 1,
  id: 'example.notes',
  name: 'Notes',
  mountName: 'notes',
  isAlive: () => alive,
  factory: () => memoryProvider(),
})

// When this injected integration is disposed:
// alive = false
// stopAnnouncing()
```

The announcement/request event pair supports either loading order. Mount names
are unique and contain letters, digits, underscores or hyphens (up to 64
characters). A live mount cannot be replaced by a different factory. The host
shares one lazy factory call among concurrent operations. Failed initialization
can be retried; file-operation failures do not trigger automatic retries or
repeat writes. Dead mounts may be replaced, and stale factory results are
disposed. `isAlive` is a cheap availability hint; operations remain authoritative.
Discovery runs within the application's existing page trust boundary.

`fromFileSystemHandle` is a reference adapter for OPFS or authorized filesystem
handles. Execute it at the storage origin. A provider may instead proxy a
remote service, use memory, or own an extension messaging channel. That channel
is private to its implementation. No registration in the file tools or bash
backend enum is needed for a second mount.

The host retains the existing handle, worker, native-host and pending-overlay
discovery paths for built-in storage. Handle-free mounts use shared VFS walking,
glob filtering and text search, with directory exclusions, cancellation and
budgets. Glob scans narrow to static directory prefixes when possible. Search
checks known file sizes before reading and skips binary files.

WebMCP is the extension-owned reference provider, mounted at
`vfs://external/webmcp`. The extension stores files in its own OPFS origin,
validates packages locally and refreshes catalogs after successful mutations.
The Web application supplies workspace tool capabilities and binding metadata;
it does not publish adapter source snapshots. Unavailable catalogs withdraw
stale routes. The extension's JSON transport limits a single file to 32 MiB;
this is not a limit in the generic provider contract. The old `vfs://webmcp`
namespace has been removed without an alias.

Python retains its existing handle-based mounts. Workspace `mkdir` creates an
empty directory in the OPFS staging view; the existing native apply pipeline
tracks files and directory deletions, not empty-directory creation. Creating
a file inside a staged directory still uses the normal pending-file pipeline.
