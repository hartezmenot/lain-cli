'use strict';

/**
 * FROM A SENTENCE TO A CONTRACT, without a single model call.
 *
 * This is the stage between "migrate the scanner to Python" and a document
 * saying scanner.cpp becomes scanner.py, memory.cpp becomes memory.py,
 * enemies.json is not to be touched, three files import the old module and
 * will have to change, and the C++ under src/audio is outside the scope and
 * must still be there afterwards.
 *
 * ------------------------------------------------------------------------
 * WHY IT MATTERS THAT NONE OF THIS COSTS TOKENS.
 *
 * Every fact above is on the disk. A model asked to establish them reads
 * forty files to do it, at the price of the largest model in the project,
 * and then has to hold all forty in context while it writes code. The same
 * facts gathered here cost a directory walk, and what reaches the model is
 * the CONCLUSION — a page of contract instead of a repository.
 *
 * The saving is not the point on its own. The point is that a model working
 * from a contract cannot forget scanner.cpp, because scanner.cpp is a line in
 * the document it was given, whereas a model working from a repository forgets
 * it exactly as often as people do.
 * ------------------------------------------------------------------------
 *
 * THE ONE THING IT WILL NOT DO IS GUESS THE SCOPE. Where the request does not
 * say and the tree offers more than one reading, this reports the candidates
 * and stops. migrationintent.js turns that into a question; nothing here
 * decides it.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tech = require('./tech');
const structure = require('./structure');
const M = require('./migration');
const { walk } = require('./tools/search');

/** Bounds. A migration plan that takes a minute is one nobody waits for. */
const MAX_FILES = 4000;
const MAX_SCOPE_FILES = 300;
const MAX_DEPENDENCY_PROBES = 24;
const MAX_CONTENT_BYTES = 400000;

/** Paths that are never part of a migration, whatever the scope says. */
const NEVER = /(?:^|\/)(?:node_modules|\.git|dist|build|out|coverage|vendor|__pycache__|\.venv|venv|target)(?:\/|$)/i;
/** A test, so the contract can say a leftover there is still a live path. */
const TEST_RE = /(?:^|\/)(?:tests?|spec|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i;

// ------------------------------------------------------------ the tree -----

/** Every file worth considering, project-relative and forward-slashed. */
function files(root) {
  const out = [];
  for (const f of walk(root)) {
    if (NEVER.test(f.rel)) continue;
    out.push(f);
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

/**
 * Does this file belong to this technology?
 *
 * EXTENSION FIRST, because it is free and it is right for a language. For a
 * FRAMEWORK it is not enough — React lives in `.js` as happily as in `.jsx` —
 * so the file's own imports are consulted, which is evidence rather than a
 * naming convention. For a BUILD SYSTEM or a RUNTIME there are no files of its
 * own at all: what identifies it is its configuration, which is what `marks`
 * lists.
 */
function ownedBy(techRow, f, { text = null } = {}) {
  if (!techRow) return false;
  if (tech.owns(techRow, f.rel)) return true;
  const base = path.posix.basename(f.rel);
  if ((techRow.marks || []).includes(base)) return true;
  if (techRow.kind !== tech.TECH_KIND.FRAMEWORK) return false;
  const src = text == null ? read(f.abs) : text;
  if (!src) return false;
  const id = techRow.id.replace(/[^\w-]/g, '');
  if (!id) return false;
  return new RegExp(`(?:from|require\\(|import)\\s*['"]${id}(?:[/'"]|$)`, 'm').test(src);
}

function read(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_CONTENT_BYTES) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch { return ''; }
}

function sha(text) { return crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 16); }

// ------------------------------------------------------- what is in here ---

/**
 * THE PARTS THIS PROJECT IS MADE OF, as candidate scopes.
 *
 * Agents first, because "change Agent B to Vue" is the case where getting
 * scope wrong is most expensive and where the parts are most explicitly
 * named. Failing that, the directories the source technology actually lives
 * in — which is a far better candidate list than every directory, since a
 * scope containing none of the thing being migrated is not a scope anybody
 * meant.
 */
function components(root, { source = null } = {}) {
  const all = files(root);
  const agents = new Map();
  for (const f of all) {
    const seg = f.rel.split('/');
    const i = seg.findIndex((s) => s.toLowerCase() === 'agents');
    let key = '';
    if (i >= 0 && seg.length > i + 1) key = seg[i + 1].replace(/\.[^.]+$/, '');
    else if (/(?:^|[-_.])agents?(?:[-_.]|$)/i.test(seg[seg.length - 1])) key = seg[seg.length - 1].replace(/\.[^.]+$/, '');
    if (!key) continue;
    if (!agents.has(key)) agents.set(key, { name: key, label: key, noun: 'agent', kind: 'agent', paths: [], files: [] });
    agents.get(key).files.push(f);
  }
  if (agents.size) {
    for (const c of agents.values()) c.paths = [...new Set(c.files.map((f) => dirScope(f.rel)))];
    return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---- otherwise, the directories the source actually lives in ----------
  const dirs = new Map();
  for (const f of all) {
    if (source && !ownedBy(source, f)) continue;
    const seg = f.rel.split('/');
    const key = seg.length > 1 ? seg.slice(0, seg[0] === 'src' && seg.length > 2 ? 2 : 1).join('/') : '.';
    if (!dirs.has(key)) dirs.set(key, { name: key, label: key, noun: 'directory', kind: 'directory', paths: [key], files: [] });
    dirs.get(key).files.push(f);
  }
  return [...dirs.values()].sort((a, b) => b.files.length - a.files.length);
}

/** Directories that exist to hold resources rather than implementation. */
const RESOURCE_DIR_RE = /(?:^|\/)(?:data|config|configs|conf|settings|assets|resources|res|fixtures|content|locales|i18n|schemas?)(?:\/|$)/i;
/** Preserved resources named in one contract. A list nobody reads is not a list. */
const MAX_PRESERVED = 60;

/**
 * Data files the code in scope actually names.
 *
 * Matched on the file's own basename appearing in a scoped source file — which
 * is how a data file is referred to in every language, whether by `open(...)`,
 * a bundler path or a fetch. Crude, and crude in the safe direction: a file
 * named for no reason is preserved, and preserving something unnecessarily
 * costs nothing.
 */
function referencedResources(all, scope) {
  const data = all.filter((f) => structure.isData(f.rel));
  if (!data.length) return new Set();
  const out = new Set();
  const scoped = all.filter((f) => inScope(scope, f.rel) && !structure.isData(f.rel));
  const texts = scoped.slice(0, MAX_SCOPE_FILES).map((f) => read(f.abs)).filter(Boolean);
  if (!texts.length) return out;
  const blob = texts.join('\n');
  for (const f of data) {
    const base = path.posix.basename(f.rel);
    if (blob.includes(base)) out.add(f.rel);
  }
  return out;
}

/** The directory a file belongs to, for grouping. Never the bare root. */
function dirScope(rel) {
  const d = path.posix.dirname(rel);
  return d === '.' ? rel : d;
}

// ----------------------------------------------------------- scope --------

/**
 * WHICH FILES THIS MIGRATION IS ALLOWED TO TOUCH.
 *
 * Returns the scope AND the candidates, because an unresolvable scope is not
 * an error — it is a question, and the caller needs the options to ask it.
 */
function resolveScope(root, draft, source) {
  const cands = components(root, { source });
  if (draft.projectWide) {
    return { scope: { kind: M.SCOPE_KIND.PROJECT, label: 'the whole project', paths: [], components: [], resolved: true }, candidates: cands };
  }
  // A CHOSEN COMPONENT IS A COMPONENT SCOPE, and is read BEFORE the raw paths.
  // Answering "agent-b" also fills in that component's paths, so a paths-first
  // reading turned every answered scope question into an anonymous list of
  // directories — the same files, but with the component's NAME thrown away,
  // and the name is what `KEEP` and the merge map are written in terms of.
  if (draft.component) {
    const c = cands.find((x) => x.name.toLowerCase() === String(draft.component).toLowerCase());
    if (c) {
      return {
        scope: { kind: M.SCOPE_KIND.COMPONENT, label: c.label, paths: c.paths, components: [c.name], resolved: true },
        candidates: cands,
      };
    }
  }
  const named = (draft.paths || []).filter((p) => fs.existsSync(path.resolve(root, p)));
  if (named.length) {
    const owning = cands.filter((c) => (c.paths || []).some((p) => named.includes(p)));
    return {
      scope: {
        kind: M.SCOPE_KIND.PATHS,
        label: named.join(', '),
        paths: named,
        components: owning.map((c) => c.name),
        resolved: true,
      },
      candidates: cands,
    };
  }
  // A NAME IN THE REQUEST THAT MATCHES A COMPONENT is a resolved scope. "Change
  // Agent B from React to Vue" names its own scope and must never be asked
  // about — asking a question the user already answered is the failure
  // clarify.js refuses by name.
  const mentioned = cands.filter((c) => mentions(draft.text, c.name));
  if (mentioned.length === 1) {
    const c = mentioned[0];
    return {
      scope: { kind: M.SCOPE_KIND.COMPONENT, label: c.label, paths: c.paths, components: [c.name], resolved: true },
      candidates: cands,
    };
  }
  if (cands.length === 1) {
    const c = cands[0];
    return {
      scope: { kind: M.SCOPE_KIND.COMPONENT, label: c.label, paths: c.paths, components: [c.name], resolved: true },
      candidates: cands,
    };
  }
  return { scope: { kind: null, label: '', paths: [], components: [], resolved: false }, candidates: cands };
}

/** Does the request name this component? Tolerates "agent-b" against "Agent B". */
function mentions(text, name) {
  const t = String(text || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (t.includes(n)) return true;
  const loose = n.replace(/[-_]+/g, ' ');
  return loose !== n && t.includes(loose);
}

/** Is this file inside the scope? */
function inScope(scope, rel) {
  if (!scope || !scope.kind) return false;
  if (scope.kind === M.SCOPE_KIND.PROJECT) return true;
  const p = String(rel).replace(/\\/g, '/');
  return (scope.paths || []).some((s) => {
    const q = String(s).replace(/\\/g, '/').replace(/\/$/, '');
    return p === q || p.startsWith(`${q}/`);
  });
}

// -------------------------------------------------- resource classification --

/**
 * WHAT EVERY FILE IN RANGE IS FOR, AND THEREFORE WHAT HAPPENS TO IT.
 *
 * THE RULE THAT MATTERS MOST IS THE BORING ONE: a `.json` is not a `.cpp`.
 * `enemies.json` and `settings.json` are read by whatever implementation is
 * running and do not care which language it was written in, so the default for
 * data is PRESERVE and it takes an explicit instruction to move it. A model
 * told to "migrate this to Python" will otherwise rewrite the data files too,
 * because they were in the folder it was looking at.
 */
function classify(root, scope, source, target, draft) {
  const out = { translate: [], preserve: [], adapt: [], keep: [], unknownTarget: [] };
  const dataWanted = draft && draft.dataHint === 'TRANSLATE';
  const all = files(root);
  const mentioned = referencedResources(all, scope);

  for (const f of all) {
    const within = inScope(scope, f.rel);
    const text = structure.isData(f.rel) ? null : read(f.abs);
    const owned = ownedBy(source, f, { text });

    // ---- DATA THE SCOPE DEPENDS ON IS IN RANGE, WHEREVER IT LIVES -------
    //
    // `src/` is the scope and `data/enemies.json` is not in it, and a contract
    // that therefore says nothing about the JSON has left the single most
    // common over-reach unaddressed: a model told to migrate a folder to
    // Python rewrites the data files it finds on the way, because nothing told
    // it not to. Silence is not an instruction. So a resource the scope reads,
    // or one sitting in a directory that exists to hold resources, is written
    // down as PRESERVE explicitly.
    if (!within && structure.isData(f.rel) && (mentioned.has(f.rel) || RESOURCE_DIR_RE.test(f.rel))) {
      if (out.preserve.length < MAX_PRESERVED) {
        out.preserve.push({
          path: f.rel,
          why: mentioned.has(f.rel) ? 'read by the code being migrated' : 'a project resource, not an implementation',
          hash: sha(read(f.abs)),
        });
      }
      continue;
    }

    if (!within) {
      // ---- THE HYBRID CASE, WRITTEN DOWN RATHER THAN LEFT OUT ----------
      //
      // A file of the source technology outside the scope is not "not
      // mentioned". It is KEEP, asserted, so migrating it is a verification
      // failure instead of initiative. See migration.js on why KEEP is an
      // operation.
      if (owned) out.keep.push({ path: f.rel, why: 'outside the migration scope' });
      continue;
    }

    if (structure.isData(f.rel)) {
      const content = read(f.abs);
      if (dataWanted) out.adapt.push({ path: f.rel, why: 'the request asked for the data to be migrated too' });
      else out.preserve.push({ path: f.rel, why: 'data or configuration — read by either implementation', hash: sha(content) });
      continue;
    }

    if (!owned) {
      // In scope, but not the thing being migrated: another language's file,
      // an asset, a readme. Left alone and said so.
      out.preserve.push({ path: f.rel, why: 'in scope but not part of the source implementation', hash: sha(text || '') });
      continue;
    }

    const to = tech.retarget(f.rel, source, target);
    const rec = {
      path: f.rel,
      target: to,
      test: TEST_RE.test(f.rel),
      structure: structure.extractFile(f.abs, f.rel),
    };
    if (!to) out.unknownTarget.push(rec);
    out.translate.push(rec);
    if (out.translate.length >= MAX_SCOPE_FILES) break;
  }
  return out;
}

// ------------------------------------------------------------ dependencies --

/**
 * WHO ELSE FINDS OUT ABOUT THIS.
 *
 * `direct` is what the migration rewrites. `affected` is everything that
 * imports one of those and therefore breaks the moment the old file stops
 * existing — the list that turns "the tests pass" into "the tests pass and
 * three other modules still point at a file that is gone".
 *
 * Built on residue.forPath, which already answers exactly this and classifies
 * on tokens rather than counting text.
 */
function dependencies(root, translate) {
  const residue = require('./residue');
  const direct = translate.map((t) => t.path);
  const affected = new Map();
  for (const t of translate.slice(0, MAX_DEPENDENCY_PROBES)) {
    let r;
    try { r = residue.forPath(root, t.path); } catch { continue; }
    for (const imp of r.importers) {
      if (direct.includes(imp.where)) continue;
      if (!affected.has(imp.where)) affected.set(imp.where, { path: imp.where, imports: [], test: imp.test });
      affected.get(imp.where).imports.push(t.path);
    }
  }
  return {
    direct,
    affected: [...affected.values()],
    truncated: translate.length > MAX_DEPENDENCY_PROBES,
  };
}

// ------------------------------------------------------- the target shape ---

/**
 * THE TARGET STRUCTURE, CONSTRUCTED BEFORE ANYTHING IS WRITTEN INTO IT.
 *
 * This is the structural translation stage, and it is deliberately NOT a
 * translation of code. What crosses the boundary is the set of
 * RESPONSIBILITIES — `Scanner.initialize`, `Scanner.scan`, `Memory.open` —
 * because those are what the software does, and they are the same in every
 * language. What does not cross is the syntax that expressed them.
 *
 * A model handed this has an architecture before it has a file, which is the
 * difference between porting a program and improvising one that resembles it.
 */
function targetStructure(translate, source, target) {
  return translate.map((t) => ({
    from: t.path,
    to: t.target,
    language: { from: source ? source.label : t.structure.language, to: target ? target.label : '' },
    responsibilities: structure.responsibilities(t.structure),
    units: t.structure.units,
    derivable: Boolean(t.target),
  }));
}

// -------------------------------------------------------- the whole build ---

/**
 * Turn a draft (from migrationintent.parse, plus whatever MCQ settled) into a
 * contract, or report what still has to be asked.
 */
function build(root, draft, { intent = '' } = {}) {
  const detected = tech.detect(root);
  const source = draft.sourceName
    ? tech.resolve(draft.sourceName)
    : (detected.find((d) => d.kind === tech.TECH_KIND.LANGUAGE || d.kind === tech.TECH_KIND.FRAMEWORK) || null);
  const target = draft.targetName ? tech.resolve(draft.targetName) : null;

  const { scope, candidates } = resolveScope(root, draft, source);
  const contract = M.create({
    intent: intent || draft.text,
    source,
    target,
    scope,
    root,
  });
  contract.answers = draft.answers || {};
  contract.candidates = candidates.map((c) => ({ name: c.name, noun: c.noun, files: c.files.length, paths: c.paths }));
  contract.detected = detected.map((d) => ({ id: d.id, label: d.label, kind: d.kind, files: d.files }));

  if (!scope.resolved) return { contract, scope, candidates, resolved: false, classified: null };

  const classified = classify(root, scope, source, target, draft);
  const shape = targetStructure(classified.translate, source, target);
  const deps = dependencies(root, classified.translate);

  // ---- OPERATIONS -------------------------------------------------------
  const coexist = Boolean(draft.coexist);
  const fate = draft.dispositionHint === 'ARCHIVE' ? M.OP.ARCHIVE : M.OP.REPLACE;
  const ops = [];
  if (draft.operation === 'MERGE' || draft.operation === 'CONSOLIDATE') {
    // A MERGE'S SOURCES ARE THE COMPONENTS IN SCOPE, not the scope's own
    // paths. "Merge these three agents into one" resolves to a PROJECT scope —
    // it really does concern all of them — and reading the sources off
    // `scope.components` then yields nothing, which is a merge that has
    // silently lost every one of its inputs.
    const merging = componentsIn(scope, candidates);
    ops.push({
      type: draft.operation === 'MERGE' ? M.OP.MERGE : M.OP.CONSOLIDATE,
      sources: merging.map((c) => c.name),
      target: draft.targetName || 'the consolidated component',
      scope: scope.label,
      why: 'responsibilities are carried across; the sources stop being active',
      structure: { responsibilities: mergedResponsibilities(merging) },
    });
  } else if (draft.operation === 'SPLIT' || draft.operation === 'EXTRACT') {
    // ---- ONE THING BECOMES SEVERAL, AND NOTHING LOCAL KNOWS HOW MANY -----
    //
    // "Split this agent into three" and "extract the parser out of the loader"
    // name a source and a shape, never a set of target paths — those are the
    // decision the model is being asked to make. So the contract records what
    // it CAN know and refuses to invent the rest: the source, every
    // responsibility that has to survive somewhere, and the requirement that
    // the source stops being active afterwards.
    //
    // The responsibilities are then verified against ANY file in scope rather
    // than against named targets (see migrationcheck), which is the honest
    // check for a division whose parts are not named yet: it catches a
    // responsibility that was DROPPED, and stays quiet about where each one
    // ended up, because nobody said where they should.
    const splitting = componentsIn(scope, candidates);
    const responsibilities = splitting.length
      ? mergedResponsibilities(splitting)
      : [{ from: scope.label, responsibilities: shape.flatMap((s) => s.responsibilities), files: shape.map((s) => s.from) }];
    ops.push({
      type: draft.operation === 'SPLIT' ? M.OP.SPLIT : M.OP.EXTRACT,
      sources: splitting.length ? splitting.map((c) => c.name) : classified.translate.map((t) => t.path),
      target: draft.targetName || '(the parts are yours to name)',
      scope: scope.label,
      why: 'every responsibility must survive in one of the parts; the original stops being active',
      structure: { responsibilities, distributed: true },
    });
  } else {
    for (const s of shape) {
      ops.push({
        type: M.OP.REPLACE,
        source: s.from,
        target: s.to || `(target path not derivable — ${target ? target.label : 'the target'} has no file convention this can infer)`,
        scope: scope.label,
        why: s.derivable ? '' : 'the target technology has no extension of its own; name the file deliberately',
        structure: { responsibilities: s.responsibilities, units: s.units },
      });
    }
  }
  for (const k of classified.keep) ops.push({ type: M.OP.KEEP, source: k.path, scope: 'outside scope', why: k.why });

  contract.operations = ops.map((o) => o);
  contract.resources = [
    ...classified.preserve.map((p) => ({ path: p.path, disposition: M.DISPOSITION.PRESERVE, why: p.why, hash: p.hash })),
    ...classified.adapt.map((a) => ({ path: a.path, disposition: M.DISPOSITION.ADAPT, why: a.why })),
    ...classified.translate.map((t) => ({ path: t.path, disposition: coexist ? M.DISPOSITION.PRESERVE : M.DISPOSITION.ARCHIVE, why: coexist ? 'kept active alongside the target, by request' : 'archived once the target is verified', target: '' })),
  ];
  contract.dependencies = deps;
  contract.verification = verification(contract, classified, shape, deps, { coexist });
  contract.shape = shape;
  return { contract: rebuild(contract), scope, candidates, resolved: true, classified, shape };
}

/** `M.create` normalises; this keeps the extra analysis fields alongside it. */
function rebuild(contract) {
  const c = M.create(contract);
  c.at = contract.at;
  c.answers = contract.answers;
  c.candidates = contract.candidates;
  c.detected = contract.detected;
  c.shape = contract.shape;
  c.resources = contract.resources.map((r) => ({ ...r }));
  return c;
}

/** The components a scope actually covers. A project scope covers them all. */
function componentsIn(scope, candidates) {
  if (!scope || scope.kind === M.SCOPE_KIND.PROJECT) return candidates;
  if (scope.components && scope.components.length) {
    return candidates.filter((c) => scope.components.includes(c.name));
  }
  return candidates.filter((c) => (c.paths || []).some((p) => inScope(scope, p)));
}

/** For a merge: what each source component is responsible for, kept by name. */
function mergedResponsibilities(merging) {
  const out = [];
  for (const c of merging) {
    const resp = [];
    for (const f of c.files.slice(0, 20)) {
      const s = structure.extractFile(f.abs, f.rel);
      resp.push(...structure.responsibilities(s));
    }
    out.push({ from: c.name, responsibilities: [...new Set(resp)].slice(0, 40), files: c.files.map((f) => f.rel) });
  }
  return out;
}

/**
 * THE TWO LISTS, AND THE SECOND ONE IS THE POINT.
 *
 * `required` is what every coding agent already checks: the new thing is
 * there and it works. `negative` is what none of them check, because nothing
 * breaks when it fails — the old file is still on disk, something still
 * imports it, the old runtime path is still reachable. A migration that
 * satisfies only the first list is the exact failure this whole subsystem was
 * built to make impossible to report as success.
 */
function verification(contract, classified, shape, deps, { coexist = false } = {}) {
  const required = [];
  const negative = [];

  for (const s of shape) {
    if (s.to) required.push({ kind: 'file_exists', value: s.to, why: 'the target implementation' });
    for (const r of s.responsibilities.slice(0, 12)) {
      required.push({ kind: 'responsibility', value: r, why: `carried over from ${s.from}` });
    }
  }
  for (const p of classified.preserve) {
    required.push({ kind: 'unchanged', value: p.path, hash: p.hash, why: 'preserved resource — must survive byte-for-byte' });
  }
  for (const k of classified.keep) {
    required.push({ kind: 'file_exists', value: k.path, why: 'outside the scope — must NOT have been migrated' });
  }

  // ---- WHICH NEGATIVE CHECKS APPLY DEPENDS ON WHETHER THE TECHNOLOGY MOVES
  //
  // "No C++ file remains in scope" is exactly right for C++ -> Python and
  // NONSENSE for a JavaScript merge: the merged agent is JavaScript too, so the
  // check would refuse the very thing it was asked to produce. Same for
  // `symbol_gone` — `renderPage` surviving is a FAILURE when it was migrated to
  // another language and the POINT when three agents were merged into one.
  //
  // Both are therefore gated on a real change of technology, and both sides
  // must be a technology this program actually recognises. "Merge into
  // agent-d" has a target that is a name, not a stack.
  const s = contract.source;
  const t = contract.target;
  const crossTech = Boolean(s && t && s.known && t.known && s.id !== t.id);

  if (!coexist) {
    for (const x of classified.translate) {
      negative.push({ kind: 'file_inactive', value: x.path, why: 'the source implementation must not remain in the tree' });
      negative.push({ kind: 'no_importers', value: x.path, why: 'nothing may still import the old module' });
      if (!crossTech) continue;
      for (const u of (x.structure.units || []).filter((y) => !y.container).slice(0, 6)) {
        negative.push({ kind: 'symbol_gone', value: u.name, why: `defined by ${x.path}; a surviving definition is a second implementation` });
      }
    }
    if (crossTech && contract.scope) {
      negative.push({
        kind: 'no_source_tech_in_scope',
        value: s.id,
        why: `no ${s.label} file may remain inside ${contract.scope.label || 'the scope'}`,
      });
    }
  }
  for (const a of deps.affected) {
    negative.push({ kind: 'caller_updated', value: a.path, why: `imports ${a.imports.join(', ')} — must point at the target instead` });
  }
  return { required, negative };
}

module.exports = {
  build, components, componentsIn, resolveScope, inScope, classify, dependencies, targetStructure,
  verification, files, ownedBy, mentions, sha, NEVER, TEST_RE, MAX_SCOPE_FILES,
};
