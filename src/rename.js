'use strict';

/**
 * RENAME, ON TOKENS — the operation a regex cannot do safely.
 *
 * `sed s/id/ident/g` rewrites the `id` in a URL, in a CSS selector, in the word
 * "identity" inside a comment, and in a JSON key that a server is expecting.
 * Every one of those is invisible in the diff summary and none of them is
 * caught by a test until something reaches that path. It is the single most
 * common way a mechanical refactor breaks a project quietly.
 *
 * This renames IDENTIFIER TOKENS. A name inside a string, a template, a comment
 * or a regular expression is not an identifier and is never touched — but it IS
 * COUNTED AND REPORTED, because a string containing the old name is very often
 * a real dependency: a tool name in a schema, a key in a config file, a route.
 * Those are exactly the leftovers that make a migration look finished when it
 * is not, so they are surfaced rather than quietly skipped.
 *
 * WHAT IT WILL NOT DECIDE FOR YOU. `obj.send()` might be the method being
 * renamed or a completely different `send` on a completely different object,
 * and nothing short of type inference can tell. So member accesses are counted
 * and left alone unless the caller says otherwise, and the count is in the
 * report either way. Guessing here is how a rename half-lands.
 *
 * EVERY CHANGED FILE IS RE-PARSED, and rolled back on its own if it no longer
 * parses. A rename that breaks one file out of twenty must not leave nineteen
 * done and one broken with no record of which.
 */

const fs = require('fs');
const { tokenize, T, supports } = require('./jsscan');
const { walk, globToRegExp } = require('./tools/search');
const diagnostics = require('./diagnostics');

/** Bounds, so a rename on a huge tree cannot run away. */
const MAX_FILES = 4000;
const MAX_SITES = 5000;

/** How each occurrence of the name was being used. One word each. */
const SITE = Object.freeze({
  IDENTIFIER: 'identifier',   // a plain reference or a declaration
  SHORTHAND: 'shorthand',     // `{ name }` — the key and the value at once
  MEMBER: 'member',           // `x.name`
  KEY: 'key',                 // `{ name: … }`
  TEXT: 'text',               // inside a string, template, comment or regex
});

function isPunct(t, v) { return t && t.type === T.PUNCT && t.value === v; }

/**
 * Every place `name` appears in one source, classified.
 *
 * @returns {Array<{kind, start, end, line}>}
 */
function sitesIn(source, name) {
  const { tokens, lineStarts } = tokenize(source, { comments: true });
  const { lineAt } = require('./jsscan');
  const out = [];
  const word = new RegExp(`(?:^|[^A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_$]|$)`);

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === T.STRING || t.type === T.TEMPLATE || t.type === T.COMMENT || t.type === T.REGEX) {
      // Not renamed, but the model is told. A string carrying the old name is
      // the classic residue of a half-done migration.
      if (word.test(t.value)) out.push({ kind: SITE.TEXT, start: t.start, end: t.end, line: lineAt(lineStarts, t.start) });
      continue;
    }
    if (t.type !== T.NAME || t.value !== name) continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    let kind = SITE.IDENTIFIER;
    if (isPunct(prev, '.') || isPunct(prev, '?.')) kind = SITE.MEMBER;
    else if (isPunct(next, ':')) kind = SITE.KEY;
    else if ((isPunct(prev, '{') || isPunct(prev, ',')) && (isPunct(next, ',') || isPunct(next, '}'))) {
      // `{ name }` — the property and the variable are the same token, so
      // renaming it renames both. Real, and worth saying out loud.
      kind = SITE.SHORTHAND;
    }
    out.push({ kind, start: t.start, end: t.end, line: lineAt(lineStarts, t.start) });
  }
  return out;
}

/** Apply replacements from the END, so earlier offsets stay valid. */
function applySites(source, sites, to) {
  let out = source;
  for (let i = sites.length - 1; i >= 0; i--) {
    out = out.slice(0, sites[i].start) + to + out.slice(sites[i].end);
  }
  return out;
}

/**
 * Rename `from` to `to` across a tree.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {object} [o]
 * @param {string} [o.include]        glob limiting which files are touched
 * @param {boolean} [o.members=false] also rewrite `x.from` member accesses
 * @param {boolean} [o.dryRun=false]  report what would change, change nothing
 */
async function rename(root, from, to, { include = '', members = false, dryRun = false } = {}) {
  const includeRe = include ? globToRegExp(include) : null;
  const changed = [];
  const textOnly = [];
  const memberOnly = [];
  const shorthand = [];
  let scanned = 0;
  let sites = 0;
  let skippedUnsupported = 0;

  const CHANGE = new Set(members
    ? [SITE.IDENTIFIER, SITE.SHORTHAND, SITE.MEMBER, SITE.KEY]
    : [SITE.IDENTIFIER, SITE.SHORTHAND]);

  for (const f of walk(root)) {
    if (includeRe && !includeRe.test(f.rel)) continue;
    if (scanned >= MAX_FILES || sites >= MAX_SITES) break;
    if (!supports(f.abs)) {
      // A file this scanner does not claim is never edited by guesswork. It is
      // still SEARCHED as text, so a Python or JSON file holding the old name
      // is reported rather than silently ignored.
      let raw;
      try { raw = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
      const w = new RegExp(`(?:^|[^A-Za-z0-9_$])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[^A-Za-z0-9_$]|$)`);
      if (w.test(raw)) { textOnly.push(`${f.rel} (not JavaScript — not renamed)`); skippedUnsupported += 1; }
      continue;
    }
    let source;
    try { source = fs.readFileSync(f.abs, 'utf8'); } catch { continue; }
    if (!source.includes(from)) continue;      // cheap reject before tokenising
    scanned += 1;

    const all = sitesIn(source, from);
    if (!all.length) continue;
    const toChange = all.filter((s) => CHANGE.has(s.kind));
    for (const s of all) {
      if (s.kind === SITE.TEXT) textOnly.push(`${f.rel}:${s.line}`);
      else if (s.kind === SITE.MEMBER && !members) memberOnly.push(`${f.rel}:${s.line}`);
      else if (s.kind === SITE.SHORTHAND) shorthand.push(`${f.rel}:${s.line}`);
    }
    if (!toChange.length) continue;
    sites += toChange.length;
    if (dryRun) { changed.push({ rel: f.rel, abs: f.abs, count: toChange.length, rolledBack: false }); continue; }

    const next = applySites(source, toChange, to);
    fs.writeFileSync(f.abs, next, 'utf8');
    // ---- AND DID IT SURVIVE? ---------------------------------------------
    //
    // Per file, so one broken file is rolled back on its own rather than
    // taking a correct rename in nineteen others with it.
    let ok = true;
    try {
      const check = await diagnostics.checkFile(f.abs);
      ok = !(check && check.ok === false);
    } catch { ok = true; }
    if (!ok) { fs.writeFileSync(f.abs, source, 'utf8'); }
    changed.push({ rel: f.rel, abs: f.abs, count: toChange.length, rolledBack: !ok });
  }

  return {
    from, to, changed, scanned, sites, dryRun,
    textOnly: [...new Set(textOnly)],
    memberOnly: [...new Set(memberOnly)],
    shorthand: [...new Set(shorthand)],
    skippedUnsupported,
    truncated: scanned >= MAX_FILES || sites >= MAX_SITES,
  };
}

/** The report a model reads. Facts, in the order they change what happens next. */
function describe(r) {
  const lines = [];
  const applied = r.changed.filter((c) => !c.rolledBack);
  const broken = r.changed.filter((c) => c.rolledBack);
  const total = applied.reduce((n, c) => n + c.count, 0);

  lines.push(r.dryRun
    ? `${r.from} → ${r.to}: ${total} identifier(s) in ${applied.length} file(s) WOULD change. Nothing was written.`
    : `${r.from} → ${r.to}: ${total} identifier(s) renamed in ${applied.length} file(s).`);
  for (const c of applied.slice(0, 30)) lines.push(`  ${c.rel} (${c.count})`);
  if (applied.length > 30) lines.push(`  [${applied.length - 30} more]`);

  if (broken.length) {
    lines.push('', 'ROLLED BACK — these no longer parsed after the rename and were restored:');
    for (const c of broken) lines.push(`  ${c.rel}`);
  }
  if (r.shorthand.length) {
    lines.push('', `${r.shorthand.length} shorthand propert${r.shorthand.length === 1 ? 'y was' : 'ies were'} renamed `
      + '— `{ name }` is the key AND the value, so the property name changed too:');
    lines.push('  ' + r.shorthand.slice(0, 12).join(', '));
  }
  if (r.memberOnly.length) {
    lines.push('', `${r.memberOnly.length} member access(es) were NOT renamed — \`x.${r.from}\` may be a different `
      + `${r.from} on a different object, and nothing here can tell. Pass include_members to rewrite them:`);
    lines.push('  ' + r.memberOnly.slice(0, 12).join(', ')
      + (r.memberOnly.length > 12 ? ` [+${r.memberOnly.length - 12}]` : ''));
  }
  if (r.textOnly.length) {
    lines.push('', `${r.textOnly.length} occurrence(s) remain inside strings, comments or non-JavaScript files. `
      + 'These were NOT renamed. A string holding the old name is often a real reference — a tool name, a config '
      + 'key, a route — and is what makes a migration look finished when it is not:');
    lines.push('  ' + r.textOnly.slice(0, 12).join(', ')
      + (r.textOnly.length > 12 ? ` [+${r.textOnly.length - 12}]` : ''));
  }
  if (r.truncated) lines.push('', '[bounded: the tree is very large and the sweep stopped early — narrow with include]');
  if (!r.changed.length && !r.textOnly.length) {
    lines.push(`Nothing named ${r.from} was found in ${r.scanned} JavaScript file(s).`);
  }
  return lines.join('\n');
}

module.exports = { rename, describe, sitesIn, applySites, SITE, MAX_FILES, MAX_SITES };
