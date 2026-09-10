'use strict';

/**
 * LIGHTWEIGHT PROJECT CONTEXT.
 *
 * Deliberately NOT a feature graph, a symbol index or a dependency database.
 *
 * V1 built four overlapping project-intelligence subsystems (a Python AST index,
 * a discovery cache, a 730-line feature graph, a dictionary), assembled fourteen
 * overlapping digest producers, and pinned up to 6,000 tokens of the result into
 * every single request. The feature graph was consulted only if the model chose
 * to call it, was never updated after an edit, and its AST path was unreachable.
 * A large amount of machinery bought orientation the model could have obtained
 * by listing a directory.
 *
 * So this is a shallow scan with a hard budget: what kind of project is this,
 * how is it run, and what is at the top level. It is built ONCE per session,
 * lazily, and capped. If the model wants more it has `list_dir`, `read_file` and
 * a shell — which is faster than any index for the questions it actually asks.
 *
 * If a real index is ever needed, it earns its place by being measured against
 * this, not by being assumed.
 */

const fs = require('fs');
const path = require('path');

const SKIP = /^(?:node_modules|\.git|dist|build|out|target|vendor|__pycache__|\.venv|venv|coverage|\.next|\.cache|\.idea|\.vscode)$/i;
const MAX_ENTRIES = 40;
/**
 * HOW MUCH OF THE PROJECT THE MODEL IS SHOWN BEFORE IT TOUCHES ANYTHING.
 *
 * ------------------------------------------------------------------------
 * THE MEASUREMENT THAT MOVED THESE. On this repository the brief read:
 *
 *     src/: tools/ ui/ actors.js agentjob.js … briefcommand.js (+142 more)
 *
 * TWELVE of a hundred and fifty-six modules. Everything after `b` was
 * invisible — so a model asked for "a helper that formats byte sizes" had no
 * way to see that such a module was already sitting there, and the cheapest
 * answer to "does this already exist" was a search it had no reason to run.
 *
 * That is the failure this brief exists to prevent: the model rebuilding
 * something the project already has, because nothing told it.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS AFFORDABLE, and it is the reason the number could move at all.
 *
 * The brief lives in the SYSTEM PROMPT, which is the stable prefix of every
 * request in a session — the part prompt caching serves back. Measured on the
 * live route, 64% of a request's input was already served from cache. The
 * inventory is written once and read from cache thereafter.
 *
 * A NAME IS NOT AN INDEX. This lists what EXISTS, not what anything does. The
 * model still has `symbols`, `grep` and `read_file` for anything deeper.
 *
 * MAX_CHARS IS THE REAL BOUND, and it protects a repository far larger than
 * this one: a huge tree fills the budget, is cut at a line boundary, and is
 * TOLD it was cut.
 */
const MAX_CHARS = 6000;
const MAX_COMPLETIONS = 200;
/** Source directories summarised in the brief, and how many files each shows. */
const MAX_SOURCE_DIRS = 6;
const MAX_FILES_PER_DIR = 400;
/** How wide one directory line may get. See the loop in `brief`. */
const MAX_DIR_LINE = 2600;

/**
 * Directories worth naming. A project's own code lives in a small, boringly
 * predictable set of places, and listing them costs one readdir each.
 *
 * NOT an index and not a heuristic about importance — just "these exist here".
 */
const SOURCE_DIRS = /^(?:src|lib|app|source|pkg|internal|cmd|test|tests|spec|__tests__|bin|scripts|server|client|api|core)$/i;
const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|cs|php|swift|kt|c|h|cc|cpp|hpp|sh|ps1)$/i;

/** Manifest → (language, how to run). Add a row; do not add a subsystem. */
const MANIFESTS = [
  { file: 'package.json', lang: 'javascript', run: (j) => Object.keys((j && j.scripts) || {}).slice(0, 6).map((s) => `npm run ${s}`) },
  { file: 'pyproject.toml', lang: 'python', run: () => ['python -m <module>'] },
  { file: 'requirements.txt', lang: 'python', run: () => ['python main.py'] },
  { file: 'Cargo.toml', lang: 'rust', run: () => ['cargo run', 'cargo test'] },
  { file: 'go.mod', lang: 'go', run: () => ['go run .', 'go test ./...'] },
  { file: 'pom.xml', lang: 'java', run: () => ['mvn test'] },
  { file: 'Makefile', lang: null, run: () => ['make'] },
];

/**
 * One level inside a source directory: which code files are in it.
 *
 * Deliberately NOT recursive. One readdir per named directory has a fixed cost
 * and answers the question the model actually asks first — "where is the code"
 * — while a recursive walk is how a project brief turns into the 6,000-token
 * digest V1 pinned into every request.
 */
function sourceFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const files = [];
  const subdirs = [];
  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (e.isDirectory()) subdirs.push(e.name + '/');
    else if (CODE_EXT.test(e.name)) files.push(e.name);
  }
  if (!files.length && !subdirs.length) return null;
  return { files, subdirs };
}

function scan(cwd) {
  const root = cwd || process.cwd();
  const out = { root, languages: [], entries: [], run: [], manifests: [], tree: [] };

  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }

  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (out.entries.length < MAX_ENTRIES) out.entries.push(e.isDirectory() ? e.name + '/' : e.name);
  }

  for (const m of MANIFESTS) {
    const p = path.join(root, m.file);
    if (!fs.existsSync(p)) continue;
    out.manifests.push(m.file);
    if (m.lang && !out.languages.includes(m.lang)) out.languages.push(m.lang);
    try {
      const parsed = m.file.endsWith('.json') ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
      for (const cmd of m.run(parsed) || []) if (!out.run.includes(cmd)) out.run.push(cmd);
    } catch { /* an unparseable manifest is not worth failing over */ }
  }

  // Extension census over the top level only — one level, no recursion.
  const byExt = new Map();
  for (const e of names) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (ext) byExt.set(ext, (byExt.get(ext) || 0) + 1);
  }
  const lang = { '.js': 'javascript', '.ts': 'typescript', '.py': 'python', '.go': 'go', '.rs': 'rust', '.java': 'java', '.rb': 'ruby', '.cs': 'csharp' };
  for (const [ext] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) {
    const l = lang[ext];
    if (l && !out.languages.includes(l)) out.languages.push(l);
  }

  // ONE LEVEL INSIDE THE OBVIOUS SOURCE DIRECTORIES.
  //
  // Measured on a real task: the model's first three calls were `list_dir src`,
  // `list_dir test` and `read_file package.json` — rediscovering, at the cost of
  // three round-trips, a shape that is three readdirs of deterministic local
  // work. That is exactly the "deterministic discovery first" trade, and it is
  // the cheap direction: this costs no request and a few dozen tokens.
  for (const e of names) {
    if (!e.isDirectory() || SKIP.test(e.name)) continue;
    if (!SOURCE_DIRS.test(e.name)) continue;
    if (out.tree.length >= MAX_SOURCE_DIRS) break;
    const listing = sourceFiles(path.join(root, e.name));
    if (!listing) continue;
    out.tree.push({
      dir: e.name,
      files: listing.files.slice(0, MAX_FILES_PER_DIR),
      more: Math.max(0, listing.files.length - MAX_FILES_PER_DIR),
      subdirs: listing.subdirs.slice(0, MAX_FILES_PER_DIR),
    });
  }
  return out;
}

/** A bounded brief for the system prompt. Built once per session. */
/**
 * WHAT THIS PROJECT IS — and it was already written down.
 *
 * ------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO STOP, observed live: request contexts climbing
 * 109k → 193k tokens while the model read one file after another to find out
 * what an unfamiliar project was. The brief handed it a hundred and fifty-six
 * FILENAMES and no meaning, so the only way to attach meaning to a name was to
 * open it. That is the model performing reconnaissance by hand.
 *
 * Meanwhile this repository — like most maintained ones — carries a README
 * whose Architecture section maps almost every module to a one-line purpose,
 * written by the people who wrote the code. Orientation read none of it. The
 * most accurate description of the project available anywhere was on disk, free
 * to read, and thrown away in favour of a directory listing.
 *
 * ------------------------------------------------------------------------
 * WHAT IS TAKEN, AND WHY SO LITTLE.
 *
 * NOT the README. A 47,000-character document pinned to every request would be
 * the same mistake in the other direction. What goes in is:
 *
 *   THE OPENING PROSE   the project's own answer to "what is this", which is
 *                       almost always the first real paragraph.
 *   THE SECTION MAP     `##` headings WITH THEIR LINE NUMBERS, so a model that
 *                       wants the architecture reads that range and nothing
 *                       else — a pointer costs a line and saves a whole file.
 *
 * A POINTER IS NOT A SUMMARY, and this never claims to be one. It says where
 * the answer is written; the model decides whether it needs it.
 */
const DOC_NAMES = /^(?:readme|contributing|architecture)\.(?:md|markdown|rst|txt)$/i;
/** How much of the opening prose is worth carrying. */
const MAX_DOC_INTRO = 420;
/** Section pointers listed. Beyond this a document is a book, not a map. */
const MAX_DOC_SECTIONS = 14;
/** Never read more of a document than this to find its headings. */
const MAX_DOC_BYTES = 400000;

/** A markdown line that is prose rather than furniture. */
function isProse(line) {
  const t = line.trim();
  if (!t) return false;
  if (/^[#>|\-*+=`[!<]/.test(t)) return false;        // heading, quote, list, badge, table, html
  if (/^\d+[.)]\s/.test(t)) return false;             // ordered list
  return t.length > 30;
}

/**
 * The project's own documentation, as an orientation block.
 * Returns '' when the project documents nothing — most do not, and silence is
 * the honest answer rather than an invented description.
 */
function docBrief(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return ''; }
  const readme = names.find((e) => e.isFile() && DOC_NAMES.test(e.name) && /^readme/i.test(e.name));
  const parts = [];

  if (readme) {
    let text = '';
    try {
      const abs = path.join(root, readme.name);
      if (fs.statSync(abs).size <= MAX_DOC_BYTES) text = fs.readFileSync(abs, 'utf8');
    } catch { text = ''; }
    if (text) {
      const lines = text.split('\n');
      const intro = [];
      for (let i = 0; i < lines.length && intro.join(' ').length < MAX_DOC_INTRO; i++) {
        if (isProse(lines[i])) intro.push(lines[i].trim());
        else if (intro.length) break;                  // the paragraph ended
      }
      if (intro.length) {
        const said = intro.join(' ').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ');
        parts.push(`What this project says it is (${readme.name}): ${said.slice(0, MAX_DOC_INTRO)}`);
      }
      // SECTION POINTERS, with line numbers, so the answer is one ranged read.
      const heads = [];
      for (let i = 0; i < lines.length && heads.length < MAX_DOC_SECTIONS; i++) {
        const m = /^##\s+(.{2,60}?)\s*$/.exec(lines[i]);
        if (m) heads.push(`${m[1]} (line ${i + 1})`);
      }
      if (heads.length) {
        parts.push(`${readme.name} sections — read a RANGE of these rather than the file: ${heads.join(' · ')}`);
      }
    }
  }

  // Other documentation, named only. Where it is beats what it says.
  const docDirs = [];
  for (const d of ['docs', 'doc', 'documentation']) {
    try {
      const inside = fs.readdirSync(path.join(root, d)).filter((f) => /\.(?:md|rst|txt)$/i.test(f));
      if (inside.length) docDirs.push(`${d}/: ${inside.slice(0, 12).join(' ')}`);
    } catch { /* no such directory */ }
  }
  const others = names
    .filter((e) => e.isFile() && DOC_NAMES.test(e.name) && !/^readme/i.test(e.name))
    .map((e) => e.name);
  if (others.length) docDirs.push(others.join(' '));
  if (docDirs.length) parts.push(`Documentation: ${docDirs.join(' | ')}`);

  return parts.join('\n');
}

/**
 * WHERE EXECUTION STARTS. A manifest usually states this outright, and a model
 * that has to infer an entry point from a directory listing is guessing at
 * something the project already declared.
 */
function entryPoints(root) {
  const out = [];
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (j && typeof j.bin === 'string') out.push(j.bin);
    else if (j && j.bin && typeof j.bin === 'object') out.push(...Object.values(j.bin).map(String));
    if (j && j.main) out.push(String(j.main));
  } catch { /* no manifest, or not JSON */ }
  return [...new Set(out)].slice(0, 4);
}

function brief(cwd) {
  const s = scan(cwd);
  const root = path.resolve(cwd || process.cwd());
  const parts = [];
  // ---- MEANING BEFORE NAMES ----------------------------------------------
  //
  // Ordered deliberately: the listing is what gets cut when a huge repository
  // exceeds MAX_CHARS, and losing the tail of a file list costs far less than
  // losing the sentence that says what the project is.
  const docs = docBrief(root);
  if (docs) parts.push(docs);
  if (s.languages.length) parts.push(`Languages: ${s.languages.join(', ')}`);
  if (s.manifests.length) parts.push(`Manifests: ${s.manifests.join(', ')}`);
  if (s.run.length) parts.push(`Likely commands: ${s.run.slice(0, 4).join(' · ')}`);
  const entries = entryPoints(root);
  if (entries.length) parts.push(`Entry point(s): ${entries.join(' · ')}`);
  if (s.entries.length) parts.push(`Top level: ${s.entries.join(' ')}`);
  for (const t of s.tree) {
    const items = [...t.subdirs, ...t.files];
    if (!items.length) continue;
    // ---- AS MANY NAMES AS FIT ON THE LINE, AND THE COUNT OF THE REST ----
    //
    // The file-count cap alone is the wrong bound and got this wrong in both
    // directions. At twelve it hid a hundred and forty-two modules of an
    // ordinary project; raised to two hundred, a three-thousand-file directory
    // became one seven-thousand-character line that then exceeded MAX_CHARS and
    // was dropped WHOLE — the large repository lost the listing entirely, which
    // is worse than the truncation it replaced.
    //
    // Characters are the bound that behaves correctly at both sizes: a normal
    // project is listed completely, and a huge one shows as many names as fit
    // and says how many it could not.
    let room = MAX_DIR_LINE - t.dir.length - 3;
    const shown = [];
    let hidden = t.more || 0;
    for (const name of items) {
      if (room - (name.length + 1) < 0) { hidden += 1; continue; }
      room -= name.length + 1;
      shown.push(name);
    }
    if (!shown.length) continue;
    parts.push(`${t.dir}/: ${shown.join(' ')}${hidden ? ` (+${hidden} more)` : ''}`);
  }
  const out = parts.join('\n');
  if (out.length <= MAX_CHARS) return out;
  // ---- CUT AT A LINE, AND SAY SO ----------------------------------------
  //
  // A mid-word cut through an inventory is worse than a shorter one: it leaves
  // half a filename that looks like a whole one, and nothing says the list
  // stopped. This ends on the last complete line and states that it was cut, so
  // "not in the brief" cannot be mistaken for "not in the project".
  const cut = out.slice(0, MAX_CHARS);
  const at = cut.lastIndexOf(String.fromCharCode(10));
  return (at > 0 ? cut.slice(0, at) : cut) + String.fromCharCode(10)
    + '[listing cut to fit — not the whole project; use glob or list_dir for the rest]';
}

/**
 * Path completion for the `@` menu.
 *
 * Deliberately ONE directory deep per keystroke: it lists the directory the
 * prefix names and filters by the last segment. There is no recursive walk, no
 * cached index and nothing is read into the prompt — only names, capped at
 * MAX_COMPLETIONS. The same SKIP set that keeps node_modules out of the project
 * brief keeps it out of the menu, so a generated tree can never flood it.
 *
 * @param {string} cwd     the session's working directory — the boundary
 * @param {string} prefix  what the user typed after `@`, e.g. "src/in"
 * @returns {Array<{path:string, isDir:boolean}>} project-relative, dirs first
 */
function completePath(cwd, prefix = '') {
  const raw = String(prefix || '').replace(/\\/g, '/');
  const slash = raw.lastIndexOf('/');
  const dirPart = slash >= 0 ? raw.slice(0, slash + 1) : '';
  const base = (slash >= 0 ? raw.slice(slash + 1) : raw).toLowerCase();

  const root = path.resolve(cwd || process.cwd());
  const dir = path.resolve(root, dirPart);
  // Never complete outside the project: `@../../` lists nothing rather than
  // offering the rest of the disk.
  const rel = path.relative(root, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return [];

  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const e of names) {
    if (SKIP.test(e.name)) continue;
    if (!base && e.name.startsWith('.')) continue;      // hidden only on request
    if (base && !e.name.toLowerCase().startsWith(base)) continue;
    out.push({ path: dirPart + e.name + (e.isDirectory() ? '/' : ''), isDir: e.isDirectory() });
  }
  out.sort((a, b) => (a.isDir === b.isDir ? a.path.localeCompare(b.path) : a.isDir ? -1 : 1));
  return out.slice(0, MAX_COMPLETIONS);
}

module.exports = { scan, brief, completePath, SKIP, MAX_CHARS, MAX_ENTRIES, MAX_COMPLETIONS };
