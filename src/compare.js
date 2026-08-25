'use strict';

/**
 * CAPABILITY COMPARISON — "what could the old one do that this one can't?"
 *
 * The question this answers is not "which files differ". Two codebases that
 * solve the same problem in different shapes have almost no files in common, and
 * a file-level diff of a rewrite is noise. What a person actually wants to know
 * before retiring an old version is which CAPABILITIES survived, which were
 * replaced by something different, and which quietly went missing.
 *
 * So this works on capabilities, and it is SYMMETRIC: one probe set, run over
 * both trees, so neither side is privileged. A capability is detected from
 * evidence in the tree — file names, exported functions, command names — never
 * from a hand-written list of "what V1 had", because a hand-written list is a
 * claim about a codebase rather than a reading of one.
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * Copy code. A migration recommendation names the capability and the files that
 * implement it; deciding how it should look in the new architecture is work, and
 * work belongs to the normal task loop with real tools, not to a report.
 *
 * Some capabilities are EXCLUDED by architectural decision rather than missing.
 * Those are marked and never recommended, because a comparison that keeps
 * suggesting you re-adopt something you deliberately dropped is a comparison
 * nobody reads twice.
 */

const fs = require('fs');
const path = require('path');

const MAX_FILES = 6000;
const MAX_DEPTH = 12;
const MAX_FILE_BYTES = 2_000_000;
/** Content is only read for files that could plausibly carry a signal. */
const READABLE = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|json|md)$/i;
const SKIP_DIR = /^(?:node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;

const STATUS = Object.freeze({
  IMPLEMENTED: '✓',
  PARTIAL: '≈',
  REPLACED: '→',
  MISSING: '—',
  REGRESSED: '✕',
  EXCLUDED: '⊘',
  REVIEW: '?',
});

const STATUS_WORD = Object.freeze({
  '✓': 'IMPLEMENTED', '≈': 'PARTIAL', '→': 'REPLACED', '—': 'MISSING',
  '✕': 'REGRESSED', '⊘': 'INTENTIONALLY EXCLUDED', '?': 'NEEDS REVIEW',
});

const { CAPABILITIES } = require('./capabilities');

// ------------------------------------------------------------------ trees ---

/** Walk a directory into `{ files: [rel], read(rel) }`. */
function scanDir(root) {
  const files = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && files.length < MAX_FILES) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (SKIP_DIR.test(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) stack.push({ dir: abs, depth: depth + 1 });
      else if (e.isFile()) files.push(path.relative(root, abs).replace(/\\/g, '/'));
      if (files.length >= MAX_FILES) break;
    }
  }
  const cache = new Map();
  return {
    kind: 'folder', label: root, files,
    read(rel) {
      if (cache.has(rel)) return cache.get(rel);
      let out = '';
      try {
        const abs = path.join(root, rel);
        if (fs.statSync(abs).size <= MAX_FILE_BYTES) out = fs.readFileSync(abs, 'utf8');
      } catch { out = ''; }
      cache.set(rel, out);
      return out;
    },
  };
}

/**
 * A GitIngest / "flattened repository" text blob.
 *
 * These are just concatenated files with a header line before each. Several
 * header shapes are in circulation, so the parser accepts the common ones and
 * says how many files it recovered — an unrecognised format yields zero files,
 * which is visible, rather than an empty comparison that looks like a verdict.
 */
/** A line that is only a rule of `=` or `-`: decoration, never a filename. */
const RULE = /^[=\-_*]{3,}\s*$/;
/** The header shapes seen in the wild, each capturing the path. */
const HEADERS = [
  /^(?:#{1,3}\s*)?(?:FILE|File|file)\s*[:=]\s*(\S.*?)\s*$/,
  /^[=\-]{3,}\s*(\S.*?\.[A-Za-z0-9]{1,8})\s*[=\-]*\s*$/,
  /^(?:#{1,3})\s+(\S*[/\\]\S*\.[A-Za-z0-9]{1,8}|\S+\.[A-Za-z0-9]{1,8})\s*$/,
];

function headerPath(line) {
  if (RULE.test(line)) return null;
  for (const re of HEADERS) {
    const m = re.exec(line);
    if (!m) continue;
    const p = m[1].trim().replace(/\\/g, '/').replace(/^\.\//, '');
    // A path, not a sentence: it needs an extension and no spaces.
    if (!/\.[A-Za-z0-9]{1,8}$/.test(p) || /\s/.test(p) || p.length > 200) continue;
    return p;
  }
  return null;
}

/**
 * Read a flattened-repository dump line by line.
 *
 * Deliberately a scanner rather than one regex: the formats differ in whether
 * the rule comes before the name, after it, or both, and a single pattern that
 * covers all of them covers prose as well. A dump nothing recognises yields
 * ZERO files, which the caller reports as "nothing readable" — visible, rather
 * than an empty comparison that looks like a verdict.
 */
function scanIngest(text) {
  const lines = String(text || '').split('\n');
  const files = [];
  const bodies = new Map();
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) bodies.set(current, buf.join('\n'));
    buf = [];
  };
  for (const line of lines) {
    const p = headerPath(line);
    if (p) {
      flush();
      current = p;
      if (!files.includes(p)) files.push(p);
      continue;
    }
    if (current && !RULE.test(line)) buf.push(line);
  }
  flush();
  return { kind: 'ingest', label: 'pasted repository text', files, read: (rel) => bodies.get(rel) || '' };
}

/**
 * A GitHub repository, by URL.
 *
 * ONE request for the whole file list (the trees API), and content fetched only
 * for the handful of files a probe actually asks about. No archive download, no
 * tar reader, no clone, no dependency. It is bounded and it is obvious what
 * left the machine: a public repository name.
 */
async function scanGitHub(url, { fetchImpl = globalThis.fetch } = {}) {
  const m = /github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/|$)/i.exec(String(url));
  if (!m) throw new Error(`not a GitHub repository URL: ${url}`);
  const [, owner, repo] = m;
  if (typeof fetchImpl !== 'function') throw new Error('this Node build has no fetch — use a local folder or pasted text');

  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const head = { 'user-agent': 'lain-compare', accept: 'application/vnd.github+json' };
  const meta = await fetchImpl(api, { headers: head });
  if (!meta.ok) throw new Error(`GitHub said ${meta.status} for ${owner}/${repo}${meta.status === 404 ? ' (private or misspelled?)' : ''}`);
  const branch = (await meta.json()).default_branch || 'main';

  const treeRes = await fetchImpl(`${api}/git/trees/${branch}?recursive=1`, { headers: head });
  if (!treeRes.ok) throw new Error(`GitHub said ${treeRes.status} listing the file tree`);
  const tree = await treeRes.json();
  const files = (tree.tree || [])
    .filter((n) => n.type === 'blob')
    .map((n) => String(n.path))
    .filter((p) => !p.split('/').some((seg) => SKIP_DIR.test(seg)))
    .slice(0, MAX_FILES);

  const cache = new Map();
  return {
    kind: 'github', label: `${owner}/${repo}@${branch}`, files,
    truncated: Boolean(tree.truncated),
    async read(rel) {
      if (cache.has(rel)) return cache.get(rel);
      let out = '';
      try {
        const r = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${rel}`, { headers: head });
        if (r.ok) out = await r.text();
      } catch { out = ''; }
      cache.set(rel, out);
      return out;
    },
  };
}

/** Whatever the user typed → a tree. */
async function resolveSource(input, opts = {}) {
  const s = String(input || '').trim();
  if (!s) throw new Error('no comparison source given');
  if (/^https?:\/\//i.test(s)) return scanGitHub(s, opts);
  // A long multi-line blob is pasted repository text, not a path.
  if (s.includes('\n') && s.length > 200) return scanIngest(s);
  const abs = path.resolve(s);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`no such folder: ${s}`); }
  if (st.isDirectory()) return scanDir(abs);
  // A file: either an ingest dump, or a single source file (not comparable).
  const body = fs.readFileSync(abs, 'utf8');
  const t = scanIngest(body);
  if (t.files.length) { t.label = abs; return t; }
  throw new Error(`${s} is a single file, not a project — give a folder, a GitHub URL, or a flattened-repository dump`);
}

// ------------------------------------------------------------- detection ---

/** Does this tree have this capability, and what is the evidence? */
async function detect(tree, cap) {
  const hits = cap.paths ? tree.files.filter((f) => cap.paths.some((re) => re.test(f))) : [];
  if (!hits.length) return { present: false, where: [] };
  if (!cap.content) return { present: true, where: hits.slice(0, 3) };
  // A path hit alone is weak when the capability is a feature INSIDE a shared
  // file (`/doctor` lives in commands.js, which every tree has). Content decides.
  const where = [];
  for (const f of hits.slice(0, 40)) {
    if (!READABLE.test(f)) continue;
    const body = await tree.read(f);
    if (!body) continue;
    if (cap.content.some((re) => re.test(body))) where.push(f);
    if (where.length >= 3) break;
  }
  return { present: where.length > 0, where };
}

/** Left vs right → a status symbol and a recommendation, per capability. */
function verdict(cap, left, right, byId) {
  if (cap.excluded) {
    return { status: STATUS.EXCLUDED, recommend: 'DO NOT MIGRATE', why: cap.excluded };
  }
  if (left.present && right.present) {
    return { status: STATUS.IMPLEMENTED, recommend: 'Keep', why: '' };
  }
  if (!left.present && right.present) {
    return { status: STATUS.IMPLEMENTED, recommend: 'Keep (new here)', why: 'this side has it and the other does not' };
  }
  if (left.present && !right.present) {
    const rep = cap.replacedBy && byId.get(cap.replacedBy.id);
    if (rep && rep.right.present) {
      return { status: STATUS.REPLACED, recommend: 'Evaluate selectively', why: cap.replacedBy.why };
    }
    return { status: STATUS.MISSING, recommend: 'Consider migrating', why: '' };
  }
  return { status: STATUS.MISSING, recommend: '—', why: 'neither side has it' };
}

/**
 * Compare two trees.
 * @returns {{rows:Array, left:object, right:object, summary:object}}
 */
async function compare(leftTree, rightTree) {
  const results = [];
  const byId = new Map();
  for (const cap of CAPABILITIES) {
    const left = await detect(leftTree, cap);
    const right = await detect(rightTree, cap);
    const row = { cap, left, right };
    byId.set(cap.id, row);
    results.push(row);
  }
  // Grouped for reading, in a fixed order. Without this a group heading can
  // appear twice, which makes the report look like it lost its place.
  const ORDER = ['Understanding', 'Efficiency', 'Evidence', 'Correctness', 'Workflow', 'Safety', 'State', 'Providers', 'Operability', 'Interface'];
  results.sort((a, b) => {
    const d = ORDER.indexOf(a.cap.group) - ORDER.indexOf(b.cap.group);
    return d || 0;
  });
  const rows = results.map((r) => ({
    id: r.cap.id,
    name: r.cap.name,
    group: r.cap.group,
    plain: r.cap.plain,
    left: r.left,
    right: r.right,
    ...verdict(r.cap, r.left, r.right, byId),
  }));
  const summary = {};
  for (const r of rows) summary[STATUS_WORD[r.status]] = (summary[STATUS_WORD[r.status]] || 0) + 1;
  return {
    rows, summary,
    left: { label: leftTree.label, files: leftTree.files.length, kind: leftTree.kind },
    right: { label: rightTree.label, files: rightTree.files.length, kind: rightTree.kind },
    missing: rows.filter((r) => r.status === STATUS.MISSING && r.left.present),
  };
}

// ----------------------------------------------------------------- render ---

function pad(s, n) {
  const t = String(s);
  return t.length > n ? t.slice(0, n - 1) + '…' : t + ' '.repeat(n - t.length);
}

/** The grid. Widths adapt to the terminal; nothing wraps mid-cell. */
function grid(result, width = 96) {
  const w = Math.max(64, Math.min(width, 120));
  const cRec = 22;
  const cV = 8;
  const cName = Math.max(16, w - cRec - cV * 2 - 13);
  const line = (l, m, r) => l + '─'.repeat(cName + 2) + m + '─'.repeat(cV + 2) + m + '─'.repeat(cV + 2) + m + '─'.repeat(cRec + 2) + r;
  const out = [];
  out.push(line('┌', '┬', '┐'));
  out.push(`│ ${pad('Capability', cName)} │ ${pad('OLD', cV)} │ ${pad('THIS', cV)} │ ${pad('Recommendation', cRec)} │`);
  out.push(line('├', '┼', '┤'));
  let group = null;
  for (const r of result.rows) {
    if (r.group !== group) {
      group = r.group;
      out.push(`│ ${pad(group.toUpperCase(), cName + cV * 2 + cRec + 9)} │`);
    }
    const l = r.left.present ? '✓' : '—';
    const rt = r.status === STATUS.EXCLUDED ? '⊘' : (r.right.present ? '✓' : (r.status === STATUS.REPLACED ? '→' : '—'));
    out.push(`│ ${pad('  ' + r.name, cName)} │ ${pad(l, cV)} │ ${pad(rt, cV)} │ ${pad(r.recommend, cRec)} │`);
  }
  out.push(line('└', '┴', '┘'));
  return out;
}

/** The part a person reads first: what is actually missing, in plain words. */
function findings(result) {
  const out = [];
  const excluded = result.rows.filter((r) => r.status === STATUS.EXCLUDED && r.left.present);
  const replaced = result.rows.filter((r) => r.status === STATUS.REPLACED);
  if (result.missing.length) {
    out.push('Missing here, present there:');
    for (const r of result.missing) {
      out.push(`  • ${r.name} — ${r.plain}`);
      if (r.left.where.length) out.push(`      in the other tree: ${r.left.where.join(', ')}`);
    }
  } else out.push('Nothing the other tree has is missing here.');
  if (replaced.length) {
    out.push('');
    out.push('Done differently here (not missing):');
    for (const r of replaced) out.push(`  • ${r.name} — ${r.why}`);
  }
  if (excluded.length) {
    out.push('');
    out.push('Left out on purpose:');
    for (const r of excluded) out.push(`  • ${r.name} — ${r.why}`);
  }
  return out;
}

/**
 * The brief handed to the normal task loop when a capability is chosen.
 *
 * It is a REQUEST, not a patch: it names the capability, says what it is for,
 * points at the files that implement it in the other tree, and states the
 * constraints. Everything after this is ordinary work with ordinary tools —
 * which is the only way the result fits this architecture rather than the old
 * one's.
 */
function migrationBrief(row, leftLabel) {
  const where = row.left.where.length ? row.left.where.join(', ') : '(location not pinned down)';
  return [
    `Add this capability: ${row.name}.`,
    '',
    `What it does: ${row.plain}`,
    `A previous version implements it in: ${where} (source: ${leftLabel}).`,
    '',
    'Read that implementation for the IDEA, then build it for this codebase:',
    '- find the module here that already owns this concern and extend it; do not add a parallel system',
    '- do not copy the old code, its structure, its storage format or its dependencies',
    '- do not bring in an external service, a new runtime or a new dependency; if the capability genuinely needs one, stop and say so instead of adding it',
    '- give it its own focused test, and run the suite',
  ].join('\n');
}

// ---------------------------------------------------------- the command ----

/**
 * `/compare` end to end. It lives here rather than in commands.js because the
 * whole capability — reading a source, probing it, rendering the grid, handing
 * a choice to the task loop — is one concern, and commands.js is a registry.
 *
 * `C` and `config` are passed in rather than required, so this module stays
 * usable (and testable) without the rendering stack attached.
 */
async function runCommand(app, { args = [], rest = '' } = {}, { C, config } = {}) {
  const w = (s) => app.render.write(s);
  const plainC = { bold: (s) => s, dim: (s) => s, green: (s) => s, yellow: (s) => s };
  const col = C || plainC;

  if (String(args[0] || '').toLowerCase() === 'add') {
    const want = args.slice(1).join(' ').trim().toLowerCase();
    const last = app._lastCompare;
    if (!last) { app.render.notice('warn', 'Run /compare <source> first — there is nothing to add from yet.'); return; }
    const row = last.rows.find((r) => r.id === want || r.name.toLowerCase() === want)
      || (want.length >= 3 ? last.rows.find((r) => r.name.toLowerCase().includes(want)) : null);
    if (!row) {
      w(col.dim('  No capability by that name. The missing ones were:\n'));
      for (const r of last.missing) w(col.dim(`    ${r.id}  — ${r.name}\n`));
      return;
    }
    if (row.status === STATUS.EXCLUDED) {
      app.render.notice('warn', `${row.name} is left out on purpose, not missing: ${row.why}`);
      return;
    }
    if (row.right.present) { w(col.dim(`  ${row.name} is already here (${row.right.where.join(', ')}).\n`)); return; }
    w(col.dim(`  Handing "${row.name}" to the normal workflow — it gets built for this codebase, not copied.\n`));
    return app.submit(migrationBrief(row, last.left.label));
  }

  const source = rest || (app.cfg && app.cfg.compareSource) || null;
  if (!source) {
    w('\n' + col.bold('Compare against what?') + '\n');
    w('  Give me one of these:\n\n');
    w('    /compare C:\\path\\to\\other-version      a folder on this machine\n');
    w('    /compare https://github.com/you/repo    a public repository\n');
    w('    /compare dump.txt                       a flattened-repository text file\n');
    w(col.dim('\n  A folder is best: everything is read locally and nothing leaves the machine.\n'));
    return;
  }

  w(col.dim(`  Reading ${source.length > 70 ? source.slice(0, 70) + '…' : source}\n`));
  let left;
  try {
    left = await resolveSource(source);
  } catch (e) { app.render.notice('error', `Could not read that: ${e.message}`); return; }
  if (!left.files.length) {
    app.render.notice('error', 'Nothing readable in that source — no files were found in it.');
    return;
  }

  const right = scanDir(path.resolve(__dirname, '..'));
  const result = await compare(left, right);
  app._lastCompare = result;
  if (rest && app.cfg && config) {
    app.cfg.compareSource = rest;
    try { config.save(app.cfg); } catch { /* remembering is a convenience, not a requirement */ }
  }

  w('\n' + col.bold('Comparison') + col.dim(`  ${left.label} (${left.files.length} files)  vs  this project (${right.files.length} files)\n`));
  if (left.truncated) w(col.yellow('  Note: that repository was too large to list in full — some files were not seen.\n'));
  w('\n');
  const width = app.render.width || 96;
  for (const line of grid(result, width)) w('  ' + line + '\n');
  w('\n');
  for (const line of findings(result)) w('  ' + line + '\n');
  w('\n  ' + col.dim(Object.entries(result.summary).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(' · ')) + '\n');
  if (result.missing.length) {
    w('\n  ' + col.bold('Would you like to add any of these?') + '\n');
    w(col.dim(`    /compare add <name>   e.g. /compare add ${result.missing[0].id}\n`));
    w(col.dim('    Only what you name is built, and it is built for this codebase — nothing is copied wholesale.\n'));
  }
  return result;
}

module.exports = {
  STATUS, STATUS_WORD, CAPABILITIES, runCommand,
  scanDir, scanIngest, scanGitHub, resolveSource,
  detect, compare, grid, findings, migrationBrief,
};
