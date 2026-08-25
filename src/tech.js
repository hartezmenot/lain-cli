'use strict';

/**
 * TECHNOLOGIES, AS DATA — never as pairs.
 *
 * The whole point of the migration engine is that there is no `cpp_to_python`
 * and no `react_to_vue` anywhere in the program. A pair is a combinatorial
 * explosion nobody can finish writing: eleven languages alone is a hundred and
 * ten directions, and the twelfth language breaks every one of them.
 *
 * So what is written down is one row per technology — what it is called, what
 * it is called by people who are in a hurry, which files belong to it, and how
 * you can tell it is present in a tree. A migration is then any ORDERED PAIR of
 * rows, including two rows this file has never seen: an unknown name resolves
 * to an `unknown` descriptor that carries the user's own word and no claims,
 * and the rest of the engine works with it exactly as it works with C++.
 *
 * ------------------------------------------------------------------------
 * WHAT A ROW MAY AND MAY NOT SAY.
 *
 * It may say what its files look like, because that is a fact about the world.
 * It may NOT say how to translate anything, what the target should be called,
 * or what the idiomatic equivalent of a C++ destructor is in Python. That is
 * the expensive model's job, and a table of hand-written equivalences is how
 * the pair explosion gets in through the back door.
 * ------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

/** What KIND of thing is being migrated. It changes how scope is resolved. */
const TECH_KIND = Object.freeze({
  LANGUAGE: 'language',
  FRAMEWORK: 'framework',
  BUILD: 'build system',
  RUNTIME: 'runtime',
  AGENT: 'agent',
  COMPONENT: 'component',
  UNKNOWN: 'unknown',
});

/**
 * ROWS. `ext` is ordered — the FIRST is what a new file of this technology is
 * named, and the rest are recognised but not generated. `marks` are the files
 * or dependency names whose presence is evidence the technology is in use.
 */
const ROWS = [
  // ---- languages --------------------------------------------------------
  { id: 'cpp', label: 'C++', kind: TECH_KIND.LANGUAGE, aliases: ['c++', 'cplusplus', 'cxx'], ext: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'], marks: ['CMakeLists.txt', 'Makefile'] },
  { id: 'c', label: 'C', kind: TECH_KIND.LANGUAGE, aliases: [], ext: ['.c', '.h'], marks: ['Makefile'] },
  { id: 'python', label: 'Python', kind: TECH_KIND.LANGUAGE, aliases: ['py', 'python3'], ext: ['.py'], marks: ['pyproject.toml', 'requirements.txt', 'setup.py'] },
  { id: 'rust', label: 'Rust', kind: TECH_KIND.LANGUAGE, aliases: ['rs'], ext: ['.rs'], marks: ['Cargo.toml'] },
  { id: 'go', label: 'Go', kind: TECH_KIND.LANGUAGE, aliases: ['golang'], ext: ['.go'], marks: ['go.mod'] },
  { id: 'javascript', label: 'JavaScript', kind: TECH_KIND.LANGUAGE, aliases: ['js', 'node', 'nodejs'], ext: ['.js', '.mjs', '.cjs'], marks: ['package.json'] },
  { id: 'typescript', label: 'TypeScript', kind: TECH_KIND.LANGUAGE, aliases: ['ts'], ext: ['.ts', '.tsx'], marks: ['tsconfig.json'] },
  { id: 'java', label: 'Java', kind: TECH_KIND.LANGUAGE, aliases: [], ext: ['.java'], marks: ['pom.xml', 'build.gradle'] },
  { id: 'kotlin', label: 'Kotlin', kind: TECH_KIND.LANGUAGE, aliases: ['kt'], ext: ['.kt', '.kts'], marks: ['build.gradle.kts'] },
  { id: 'csharp', label: 'C#', kind: TECH_KIND.LANGUAGE, aliases: ['c#', 'cs', 'dotnet'], ext: ['.cs'], marks: [] },
  { id: 'ruby', label: 'Ruby', kind: TECH_KIND.LANGUAGE, aliases: ['rb'], ext: ['.rb'], marks: ['Gemfile'] },
  { id: 'php', label: 'PHP', kind: TECH_KIND.LANGUAGE, aliases: [], ext: ['.php'], marks: ['composer.json'] },
  { id: 'swift', label: 'Swift', kind: TECH_KIND.LANGUAGE, aliases: [], ext: ['.swift'], marks: ['Package.swift'] },

  // ---- front-end frameworks --------------------------------------------
  { id: 'react', label: 'React', kind: TECH_KIND.FRAMEWORK, aliases: ['reactjs'], ext: ['.jsx', '.tsx'], marks: ['react'] },
  { id: 'vue', label: 'Vue', kind: TECH_KIND.FRAMEWORK, aliases: ['vuejs'], ext: ['.vue'], marks: ['vue'] },
  { id: 'svelte', label: 'Svelte', kind: TECH_KIND.FRAMEWORK, aliases: [], ext: ['.svelte'], marks: ['svelte'] },
  { id: 'angular', label: 'Angular', kind: TECH_KIND.FRAMEWORK, aliases: ['angularjs'], ext: ['.component.ts'], marks: ['@angular/core'] },
  { id: 'solid', label: 'Solid', kind: TECH_KIND.FRAMEWORK, aliases: ['solidjs'], ext: ['.jsx', '.tsx'], marks: ['solid-js'] },

  // ---- build systems ----------------------------------------------------
  { id: 'webpack', label: 'webpack', kind: TECH_KIND.BUILD, aliases: [], ext: [], marks: ['webpack.config.js', 'webpack.config.ts', 'webpack'] },
  { id: 'vite', label: 'Vite', kind: TECH_KIND.BUILD, aliases: [], ext: [], marks: ['vite.config.js', 'vite.config.ts', 'vite'] },
  { id: 'rollup', label: 'Rollup', kind: TECH_KIND.BUILD, aliases: [], ext: [], marks: ['rollup.config.js', 'rollup'] },
  { id: 'esbuild', label: 'esbuild', kind: TECH_KIND.BUILD, aliases: [], ext: [], marks: ['esbuild'] },
  { id: 'parcel', label: 'Parcel', kind: TECH_KIND.BUILD, aliases: [], ext: [], marks: ['parcel'] },
  { id: 'cmake', label: 'CMake', kind: TECH_KIND.BUILD, aliases: [], ext: ['.cmake'], marks: ['CMakeLists.txt'] },
  { id: 'make', label: 'Make', kind: TECH_KIND.BUILD, aliases: ['makefile'], ext: [], marks: ['Makefile', 'makefile'] },

  // ---- runtimes ---------------------------------------------------------
  { id: 'deno', label: 'Deno', kind: TECH_KIND.RUNTIME, aliases: [], ext: [], marks: ['deno.json', 'deno.jsonc'] },
  { id: 'bun', label: 'Bun', kind: TECH_KIND.RUNTIME, aliases: [], ext: [], marks: ['bun.lockb', 'bunfig.toml'] },
];

const BY_ID = new Map();
for (const r of ROWS) {
  BY_ID.set(r.id, r);
  for (const a of r.aliases) BY_ID.set(a, r);
}

/** Words that name a coding agent rather than a technology. */
const AGENT_RE = /\b(?:agent|agents|sub-?agent|assistant|bot|worker)\b/i;

function normalise(name) {
  return String(name == null ? '' : name).trim().toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-(?:js|lang|framework)$/, '');
}

/**
 * Resolve a name a person wrote into a descriptor.
 *
 * AN UNKNOWN NAME IS NOT A FAILURE. "Migrate the renderer from Skia to my own
 * rasteriser" is a perfectly good migration and this file has never heard of
 * either side; it gets a descriptor carrying the user's own word, `kind` of
 * UNKNOWN and no extensions, and every stage downstream is written to cope
 * with exactly that — target paths become questions the model answers instead
 * of derivations this table makes.
 */
function resolve(name) {
  const raw = String(name == null ? '' : name).trim();
  if (!raw) return null;
  const key = normalise(raw);
  const hit = BY_ID.get(key) || BY_ID.get(key.replace(/-/g, ''));
  if (hit) return { ...hit, known: true, given: raw };
  return {
    id: key,
    label: raw,
    kind: AGENT_RE.test(raw) ? TECH_KIND.AGENT : TECH_KIND.UNKNOWN,
    aliases: [],
    ext: [],
    marks: [],
    known: false,
    given: raw,
  };
}

/** Every name this table answers to, longest first so "typescript" beats "ts". */
function vocabulary() {
  const out = [];
  for (const r of ROWS) { out.push(r.id); for (const a of r.aliases) out.push(a); }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

/** Does this path belong to this technology, by extension alone? */
function owns(tech, rel) {
  if (!tech || !tech.ext || !tech.ext.length) return false;
  const p = String(rel || '').replace(/\\/g, '/').toLowerCase();
  return tech.ext.some((e) => p.endsWith(e));
}

/** The extension a NEW file of this technology gets, or '' when unknown. */
function primaryExt(tech) {
  return tech && tech.ext && tech.ext.length ? tech.ext[0] : '';
}

/**
 * Rewrite one path from one technology to another.
 *
 * Returns '' when the target has no extension of its own — a build system, a
 * runtime, an unknown name — because inventing `webpack.config.vite` would be
 * worse than admitting the mapping is not derivable and letting the contract
 * carry it as an open question.
 */
function retarget(rel, from, to) {
  const p = String(rel || '').replace(/\\/g, '/');
  const ext = primaryExt(to);
  if (!ext) return '';
  const cur = path.posix.extname(p);
  if (!cur) return '';
  // A HEADER HAS NO COUNTERPART in a language without headers, so `scanner.hpp`
  // and `scanner.cpp` would both become `scanner.py` and one would silently
  // overwrite the other. Naming it keeps the collision visible in the map.
  return p.slice(0, -cur.length) + ext;
}

/**
 * Which technologies are actually present in this tree, with the evidence.
 *
 * Counted from real files, so "React" means jsx files or a react dependency,
 * not a word in a README. Used to resolve an implicit source ("migrate this to
 * Python" — from what?) without spending a model call on it.
 */
function detect(root) {
  const { walk } = require('./tools/search');
  const counts = new Map();
  const marks = new Map();
  let deps = new Set();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  } catch { deps = new Set(); }

  let seen = 0;
  for (const f of walk(root)) {
    if (++seen > 6000) break;
    const base = path.posix.basename(f.rel);
    for (const r of ROWS) {
      if (owns(r, f.rel)) counts.set(r.id, (counts.get(r.id) || 0) + 1);
      for (const m of r.marks) {
        if (m === base || deps.has(m)) {
          if (!marks.has(r.id)) marks.set(r.id, new Set());
          marks.get(r.id).add(deps.has(m) && m !== base ? `dependency ${m}` : f.rel);
        }
      }
    }
  }
  const out = [];
  for (const r of ROWS) {
    const files = counts.get(r.id) || 0;
    const ev = marks.has(r.id) ? [...marks.get(r.id)].slice(0, 3) : [];
    if (!files && !ev.length) continue;
    out.push({ ...r, known: true, given: r.label, files, evidence: ev });
  }
  return out.sort((a, b) => (b.files - a.files) || (b.evidence.length - a.evidence.length));
}

module.exports = { TECH_KIND, ROWS, resolve, vocabulary, owns, primaryExt, retarget, detect, normalise, AGENT_RE };
