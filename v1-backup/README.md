# v1-backup — historical reference only

LAIN V1 is **not** in this directory. This directory only points at it.

| What | Where |
|---|---|
| V1 archive (do not delete, do not modify) | `C:\Users\Hartezmenot\Documents\lain-backups\LAIN-v1-pre-v2-rebuild-20260815-152302.zip` |
| V1 working repo (left completely untouched) | `C:\Users\Hartezmenot\Documents\lain` |
| Archive details + verification record | [`backup-reference.txt`](./backup-reference.txt) |
| What to learn from V1 / what to avoid | [`V1-AUDIT.md`](./V1-AUDIT.md) |

## Why V2 is a separate directory

V1's working tree carries **116 uncommitted changes, 72 of which are `src/` and
`tests/` modules that exist nowhere else** — not in any commit, not on any
branch. Rebuilding in place would have deleted them, leaving the ZIP as the
single point of failure for a large part of the current implementation.

So V1 stays exactly where it is, at its original path, at commit `b2872dd`, with
its working tree intact. V2 is built here from an empty tree.

## Rules for using V1

- **Read it to understand a mechanism.** Encouraged.
- **Copy a small, proven concept after understanding it.** Allowed.
- **Copy a file across, or port a subsystem wholesale.** Not allowed.
- **Add something to V2 because V1 had it.** Not a reason.

V2's contents are decided by what V2 needs, not by what V1 contained.

## Restoring V1 from the archive

```powershell
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory(
  'C:\Users\Hartezmenot\Documents\lain-backups\LAIN-v1-pre-v2-rebuild-20260815-152302.zip',
  'C:\some\restore\target')
```

The archive contains a full `.git`, so the restored copy is a working repository.
`tools/__pycache__` was excluded from the working tree but its blobs are in
`.git`; recover them with `git checkout -- tools/__pycache__` if ever needed.
