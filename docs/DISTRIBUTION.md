# Distribution — how `lain` gets onto a machine

The architecture, the decisions, and what was actually verified rather than
assumed.

---

## 1. One product, one runtime, one executable

```
LAIN Harness  (the product)
      │
      ▼
  npm install -g lain      ·OR·   node distribution/install.js
      │
      ▼
  lain                     (the executable — the ONLY one)
      │
      ├── REPL, commands, agent runtime      src/
      ├── Harness: tasks, verification, …    src/harness/
      └── everything reached through the same binary:
            lain --doctor
            lain /harness doctor · /tasks · /verify · /env · /artifacts
```

There is **no** `lain-cli`, `lain-harness` or `lain-runtime` executable, and
nothing to "integrate". `package.json` declares exactly one `bin`, and a test
asserts that it stays exactly one.

**The installer never copies the runtime.** The launcher points at the installed
package (or your checkout). A copied `src/` would be a fork that drifts, and the
first symptom is a bug fixed in the repository and still live on PATH.

---

## 2. Existing packaging architecture (what was found)

| | |
|---|---|
| Mechanism | npm. `package.json` already declared `bin: { lain: "bin/lain.js" }` |
| Dependencies | **none** — nothing to resolve, audit, or fail on |
| Entrypoint | `bin/lain.js` → `src/cli.js` `main()` |
| Install scripts | none |
| `files` allowlist | **missing** — `npm pack` shipped 585 files / 6.9 MB, including `.lain-probe/probe.log`, `docs/STATUS.md` (191 KB), the whole Rust tree, `bench/`, `tests/` and `v1-backup/` |
| Verification | **none** — nothing checked that an install worked |
| On this machine | already `npm link`ed: the global `node_modules/lain` is a symlink to the checkout |

So the mechanism was right and two things were missing: a package that contains
only the product, and any notion of a *verified* install.

---

## 3. The boundary

```
distribution/            OUTSIDE src/ — deliberately
  install.js             the installer and its success contract
  uninstall.js           removes what it wrote, nothing a person owns
  detect.js              READ-ONLY: where is lain, which one wins, does it run
  pathenv.js             PATH read/append/remove, through an injected adapter
  platform/
    windows.js           user-scope PATH via PowerShell; .cmd/.ps1/sh shims
    unix.js              a marked block in the right shell profile
```

**Why outside `src/`.** A running LAIN must never mutate PATH. That is enforced
structurally rather than by convention: the architecture guard requires every
file in `src/` to be reachable from `src/cli.js`, nothing in `src/` requires
anything in `distribution/`, and two tests assert both halves — no `src/` file
reaches the installer, and no `src/` file contains PATH-mutating code at all.

---

## 4. PATH strategy

Five rules, each with a test:

1. **Never overwrite.** Read, decide, append one entry, write back.
2. **Never rewrite entries.** No global substitution — that is how somebody's
   toolchain disappears.
3. **Never duplicate.** Compared the way the platform compares paths
   (case-insensitively on Windows, trailing separators ignored).
4. **Only the bin directory.** Never a repository root: a checkout on PATH puts
   every script in it one typo away from running.
5. **A denied write is a state, not a failure.** The install still succeeds, the
   limitation is stated, the launcher's full path is given, and the exact manual
   command is printed. Global availability is never falsely claimed.

### Windows

User scope (`HKCU`) only — installing a CLI for yourself must not ask for
administrator rights.

**`setx` is not used, and that is deliberate.** It truncates PATH at 1024
characters *silently*, and `%PATH%` in a shell is the merged machine+user value,
so the usual recipe copies every machine entry into the user's own. LAIN uses
`[Environment]::GetEnvironmentVariable('PATH','User')` /
`SetEnvironmentVariable(…,'User')`, which reads the user half alone and has no
length limit. The value is passed base64-encoded so a PATH containing quotes or
`$` cannot become code.

Three shims are written — `lain.cmd`, `lain.ps1` and an extensionless POSIX
`lain` — because Windows has three shells and Git Bash is how a great many
people on Windows actually work. The POSIX one is written with LF endings; CRLF
there produces the famously unhelpful `bad interpreter` error.

### Unix

There is no persistent PATH on Unix — there is a shell that reads a file. The
installer appends a **marked block** to the file that shell actually reads
(`.zshrc`, `.bashrc`/`.bash_profile`, `config.fish`, else `.profile`):

```
# >>> LAIN Harness >>>
export PATH="/home/me/.lain-v2/bin:$PATH"
# <<< LAIN Harness <<<
```

The markers are what make it idempotent and what make uninstall possible without
a text search that could match something the user wrote. The rest of the file is
passed through byte for byte.

---

## 5. Install success contract

"Files copied" is **not** success. An install is `ok` only when:

```
the launcher exists
AND the canonical entrypoint exists
AND `lain --version` ACTUALLY RAN
AND PATH availability is VERIFIED, or reported as needing a new shell
```

The persistent PATH and *this shell's* PATH are tracked as separate facts, so
the report never says "Ready" over a terminal where the command does not yet
resolve. Where two `lain` are on PATH, the installer says which one wins.

---

## 6. Optional capabilities are never installation blockers

Nothing optional is downloaded, built or required: no browser, no Docker, no
Rust, no MCP bridge. `lain --doctor` marks an absent optional capability `○`,
never `✗`, and its one-line summary is `ok` unless a **core** capability is
misconfigured. An install that failed because Chrome was missing would fail on
every server in the world.

---

## 7. What was actually verified

Not from package metadata — by installing.

| Check | How |
|---|---|
| `npm pack` contents | 585 files / 6.9 MB → **276 files / 3.4 MB** (1.2 MB tarball), source only |
| A real global install | `npm pack` → `npm install -g --prefix <sandbox>` into an **isolated** prefix |
| `lain` is discoverable | `where.exe lain` on a PATH containing **only** the sandbox bin, node and system32 — no repo, no dev link |
| `lain --version` | ran: `lain 2.0.0-alpha.1 (node v24.16.0)`, exit 0 |
| `lain --doctor` | ran in an empty project from the isolated install, exit 0 |
| The Harness ships with it | `lain /harness capabilities` answered from the **same** executable |
| The no-npm path | tarball extracted, `node distribution/install.js --dir <tmp> --no-path`, verified by running the launcher |
| Development mode | `node bin/lain.js --version` with no install at all |
| A launcher in a path with spaces | installed into `…/lain dist …/my bin` and run — the classic `C:\Program` truncation |
| The Unix profile writer | six cases on this host: correct file per `$SHELL`, marked block, idempotence, removal, fish syntax, `exec` launcher |
| 39 distribution tests | every PATH case against an **injected fake** — the developer's real PATH is never touched |

**Can a new user install LAIN Harness and immediately use `lain` without
separately installing a LAIN CLI? Yes — verified by the isolated install above.**

---

## 8. Answering the naming question

The mission asked for an audit and a decision. The audit found `name: "lain"`,
`bin: { lain: "bin/lain.js" }`, and a description calling it "an agentic coding
CLI".

**Decision:** product name **LAIN Harness**; npm package **`lain`**; executable
**`lain`**.

The package name is deliberately *not* `lain-harness`. A package called
`lain-harness` that installs a binary called `lain` is precisely the two-name
confusion §16 warns against — the person who installed it has to remember that
the thing they typed and the thing they run are spelled differently, and the
first thing they will try is `lain-harness --version`. One name on the tin, the
same name at the prompt.

"LAIN Harness" survives as the product name where a product name belongs: the
package description, the README, and the header of `lain --doctor`. Overriding
this is a one-line change to `package.json`.

---

## 9. One defect this found

`pathenv.remove` filters the entry out and hands the adapter what is left —
which, on Unix, is the empty string, because that adapter only ever holds one
entry. `set('')` wrote `export PATH=":$PATH"` and **left the block in the file**,
so the uninstaller reported success over a profile that still had LAIN in it.
Caught by the removal test on its first run. An empty value now means *unset*,
and unset on Unix means removing the block.

---

## 10. Limitations

- **`npm install -g lain` assumes the name `lain` on the registry.** Nothing has
  been published; the verified path used a local tarball, which is what
  `npm install -g <tarball>` and `npm install -g .` both do.
- **The npm route relies on npm's global bin already being on PATH** (it
  normally is, and it was on this machine). The `distribution/install.js` route
  is the one that manages PATH itself.
- **Unix PATH persistence is tested but not exercised on a real Unix host.**
  The profile writer is plain file I/O over a home directory it is handed, so
  six tests drive it for real on any platform: the right file per `$SHELL`, a
  marked block appended without disturbing the rest, idempotence, removal, fish
  syntax, and an `exec` launcher. What has *not* happened here is a login shell
  on Linux or macOS actually re-reading the file — that needs a Unix host.
- **No uninstall for the npm route** beyond `npm uninstall -g lain`;
  `distribution/uninstall.js` covers only what `distribution/install.js` wrote.
- **No signed installers, no Homebrew formula, no `.msi`.** Out of scope.
