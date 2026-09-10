'use strict';

/**
 * HOW A TOOL CALL IS SAID — the vocabulary layer, and nothing else.
 *
 * Split out of views.js when that file reached the architecture guard. The seam
 * is real rather than convenient: everything else in views.js LAYS OUT a region
 * of the screen, and this decides the WORDS — the mark that starts a row, the
 * sentence a call becomes, and the single verb a run of calls is counted under.
 * They change for different reasons: a new tool adds a line here and touches
 * nothing there; a new pane does the reverse.
 *
 * views.js re-exports all three, so every existing caller — feed.js,
 * troubleshoot.js, the panes — is unaffected by the move.
 */

/** The glyph that starts a row: outcome first, before any word. */
const MARK = { done: '✓', active: '●', todo: '○', dropped: '✗', error: '✗' };

/**
 * A tool call, said the way a person would say it.
 *
 * The activity feed used to read `✓ read  src/x.js  11ms` — a column of verbs,
 * subjects and timings, which is a table of internal events rather than an
 * account of what happened. Durations and token counts are diagnostics; they
 * belong to `/status`, not to the thing you watch while LAIN works.
 */
/**
 * THE SUBJECT OF A SHELL COMMAND is the command, and its VERB is the program.
 *
 * `Ran python -c "import ast"` spends its first word on a fact every row on the
 * screen shares — that something ran — and buries the only interesting one. The
 * program IS the verb: `python`, `sed`, `git`, `node`. So the first token becomes
 * the verb and the rest becomes the subject.
 *
 * MECHANICAL, NOT SUMMARISED. `python · -m py_compile a.py` rather than
 * `python · compile a.py`: inventing a précis of somebody else's command means
 * deciding which flags did not matter, and a row that quietly drops `--force` is
 * a row that lies about what happened. The full command is still there, clipped
 * by the width like everything else.
 *
 * A BARE PROGRAM has no subject and says so by having none.
 */
/**
 * WHAT SEPARATES A TOOL ROW'S VERB FROM ITS SUBJECT.
 *
 * Named rather than typed twice: ui/feed.js `paintMark` splits on it to paint the
 * two halves differently, and a literal in both places is a literal that can
 * drift into a row nobody can colour.
 */
const SUBJECT_SEP = '·';

function shellParts(command) {
  const c = String(command || '').trim().replace(/\s+/g, ' ');
  if (!c) return { verb: 'shell', subject: '' };
  const cut = c.indexOf(' ');
  const head = cut < 0 ? c : c.slice(0, cut);
  const rest = cut < 0 ? '' : c.slice(cut + 1);
  // THE PROGRAM, NOT THE PATH TO IT. `C:\\Python311\\python.exe` is `python`.
  const prog = head.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|sh)$/i, '') || head;
  return { verb: prog, subject: rest };
}

/**
 * A TOOL CALL, AS `verb · subject`.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACED. Every row was a little sentence — `Ran python -c "import
 * ast"`, `Searched for "SessionStrategist"`, `Found files matching *.ts` — and
 * read together, twenty of them are prose competing with the prose they are
 * evidence for. A tool row is not a sentence; it is a fact with two parts.
 *
 *     Ran python -m py_compile a.py      ->    python · -m py_compile a.py
 *     Read src/router.js                 ->    read · src/router.js
 *     Searched for "dispatch"            ->    search · dispatch
 *
 * The verb is lower case and dim, the subject wears the accent every path in
 * LAIN wears, and the mark before them carries the outcome. Three weights on a
 * row that used to have one.
 *
 * THE RUNNING FORM IS THE SAME SHAPE. It used to be a different sentence in a
 * different tense (`Reading x` / `Read x`), so a row visibly rewrote itself at
 * the moment the call finished. Now only the MARK changes, which is the one thing
 * that actually changed.
 */
function phrase(name, target, running = false) {
  const t = String(target || '');
  // A search's subject is its PATTERN, and `describeTarget` hands it over
  // wrapped in slashes — the tool's own spelling of the question.
  const pat = /^\/(.*)\/$/.test(t) ? t.slice(1, -1) : t;
  const two = (verb, subject) => (subject ? `${verb} ${SUBJECT_SEP} ${subject}` : verb);
  if (/^run_(bash|powershell|cmd)$/.test(name)) {
    const { verb, subject } = shellParts(t);
    return two(verb, subject);
  }
  const say = {
    read_file: () => two('read', t),
    write_file: () => two('wrote', t),
    edit_file: () => two('edited', t),
    list_dir: () => two('list', t || 'the project'),
    grep: () => two('search', pat),
    glob: () => two('find', pat),
    web_fetch: () => two('fetch', t),
    plan_write: () => 'plan',
    plan_step_done: () => 'plan · step done',
    ask_user: () => 'asked you',
    run_tests: () => two('test', t),
    discover_tests: () => two('test', t || 'discover'),
    verify_task: () => two('verify', t),
    service_start: () => two('service', t),
    service_check: () => two('service', t),
    observe: () => two('observe', t),
    // THE SURGICAL EDITS KEEP THEIR OWN VERBS. `wrote src/routes.js` reads the
    // same whether eight lines were added or the file was replaced wholesale, and
    // those are very different things to have done.
    apply_patch: () => two('patched', t),
    append_file: () => two('appended', t),
    insert_at: () => two('inserted', t),
    delete_range: () => two('deleted lines', t),
    move_file: () => two('moved', t),
    delete_file: () => two('deleted', t),
    file_info: () => two('stat', t),
    dependents: () => two('imports of', t),
    symbols: () => two('symbol', t),
    // THE BRIDGE, NAMED AS THE BRIDGE — an action carried out by something other
    // than LAIN, which is worth a word of its own.
    computer: () => two('computer', t),
  }[name];
  if (!say) return two(String(name || '').replace(/_/g, ' '), t);
  return say();
}

/**
 * The one-word verb a call is COUNTED under when a run of them is compacted.
 *
 * Separate from `phrase` on purpose: that says what happened to a particular
 * file, and this says what KIND of thing happened, so seven of them can be one
 * row. Anything unrecognised counts as itself rather than being folded into a
 * bucket named "other" — an honest `file_info ×3` beats a tidy lie.
 */
const VERB_OF = {
  read_file: 'Read', list_dir: 'Read', file_info: 'Read',
  computer: 'Computer',
  grep: 'Searched', glob: 'Searched', symbols: 'Searched', dependents: 'Searched',
  write_file: 'Wrote', edit_file: 'Edited', apply_patch: 'Patched',
  append_file: 'Appended', insert_at: 'Inserted', delete_range: 'Deleted',
  move_file: 'Moved', delete_file: 'Deleted',
  run_bash: 'Ran', run_powershell: 'Ran', run_cmd: 'Ran',
  plan_write: 'Planned', plan_step_done: 'Planned',
  // A LOOKUP IS A READ, and saying so keeps it in the same column as every
  // other read — but `Looked up` is what distinguishes a page somebody else
  // published from a file in this project, which is a distinction worth one
  // word on screen. (A `web_search` row lived here too, until the browser it
  // drove was removed in 2026-09; a retired name falls back to itself, which
  // is the honest spelling for a name that no longer names anything.)
  web_fetch: 'Looked up',
};
function verbOf(name) { return VERB_OF[name] || String(name || 'Ran'); }

/**
 * THE RESTATEMENT AT THE TOP OF AN ANSWER — dropped, because it is not one.
 *
 * A model asked to do something often opens by saying what it was asked:
 *
 *     The user wants a reply containing exactly "PROVIDER OK". PROVIDER OK
 *
 * The first clause carries nothing. The person reading it wrote the request a
 * second ago and is looking at it on the same screen, so it is the request
 * echoed back at the cost of the answer's first line.
 *
 * WHY THIS IS NOT PURELY A PROMPT PROBLEM. The system prompt says not to, in
 * its opening paragraph. Measured against a live model, the model did it
 * anyway — small fast models follow style instructions unreliably, and a UI
 * that only looks right with a cooperative model is not fixed. The prompt
 * asks; this makes it true.
 *
 * DELIBERATELY NARROW, because editing a model's words is a serious thing:
 *
 *   ONLY THE OPENING.    A restatement mid-paragraph is being used to make a
 *                        point, and is left alone.
 *   ONLY A CLOSED SET.   Four stock openers, not a guess at intent.
 *   ONLY WITH CONTENT AFTER IT. If the restatement is the whole message there
 *                        is nothing to promote in its place, and removing it
 *                        would leave a blank answer — worse than a redundant
 *                        one.
 *   ONLY UP TO A SENTENCE END. A clause that merely STARTS this way — "The
 *                        user wants X but the code does Y" — is untouched,
 *                        because that one is analysis.
 *
 * PRESENTATION ONLY. This shapes what is DRAWN. The model's text is unchanged
 * in the session, on the wire, and in what /copy copies.
 */
const RESTATEMENT = new RegExp(
  '^\\s*(?:so\\s+)?(?:'
  + 'the\\s+user\\s+(?:wants|is\\s+asking|asked|would\\s+like)'
  + '|what\\s+(?:you(?:\\u2019re|\u0027re| are)\\s+asking|the\\s+user\\s+wants)'
  + '|i\\s+understand\\s+(?:that\\s+)?you\\s+want'
  + '|as\\s+requested'
  + ')\\b[^.!?\\n]*[.!?](?=\\s|$)', 'i');

/** Drop a leading restatement of the request. See above for the limits. */
function trimRestatement(text) {
  const s = String(text == null ? '' : text);
  const m = RESTATEMENT.exec(s);
  if (!m) return s;
  const rest = s.slice(m[0].length);
  // Nothing left to say means the restatement WAS the answer. Keep it.
  if (!rest.trim()) return s;
  return rest.replace(/^[ \t]+/, '');
}

/**
 * WHAT A TURN LAIN ASKED ITSELF FOR IS CALLED.
 *
 * `app.submit(..., { from })` is how LAIN continues its own work — the turn an
 * external consultation hands back, a rate-limit resume. Those turns are real
 * turns with real input, and the input is framing NOBODY TYPED, so drawing them
 * as `USER REQUEST` claims a person said something they did not.
 *
 * Here rather than in either feed because BOTH feeds draw them — the terminal
 * conversation and the dashboard — and two copies of this sentence is two
 * places for the story to drift. Words live in this file; layout does not.
 */
const SELF_ASKED = Object.freeze({
  'external-advice': 'continuing the investigation with the external advice',
  'rate-limit-resume': 'continuing after the rate limit reset',
  // EVERY KEY ANY CALLER ACTUALLY USES. Two were missing, so their captions
  // fell through to the generic fallback and named an internal identifier at
  // the user - `carrying on (provider-failover)`. A test now walks the tree and
  // requires every `from:` a submission uses to be here.
  'provider-failover': 'continuing on another provider',
  handover: 'continuing from what LAIN observed',
  steer: 'continuing with what you added',
});

/**
 * What to draw instead of a user block, or null when a person really did type it.
 *
 * ------------------------------------------------------------------------
 * AN UNKNOWN `from` MEANS A PERSON, NOT AN IDENTIFIER.
 *
 * It used to fall through to `carrying on (${from})`, which printed an internal
 * key at the user — `carrying on (provider-failover)` — and, worse, SWALLOWED THE
 * TEXT. That is the right trade for a continuation LAIN composed for itself: the
 * prompt is control, not speech, and the caption says why there is a gap.
 *
 * It is the wrong trade for anything that might be a real message. A message
 * relayed from a phone carries `from: 'messaging'`; captioning it would replace
 * what somebody actually said with the name of the transport it arrived on.
 *
 * So the table is a CLOSED LIST of runtime continuations, and anything not on it
 * is drawn as what it is — the user's own words. A new transport is then visible
 * by default and a new synthetic prompt has to be declared here to be hidden,
 * which is the safer direction for both to fail in.
 */
function selfAskedCaption(from) {
  if (!from) return null;
  return SELF_ASKED[from] || null;
}

/**
 * WHICH MODEL, THROUGH WHICH ROUTE — and the routing was hiding in plain sight.
 *
 * ------------------------------------------------------------------------
 * THE DEFECT. The header drew the model id verbatim beside the connection
 * name, so a session through a gateway read:
 *
 *     cc/claude-sonnet-5      omniroute      effort auto
 *
 * Two things are wrong with that. `omniroute` is the name the USER gave their
 * connection — it says nothing about where the request actually goes. And the
 * thing that DOES say so, the `cc/` prefix, was rendered as though it were part
 * of the model's name, where it reads as noise rather than as routing.
 *
 * A gateway serves many downstream providers and the prefix is which one: the
 * same connection carries `cc/claude-sonnet-5`, `ag/claude-sonnet-4-6` and
 * `openrouter/z-ai/glm-5.2:free`, and those are three different places. Asking
 * "which provider am I actually on" is exactly the question a header exists to
 * answer without being asked.
 *
 * So the prefix is lifted out of the name and shown as what it is:
 *
 *     claude-sonnet-5         omniroute/cc   effort auto
 *
 * ------------------------------------------------------------------------
 * THE FIRST SEGMENT ONLY, because that is what a gateway prefix is. Model ids
 * legitimately contain slashes of their own — `openrouter/z-ai/glm-5.2:free` is
 * the `z-ai/glm-5.2:free` model behind the `openrouter` router — so splitting on
 * every slash would eat the vendor out of the model's own name.
 *
 * A model id with NO slash has no gateway prefix and is left exactly alone: a
 * direct route to `claude-opus-5` is not routed through anything, and inventing
 * a router for it would be the fake identity this exists to prevent.
 */
function routeOf(model, provider, connection) {
  const raw = String(model || '');
  const cut = raw.indexOf('/');
  const via = cut > 0 ? raw.slice(0, cut) : null;
  const name = cut > 0 ? raw.slice(cut + 1) : raw;

  // The connection name and the provider name are frequently the same word,
  // and printing it twice tells nobody anything.
  const base = [provider, connection].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i);
  const route = base.length ? base.join(' · ') : '';
  return {
    model: name || raw || null,
    // `omniroute/cc` — the connection you configured, and the downstream it
    // resolved to. Nothing is invented: both halves are read from real state.
    route: via ? (route ? route + '/' + via : via) : route,
    via,
  };
}

module.exports = {
  shellParts, SUBJECT_SEP,
  SELF_ASKED, selfAskedCaption, routeOf, MARK, phrase, verbOf, VERB_OF, trimRestatement };
