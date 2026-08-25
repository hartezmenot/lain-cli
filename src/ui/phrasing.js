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
function phrase(name, target, running = false) {
  const t = String(target || '');
  // A search's subject is its PATTERN, and `describeTarget` hands it over
  // wrapped in slashes. `✓ grep /./` is the tool's spelling of the question;
  // `✓ Searched for "."` is the question. Unwrapped and quoted here because
  // this is the layer whose job is to say things the way a person would.
  const pat = /^\/(.*)\/$/.test(t) ? t.slice(1, -1) : t;
  const say = {
    read_file: [`Reading ${t}`, `Read ${t}`],
    write_file: [`Writing ${t}`, `Wrote ${t}`],
    edit_file: [`Editing ${t}`, `Edited ${t}`],
    list_dir: [`Listing ${t || 'the project'}`, `Listed ${t || 'the project'}`],
    grep: [`Searching for "${pat}"`, `Searched for "${pat}"`],
    glob: [`Looking for ${pat}`, `Found files matching ${pat}`],
    run_bash: [`Running ${t}`, `Ran ${t}`],
    run_powershell: [`Running ${t}`, `Ran ${t}`],
    run_cmd: [`Running ${t}`, `Ran ${t}`],
    web_fetch: [`Reading ${t}`, `Read ${t}`],
    web_search: [`Searching the web for ${t}`, `Searched the web for ${t}`],
    plan_write: ['Planning', 'Wrote the plan'],
    plan_step_done: ['Finishing a step', 'Finished a step'],
    ask_user: ['Waiting for you', 'Asked you'],
    // THE SURGICAL EDITS, NAMED FOR WHAT THEY DID. `Wrote src/routes.js`
    // reads the same whether eight lines were added or the file was replaced
    // wholesale, and those are very different things to have done — so each
    // says its own verb, and the reader can see the work was small.
    apply_patch: [`Patching ${t}`, `Patched ${t}`],
    append_file: [`Appending to ${t}`, `Appended to ${t}`],
    insert_at: [`Inserting into ${t}`, `Inserted into ${t}`],
    delete_range: [`Deleting lines in ${t}`, `Deleted lines in ${t}`],
    move_file: [`Moving ${t}`, `Moved ${t}`],
    delete_file: [`Deleting ${t}`, `Deleted ${t}`],
    file_info: [`Checking ${t}`, `Checked ${t}`],
    dependents: [`Finding what imports ${t}`, `Found what imports ${t}`],
    // THE BRIDGE, NAMED AS THE BRIDGE. `probe input.mouse.click` reads as a
    // command nobody typed; "Probe: input.mouse.click" reads as what it is —
    // an action carried out by something other than LAIN.
    probe: [`Probe: ${t}`, `Probe: ${t}`],
    desktop: [`Desktop: ${t}`, `Desktop: ${t}`],
    symbols: [`Finding ${t}`, `Found ${t}`],
  }[name];
  if (!say) return running ? `${name} ${t}`.trim() : `${name} ${t}`.trim();
  return running ? say[0] + '…' : say[1];
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
  probe: 'Probe', desktop: 'Desktop',
  grep: 'Searched', glob: 'Searched', symbols: 'Searched', dependents: 'Searched',
  write_file: 'Wrote', edit_file: 'Edited', apply_patch: 'Patched',
  append_file: 'Appended', insert_at: 'Inserted', delete_range: 'Deleted',
  move_file: 'Moved', delete_file: 'Deleted',
  run_bash: 'Ran', run_powershell: 'Ran', run_cmd: 'Ran',
  plan_write: 'Planned', plan_step_done: 'Planned',
  // A LOOKUP IS A READ, and saying so keeps it in the same column as every
  // other read — but `Looked up` is what distinguishes a page somebody else
  // published from a file in this project, which is a distinction worth one
  // word on screen.
  web_fetch: 'Looked up', web_search: 'Searched the web',
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
});

/** What to draw instead of a user block, or null when a person really did type it. */
function selfAskedCaption(from) {
  if (!from) return null;
  return SELF_ASKED[from] || `carrying on (${from})`;
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
  SELF_ASKED, selfAskedCaption, routeOf, MARK, phrase, verbOf, VERB_OF, trimRestatement };
