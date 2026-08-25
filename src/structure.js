'use strict';

/**
 * WHAT A SOURCE FILE IS MADE OF, IN ANY LANGUAGE.
 *
 * `codemodel.js` answers this for JavaScript with a real token stream, and
 * nothing here competes with it — for a `.js` file this module CALLS it. What
 * this adds is the same question asked of a `.cpp`, a `.py`, a `.rs`, a `.vue`
 * or an agent definition written in Markdown, because a migration has to be
 * able to say what the SOURCE was made of before it can say what the TARGET
 * should be made of.
 *
 * ------------------------------------------------------------------------
 * IT IS DELIBERATELY LEXICAL, AND THAT IS THE RIGHT TRADE.
 *
 * A real parser for eleven languages is eleven dependencies that have to be
 * installed on the user's machine, and the question being asked does not need
 * one. "This file declares a Scanner with initialize, scan, filter and result"
 * is answerable from declaration lines, and it is ALL that the structural
 * translation stage consumes: the responsibilities, not the bodies.
 *
 * So the failure mode is chosen on purpose. It MISSES declarations written in
 * shapes the patterns do not cover, and it never INVENTS one — a missed unit
 * shows up as a smaller target structure that the model then fills in, while a
 * fabricated unit would be a responsibility nobody asked for. Under-reporting
 * is recoverable; over-reporting is a lie about the user's code.
 * ------------------------------------------------------------------------
 *
 * NOTHING HERE IS CACHED. Same rule as codemodel.js: the file on disk at the
 * moment of the call is the answer, so there is nothing to go stale.
 */

const fs = require('fs');
const path = require('path');

const { supports } = require('./jsscan');

/** How a declaration is described. One word each, borrowed where it exists. */
const UNIT = Object.freeze({
  CLASS: 'class',
  FUNCTION: 'function',
  METHOD: 'method',
  STRUCT: 'struct',
  TRAIT: 'trait',
  MODULE: 'module',
  SECTION: 'section',
});

/** A file bigger than this is not read. Structure is in the declarations. */
const MAX_BYTES = 1500000;
/** Units reported for one file. A file with more than this has other problems. */
const MAX_UNITS = 400;

/**
 * THE PATTERNS, one family per language.
 *
 * Each entry is `[regexp, kind, nameGroup]` and is applied per LINE, so a
 * declaration inside a string that happens to span a line boundary cannot
 * match halfway. Anchored at the start of the line wherever the language
 * allows, because an unanchored class pattern matches the word "class" in a
 * comment, and that is the over-reporting this file refuses to do.
 */
const PATTERNS = {
  python: [
    [/^\s*class\s+([A-Za-z_]\w*)/, UNIT.CLASS, 1],
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, UNIT.FUNCTION, 1],
  ],
  c: [
    [/^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+([A-Za-z_]\w*)/, UNIT.CLASS, 1],
    // A DEFINITION, not a declaration: it ends in an opening brace, not in a
    // semicolon. That is the whole difference between a header's promise and a
    // file's contents.
    [/^\s*(?:[A-Za-z_][\w:<>,*&\s]*\s+)?([A-Za-z_]\w*)::([A-Za-z_~]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, UNIT.METHOD, 2],
    [/^\s*(?:static\s+|inline\s+|virtual\s+|explicit\s+)*[A-Za-z_][\w:<>,*&\s]*\s+\*?([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:const\s*)?\{/, UNIT.FUNCTION, 1],
  ],
  rust: [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, UNIT.STRUCT, 1],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, UNIT.STRUCT, 1],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, UNIT.TRAIT, 1],
    [/^\s*impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_]\w*(?:\s*<[^>]*>)?\s+for\s+)?([A-Za-z_]\w*)/, UNIT.MODULE, 1],
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z_]\w*)/, UNIT.FUNCTION, 1],
  ],
  go: [
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/, UNIT.STRUCT, 1],
    [/^\s*func\s+\([^)]*\)\s*([A-Za-z_]\w*)\s*\(/, UNIT.METHOD, 1],
    [/^\s*func\s+([A-Za-z_]\w*)\s*\(/, UNIT.FUNCTION, 1],
  ],
  java: [
    [/^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+|sealed\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, UNIT.CLASS, 1],
    [/^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|synchronized\s+|override\s+|open\s+)+[A-Za-z_][\w<>,[\]\s.]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws [\w,\s.]+)?\{/, UNIT.METHOD, 1],
    [/^\s*(?:override\s+)?fun\s+([A-Za-z_]\w*)\s*\(/, UNIT.FUNCTION, 1],
    [/^\s*(?:public\s+|private\s+|override\s+|static\s+)*func\s+([A-Za-z_]\w*)\s*\(/, UNIT.FUNCTION, 1],
  ],
  ruby: [
    [/^\s*(?:class|module)\s+([A-Za-z_]\w*)/, UNIT.CLASS, 1],
    [/^\s*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/, UNIT.FUNCTION, 1],
  ],
  php: [
    [/^\s*(?:abstract\s+|final\s+)*(?:class|interface|trait)\s+([A-Za-z_]\w*)/, UNIT.CLASS, 1],
    [/^\s*(?:public\s+|private\s+|protected\s+|static\s+)*function\s+([A-Za-z_]\w*)/, UNIT.FUNCTION, 1],
  ],
  /** TypeScript, JSX, Vue, Svelte — JavaScript-shaped, and codemodel declines. */
  jsLike: [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, UNIT.CLASS, 1],
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, UNIT.FUNCTION, 1],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, UNIT.FUNCTION, 1],
    [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, UNIT.CLASS, 1],
  ],
  /** A Markdown document — an agent definition, a spec, a responsibility list. */
  markdown: [
    [/^#{1,4}\s+(.+?)\s*$/, UNIT.SECTION, 1],
  ],
  shell: [
    [/^\s*(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{/, UNIT.FUNCTION, 1],
  ],
};

/** Which pattern family an extension belongs to. */
const FAMILY = {
  py: 'python', pyi: 'python',
  c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hxx: 'c', ino: 'c',
  rs: 'rust',
  go: 'go',
  java: 'java', kt: 'java', kts: 'java', cs: 'java', scala: 'java', swift: 'java',
  rb: 'ruby',
  php: 'php',
  ts: 'jsLike', tsx: 'jsLike', jsx: 'jsLike', mts: 'jsLike', cts: 'jsLike',
  vue: 'jsLike', svelte: 'jsLike', astro: 'jsLike',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  sh: 'shell', bash: 'shell', zsh: 'shell',
};

/** Files that carry DATA rather than behaviour. They have no units, by nature. */
const DATA_RE = /\.(?:json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|properties|lock)$/i;

/** The extension that names this file's language, or '' when it has none. */
function languageOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase().replace('.', '');
  return ext || '';
}

/** Is this path a data or configuration resource rather than an implementation? */
function isData(file) { return DATA_RE.test(String(file || '')); }

/**
 * The units declared in `source`.
 *
 * JavaScript goes to codemodel.js, which has a token stream and therefore knows
 * a name in a string from a name in code. Everything else uses the line
 * patterns above. Never throws: an unreadable or unrecognised file has no
 * structure to report, which is a fact rather than an error.
 */
function extract(source, file = '') {
  const text = String(source == null ? '' : source);
  const language = languageOf(file);
  const out = { file: String(file || '').replace(/\\/g, '/'), language, data: isData(file), units: [], via: 'none' };
  if (out.data || !text) return out;

  // ---- JAVASCRIPT: THE REAL MODEL, NOT A SECOND ONE ----------------------
  if (supports(file)) {
    try {
      const model = require('./codemodel').scan(text, file);
      out.via = 'codemodel';
      for (const s of model.symbols.slice(0, MAX_UNITS)) {
        out.units.push({ name: s.name, kind: s.kind, container: s.container || '', line: s.startLine });
      }
      return out;
    } catch { /* fall through to the patterns, which cannot throw */ }
  }

  const familyName = FAMILY[language];
  const family = PATTERNS[familyName];
  if (!family) return out;
  out.via = familyName;

  const lines = text.split('\n');
  // A CONTAINER IS INFERRED FROM INDENTATION, and only where the language
  // actually uses indentation to mean containment. Guessing a container in C++
  // from whitespace would attribute a free function to whichever class was
  // declared above it, so the guess is made only where it is sound.
  const indentScoped = familyName === 'python' || familyName === 'ruby';
  let container = '';
  let containerIndent = -1;

  for (let i = 0; i < lines.length && out.units.length < MAX_UNITS; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*(?:#|\/\/|\*)/.test(line)) continue;
    const indent = line.length - line.replace(/^\s*/, '').length;
    if (indentScoped && container && indent <= containerIndent) { container = ''; containerIndent = -1; }
    for (const [re, kind, group] of family) {
      const m = re.exec(line);
      if (!m || !m[group]) continue;
      const name = m[group].trim();
      const isContainer = kind === UNIT.CLASS || kind === UNIT.MODULE || kind === UNIT.STRUCT || kind === UNIT.TRAIT;
      out.units.push({
        name,
        kind: indentScoped && container && !isContainer ? UNIT.METHOD : kind,
        container: indentScoped ? container : (kind === UNIT.METHOD && m[1] && m[2] ? m[1] : ''),
        line: i + 1,
      });
      if (indentScoped && isContainer) { container = name; containerIndent = indent; }
      break;                                        // one unit per line, at most
    }
  }
  return out;
}

/** `extract` for a path on disk. A file that cannot be read has no structure. */
function extractFile(abs, rel = '') {
  let st;
  try { st = fs.statSync(abs); } catch { return extract('', rel || abs); }
  if (!st.isFile() || st.size > MAX_BYTES) return extract('', rel || abs);
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return extract('', rel || abs); }
  return extract(text, rel || abs);
}

/**
 * The RESPONSIBILITIES a structure describes, as plain names.
 *
 * This is what survives a migration. `Scanner.scan` is a responsibility; the
 * fact that it was spelled `void Scanner::scan()` is not, and carrying the
 * spelling across would be translating syntax instead of preserving behaviour.
 */
function responsibilities(struct) {
  const out = [];
  for (const u of (struct && struct.units) || []) {
    out.push(u.container ? `${u.container}.${u.name}` : u.name);
  }
  return [...new Set(out)];
}

/** One line per unit, nested under its container. For a report or a prompt. */
function describe(struct, { indent = '  ' } = {}) {
  const s = struct || { units: [] };
  if (!s.units.length) return `${indent}(no declarations found${s.data ? ' — this is a data resource' : ''})`;
  const byContainer = new Map();
  for (const u of s.units) {
    const key = u.container || '';
    if (!byContainer.has(key)) byContainer.set(key, []);
    byContainer.get(key).push(u);
  }
  const lines = [];
  const top = byContainer.get('') || [];
  const named = new Set(top.map((u) => u.name));
  for (const u of top) {
    lines.push(`${indent}${u.name}`);
    for (const child of byContainer.get(u.name) || []) lines.push(`${indent}  |-- ${child.name}()`);
  }
  for (const [key, kids] of byContainer) {
    if (!key || named.has(key)) continue;
    lines.push(`${indent}${key}`);
    for (const child of kids) lines.push(`${indent}  |-- ${child.name}()`);
  }
  return lines.join('\n');
}

module.exports = {
  extract, extractFile, responsibilities, describe, languageOf, isData,
  UNIT, PATTERNS, FAMILY, DATA_RE, MAX_UNITS, MAX_BYTES,
};
