'use strict';

/**
 * THE SEAM BETWEEN THE TWO STATE DOMAINS.
 *
 * ------------------------------------------------------------------------
 *     ~/.lain-v2/supervisor/projects/     THE RUNTIME'S BOOKKEEPING
 *         identity, and when it last synchronised a tree. Counts and a
 *         digest. Rust owns it, and it outlives every CLI process.
 *
 *     <project>/.lain/                    THE MATERIALISED INDEX
 *         symbols, imports, fingerprints, per file. It lives WITH the project
 *         because it describes the project — a checkout somebody clones has no
 *         business carrying another machine's home directory around.
 *
 * NEITHER IS A COPY OF THE OTHER, and that is the property this file exists to
 * keep. The runtime never holds a symbol table; the project never holds a
 * record of which machines have opened it. On the day they disagreed there
 * would be nothing to reconcile, because they describe different things.
 *
 * ------------------------------------------------------------------------
 * WHO DECIDES WHAT.
 *
 *     the worker    reads the tree and says what it found      (projectindex)
 *     Rust          says whether that matches what it recorded (projects.rs)
 *     this file     carries one to the other
 *
 * The decision is the RUNTIME'S because it has to survive the process that
 * computed it: a CLI that opens a project, indexes it and exits has learned
 * something no session file records, and the next CLI would rediscover it.
 *
 * ------------------------------------------------------------------------
 * IT DEGRADES TO EXACTLY THE OLD BEHAVIOUR. With no supervisor running, the
 * index still refreshes and every query still answers — the verdict is simply
 * `UNKNOWN` and nothing is recorded. Project intelligence must not require a
 * background process to be up.
 */

const supervisor = require('./supervisor');
const projectindex = require('./projectindex');

/** A local call should be instant; hanging is the failure. */
const TIMEOUT_MS = 3000;

/**
 * A CHEAP SUMMARY OF WHAT THE TREE LOOKS LIKE NOW.
 *
 * Built from the fingerprints the index already holds, so it costs nothing
 * beyond the stat walk that was happening anyway. It is COMPARED, never
 * interpreted: the runtime asks only whether this string equals the one it
 * recorded, so its internal shape is this file's business alone.
 *
 * FNV-1a over `path:size:mtime` per file, in sorted order. Sorted because a
 * directory walk does not promise an order and a digest that changed with the
 * filesystem's mood would report every project as modified.
 */
function digestOf(index) {
  const files = Object.entries((index && index.files) || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  let h = 0xcbf29ce4n;
  let lo = 0x84222325n;
  // 64-bit FNV in two halves, so this stays exact in a language with 53-bit
  // integers. A collision here would report a changed tree as unchanged, which
  // is the one wrong answer worth this much care.
  let hash = (h << 32n) | lo;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const [rel, e] of files) {
    const line = `${rel}:${e.size}:${e.mtime}`;
    for (let i = 0; i < line.length; i++) {
      hash ^= BigInt(line.charCodeAt(i) & 0xff);
      hash = (hash * prime) & mask;
    }
  }
  return `${files.length}-${hash.toString(16)}`;
}

/**
 * OPEN A PROJECT: refresh the index, and tell the runtime what was found.
 *
 * @returns {Promise<{verdict:string, index:object, refresh:object, project:object|null}>}
 *   `verdict` is the RUNTIME'S: NEW, UNCHANGED, MODIFIED, RESHAPED — or
 *   UNKNOWN when no supervisor answered, which is not an error and not a claim.
 */
async function open(root, { budgetMs } = {}) {
  // ---- THE WORKER READS THE TREE ----------------------------------------
  //
  // Stat every file, re-scan what moved. This happens FIRST because the digest
  // describes the tree as it is now, and the runtime's answer is a comparison
  // against it — asking before looking would be asking about nothing.
  const refresh = projectindex.refresh(root, budgetMs ? { budgetMs } : {});
  const digest = digestOf(refresh.index);
  const symbols = Object.values(refresh.index.files || {})
    .reduce((n, e) => n + ((e.symbols || []).length), 0);

  let verdict = 'UNKNOWN';
  let project = null;
  try {
    // NEVER STARTS A SUPERVISOR. Opening a project is not work whose
    // continuity matters — it is bookkeeping, and a person who opens a
    // directory and quits has not asked for a background process.
    const opened = await supervisor.callIfRunning(
      {
        op: 'project_open',
        path: root,
        digest,
        index_version: projectindex.VERSION,
      },
      { timeoutMs: TIMEOUT_MS },
    );
    if (opened && opened.ok) {
      verdict = String(opened.verdict || 'UNKNOWN');
      project = opened.project || null;
      // ---- AND TELL IT WHAT THE WORKER ACTUALLY DID --------------------
      //
      // Counts and a digest. Never the index: a symbol table in the runtime's
      // store would be a second copy of the project's own.
      const result = refresh.added && !refresh.reused ? 'full'
        : (refresh.changed + refresh.added + refresh.removed ? 'incremental' : 'unchanged');
      const synced = await supervisor.callIfRunning(
        {
          op: 'project_synced',
          path: root,
          digest,
          index_version: projectindex.VERSION,
          files: Object.keys(refresh.index.files || {}).length,
          symbols,
          result,
        },
        { timeoutMs: TIMEOUT_MS },
      );
      if (synced && synced.ok) project = synced.project || project;
    }
  } catch {
    // A runtime that cannot be reached is a STATE, not an exception — the rule
    // guardian.js follows, for the reason given there.
    verdict = 'UNKNOWN';
  }

  return { verdict, digest, index: refresh.index, refresh, project, symbols };
}

/**
 * What the runtime's verdict means, in a sentence a person can read.
 *
 * SAID RATHER THAN INFERRED. "Unchanged since you last opened it" is a fact the
 * runtime holds and nothing else does — the index alone can only say that
 * nothing moved since the last stat, which is a different and much weaker claim.
 */
function say(verdict, refresh) {
  const rescanned = (refresh.changed || 0) + (refresh.added || 0);
  switch (verdict) {
    case 'NEW':
      return `First time in this project — ${refresh.added} file(s) indexed.`;
    case 'UNCHANGED':
      return 'Unchanged since the last session. Nothing was re-read.';
    case 'MODIFIED':
      return `Changed since the last session — ${rescanned} file(s) re-read`
        + `${refresh.removed ? `, ${refresh.removed} gone` : ''}.`;
    case 'RESHAPED':
      return 'The index format changed, so it was rebuilt.';
    default:
      // NOT A GUESS. No supervisor answered, and the honest thing is to say
      // what the worker did without claiming to know the history.
      return `${refresh.reused} file(s) reused, ${rescanned} re-read `
        + '(no runtime is running, so there is no record of the last session).';
  }
}

module.exports = { open, digestOf, say, TIMEOUT_MS };
