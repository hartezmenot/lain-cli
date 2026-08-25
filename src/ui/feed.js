'use strict';

/**
 * THE ACTIVITY FEED — telling what the MODEL said from what LAIN DID.
 *
 * Split from views.js because it is one concern with one rule: a sentence from
 * the model and a line recording a tool call are different kinds of fact and
 * must never look alike. views.js builds the entries; this renders them.
 *
 * The text helpers are required lazily from views.js — they are shared, and a
 * top-level import here would close a cycle.
 */

/** views.js holds the shared text helpers; required lazily to avoid a cycle. */
const V = () => require('./views');
const T = require('./text');

/**
 * Feed entries carry WHO they came from, so the renderer can group them.
 *
 * The feed used to be a flat list of strings, which is why a sentence from the
 * model and a line recording a tool call looked identical on screen:
 *
 *     Let's begin with Phase 1 — a full audit of the project…
 *     ✓ Ran sleep 4
 *     Now reading the settings owner.
 *     ✓ Listed .
 *
 * One stream, two completely different kinds of fact. `kind` is what lets them
 * be told apart without giving either one a box of its own.
 */
/** `   +12 -4`, or empty when this call changed nothing. */
function editCounts(a) {
  const added = Number(a && a.added) || 0;
  const removed = Number(a && a.removed) || 0;
  if (!added && !removed) return '';
  return `   +${added} -${removed}`;
}

function pushAction(out, a) {
  out.push({
    kind: 'action',
    // THE SIZE OF THE CHANGE STAYS WITH IT. The live card shows the counts
    // climbing and then takes them away with it; this row is what is left
    // behind, and a record of an edit that cannot say how big it was is half a
    // record. The numbers are the checkpoint's, so several edits in one turn
    // read as the account the brief asks for:
    //
    //     ✓ Edited python.js   +75 -40
    //     ✓ Edited python.py   +99 -32
    //     ✓ Edited config.js    +4 -1
    text: `${a.ok ? V().MARK.done : V().MARK.error} ${V().phrase(a.name, a.target)}${editCounts(a)}`,
    // Carried so a run of calls can be counted by what it DID rather than by
    // re-parsing the sentence that was just built out of it.
    verb: V().verbOf(a.name),
    failed: !a.ok,
    // WHICH FILE THIS ROW IS ABOUT, so a click can open it. Only the row
    // that names the call carries it — the note under it is about the same
    // file, but the thing a person aims at is the sentence.
    path: a.path || null,
  });
  // Errors always; otherwise only short results from calls that were not about
  // a file — a file call's output is the file itself, which belongs in the
  // model's context and not on the screen.
  if (a.note && (!a.ok || (a.brief && !a.file))) out.push({ kind: 'action', text: `    ${a.note}` });
  // A COMMAND'S OUTPUT LIVES IN OUTPUT, and Context says where to look rather
  // than either dumping forty lines of test log into the conversation or —
  // which is what it did — saying nothing at all, so the one place the result
  // actually was went undiscovered.
  else if (a.output && !a.brief) out.push({ kind: 'action', text: '    ▶ full output in OUTPUT (4)' });
}

/**
 * WHAT THE MODEL SAID — ONE ENTRY PER LINE, not one entry per message.
 *
 * A whole message went in as a single entry and came out through `wrap`, which
 * reflows on whitespace. A real model's final answer is not a paragraph: it is
 * headings, bullets, a table and fenced code, and reflowing it produced
 *
 *     ignores the error } } ``` If `pull()` throws (e.g. the sensor is
 *     offline, the network is down), the function catches the exception…
 *
 * — every structural newline gone, code and prose run together, a markdown
 * table reduced to pipes in a sentence. That was found by pointing a real model
 * at a real project and reading the screen; no scripted model produces an
 * answer shaped like that, which is why the rest of the suite could not see it.
 *
 * Splitting per line lets `wrap` do its job WITHIN a line — a long sentence
 * still folds to the pane — while a line the model chose to end stays ended. A
 * blank line is kept as a blank entry, because the gap between two paragraphs
 * is part of what the model wrote.
 */
function pushModel(out, text, { last = true } = {}) {
  // ---- THE PARAGRAPH BREAK THE STREAM ATE, PUT BACK --------------------
  //
  // SEEN ON SCREEN: paragraphs the model separated with a blank line drawn
  // butted straight together, so a page of reasoning arrived as one slab with
  // no way in.
  //
  // It is not lost in the drawing. `turnevents.flushParagraphs` SPLITS the
  // streamed text on `\n\n` and trims each chunk, so the blank line that made
  // the boundary is consumed by the split itself — and each paragraph arrives
  // here as a separate call with nothing between them. A recorded turn's
  // per-step narration arrives the same way.
  //
  // ONE BLANK ROW, because one blank line is what the model wrote. Restoring
  // more would be inventing emphasis it did not ask for; restoring none is the
  // defect. `pushLines` trims its own leading and trailing blanks, so the
  // separator has to be put between the calls rather than inside them.
  const prev = out[out.length - 1];
  if (prev && prev.kind === 'model' && String(prev.text || '').trim()) {
    out.push({ kind: 'model', text: '' });
  }
  // A LEADING RESTATEMENT OF THE REQUEST IS NOT AN ANSWER, and neither is a
  // line announcing the tool call drawn directly underneath it. See
  // ui/condense.js for why this is done here rather than left to the system
  // prompt, and for how narrow it deliberately is. The model's own text is
  // untouched in the session, on the wire and in /copy — only the drawing.
  const before = out.length;
  // `last` — is this the model's final word on its turn? It decides the one
  // case the filter cannot judge from the text alone: a message that is
  // ENTIRELY narration. See ui/condense.js `prose`.
  const condense = require('./condense');
  // ---- A WALL OF ANALYSIS IS FOLDED, NEVER DROPPED ----------------------
  //
  // The narration filter removes sentences the screen already says. It does
  // not touch a paragraph that is genuinely ANALYSIS — six true sentences of
  // reasoning between two tool calls — and that is the wall left on screen
  // once everything else is fixed. Folding keeps the actionable part here and
  // leaves the whole of it in DETAIL. See ui/condense.js `fold`.
  const shown = condense.fold(condense.prose(text, { last }), { last });
  pushLines(out, shown.text, 'model');
  // NOTHING SURVIVED THE FILTER — then the separator is a blank row introducing
  // nothing, and a feed that grows a gap per dropped line is its own defect.
  if (out.length === before && out[before - 1] && out[before - 1].kind === 'model'
      && !String(out[before - 1].text || '').trim()) {
    out.pop();
  } else if (shown.folded) {
    // WHERE THE REST OF IT WENT. Drawn directly under the part that stayed, so
    // the pointer belongs to the paragraph it came from rather than floating
    // loose at the end of the turn.
    out.push({ kind: 'more', text: '▶ full reasoning in DETAIL (8)' });
  }
}

/** One entry per line, blank lines preserved, leading/trailing blanks dropped. */
function pushLines(out, text, kind) {
  const all = String(text == null ? '' : text).replace(/\r\n/g, '\n').split('\n');
  while (all.length && !all[0].trim()) all.shift();
  while (all.length && !all[all.length - 1].trim()) all.pop();
  if (!all.length) return;
  for (const line of all) out.push({ kind, text: line.replace(/\s+$/, '') });
}

/**
 * WHAT THE USER SAID. The entry that was missing entirely.
 *
 * The feed rendered the model's prose and LAIN's tool calls and nothing else,
 * so a conversation showed one side of itself. The first message LOOKED present
 * only because the pinned banner carries the task objective — which is the
 * first message and never changes — and every message after it was invisible.
 * Nobody could see their own second sentence.
 */
function pushUser(out, text) {
  // THE USER'S LINE BREAKS ARE THE USER'S. This collapsed every run of
  // whitespace to a single space, so a message typed across several lines with
  // Ctrl+J — or pasted with its own structure — arrived in Context as one
  // unbroken run. The model's prose kept its lines (`pushLines`, above) and the
  // person's did not, and it is the person's half that reads worse for it: a
  // pasted stack trace or a numbered list became a paragraph.
  //
  // `pushLines` is exactly what the model's text gets, so both sides of the
  // conversation are laid out by one rule. The `❯` marker goes on the first row
  // and the rest indent to line up under it — see `paintRow`.
  // THE WHOLE MESSAGE TRAVELS WITH EVERY ROW OF IT. A three-line prompt is
  // three entries, and clicking the second line has to bring back the prompt —
  // not its middle line. See `userBlock` and ui/mouse.js.
  // A PASTE IS DRAWN AS A MARKER, NOT AS FOUR HUNDRED LINES. See ui/pasted.js:
  // one act of attaching something becomes `[pasted text #1]` on screen, while
  // the payload below still travels on every row as `source`, still goes to the
  // model, and is still what /copy copies. Only the DRAWING changes.
  const before = out.length;
  const source = String(text == null ? '' : text);
  pushLines(out, require('./pasted').compact(source), 'user');
  for (let i = before; i < out.length; i++) out[i].source = source;
}

/**
 * THE OTHER TWO ACTORS.
 *
 * `external` and `mcp` have had labels and colours in KIND from the day the
 * relay landed, and nothing ever produced one: the external reviewer's analysis
 * reached the screen through `render.write`, which lands in the transcript as
 * unlabelled dim text at the bottom of the feed. So the second model was
 * genuinely on screen and looked like leftover logging.
 *
 * These are the same shape as pushModel — the story is one list, in order, and
 * the only thing that varies is who is speaking.
 */
function pushExternal(out, text) {
  pushLines(out, text, 'external');
}

function pushMcp(out, text) {
  const t = String(text || '').trim();
  if (t) out.push({ kind: 'mcp', text: t });
}

/**
 * SOMETHING THE PROGRAM ITSELF SAID — a liveness warning, a block, a notice.
 *
 * These are not conversation and they are not tool calls. They used to reach
 * the screen through `render.write`, which in TUI mode lands in the captured
 * transcript and is printed BELOW the whole feed at full brightness — so a
 * three-line liveness warning was the loudest thing on the screen, sat
 * underneath the conversation it interrupted, and was the last thing a person
 * read instead of the first. As an entry it renders quietly, IN ITS PLACE, and
 * compacts like everything else.
 */
function pushNote(out, text, level = 'info') {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t) out.push({ kind: 'note', text: t, level });
}

/**
 * Render the tagged feed, grouping runs of the same kind under one label.
 *
 * MODEL is what the model said to the user; ACTIONS is what LAIN actually ran.
 * Labels appear once per run rather than once per line, so a five-call
 * investigation costs one label and five rows — the distinction is obvious and
 * the feed stays a narrative rather than becoming a table.
 *
 * Below `LABEL_MIN_WIDTH` the labels themselves are the decoration that goes:
 * indentation alone still separates the two, and on a 40-column terminal the
 * rows matter more than the headings.
 */
const LABEL_MIN_WIDTH = 52;

/**
 * WHO IS SPEAKING, and how loudly.
 *
 * The hierarchy is deliberate and is about READABILITY, not decoration: the
 * things a person came to read — what they said, and what the models answered —
 * are bright, and the machinery around them is quieter. Tool output was being
 * rendered at the same weight as the answer, and the answer at the same weight
 * as the scaffolding, which is why the model's text was the hardest thing on
 * the screen to find.
 */
/**
 * A LABEL IS FOR TELLING TWO SPEAKERS APART, and `label: ''` means this one
 * needs no telling.
 *
 * TWO OF THEM WERE PURE NOISE. `LAIN` sat above every answer in a program the
 * user launched by typing `lain` — naming the application to the person running
 * it, once per paragraph — and it dragged a four-space indent behind it, so the
 * one thing they came to read was the one thing pushed furthest from the
 * margin. `ACTIONS` announced a list of actions that already say what they are;
 * the quoted gutter beneath it is what makes a tool call structurally distinct,
 * and the word above it added a row without adding a distinction.
 *
 * The ones that remain all answer a question the reader actually has: WHO said
 * this, when it was not LAIN and not obvious — the user, a second model, a
 * bridge — or WHAT KIND of interruption this is, which is the whole of the
 * difference between a note and an error.
 */
const KIND = {
  user: { label: 'USER', paint: 'key', body: 'plain' },
  model: { label: '', paint: 'info', body: 'plain' },
  external: { label: 'EXTERNAL', paint: 'external', body: 'plain' },
  mcp: { label: 'MCP', paint: 'warn', body: 'plain' },
  action: { label: '', paint: 'meta', body: 'meta' },
  // A POINTER, NOT A SPEAKER. It says where the rest of a folded paragraph is;
  // it is the quietest thing on the screen and it never carries a label.
  more: { label: '', paint: 'meta', body: 'meta' },
  // NOT THE SAME GREY — see `kindOf`. A 429 drawn in the same neutral as
  // "compacting the conversation" is a failure hidden inside housekeeping.
  note: { label: 'NOTE', paint: 'meta', body: 'meta' },
};

/**
 * A NOTE AND AN ERROR ARE NOT THE SAME EVENT, and they were the same rows.
 *
 * `pushNote` has always carried a `level`, and nothing downstream read it: both
 * a compaction notice and a refused request drew as `NOTE` in the same dim
 * grey. So the single most important line a session can produce —
 *
 *     429 Too Many Requests — you have reached the request limit
 *
 * — was rendered in the colour reserved for housekeeping, indistinguishable at
 * a glance from LAIN tidying its own context. A person scanning the pane had no
 * way to see that the run had stopped.
 *
 * Three levels, three words, three colours. The severity is already known at
 * the point the note is made; this is only the first place that reads it.
 */
function kindOf(entry) {
  const k = KIND[entry.kind] || KIND.action;
  if (entry.kind !== 'note') return k;
  if (entry.level === 'error') return { label: 'ERROR', paint: 'bad', body: 'bad' };
  if (entry.level === 'warn') return { label: 'WARN', paint: 'warn', body: 'warn' };
  return k;
}

/**
 * WHAT THE USER SAID IS A BLOCK, NOT A LINE.
 *
 * Painted across the full width on its own ground, so the eye finds the thing
 * that started each exchange by SHAPE rather than by reading — the same reason
 * a diff gets its own surface. Rows a person can click to bring back are worth
 * looking clickable.
 *
 * `out.userAt` maps the index of a drawn line to the message it came from, so a
 * click in the feed can put that message back on the input line without
 * re-deriving anything from the painted text. See ui/mouse.js.
 */
function userBlock(out, text, rows, width, P) {
  const w = Math.max(8, width);
  let first = true;
  for (const row of rows) {
    const body = (first ? '❯ ' : '  ') + row;
    out.userAt[out.length] = text;
    out.push(P.surface(T.pad('  ' + body, w)));
    first = false;
  }
}

function renderFeed(entries, width) {
  const { P } = require('./paint');
  const out = [];
  // Drawn-line index -> the user message on that line. See userBlock.
  //
  // NON-ENUMERABLE: this is a side-channel for the click handler, not content.
  // As a plain property it turned every `deepStrictEqual` against a rendered
  // feed into a comparison of the map as well, so a test about blank rows
  // failed over a bookkeeping field it had no opinion about.
  Object.defineProperty(out, 'userAt', { value: Object.create(null), enumerable: false, writable: true });
  // Drawn-line index -> the FILE that line names. The same side-channel as
  // `userAt` and for the same reason: a click has to resolve what it landed
  // on without re-parsing painted text. Non-enumerable, so a rendered feed
  // still compares as an array of strings. See ui/mouse.js.
  Object.defineProperty(out, 'fileAt', { value: Object.create(null), enumerable: false, writable: true });
  const labels = width >= LABEL_MIN_WIDTH;
  // WHERE THE CURRENT RUN OF CALLS BEGINS. The last one is the work in hand;
  // everything before it has finished and recedes. See the action branch below.
  let lastRun = -1;
  for (let k = 0; k < entries.length; k++) {
    if (entries[k].kind !== 'action') continue;
    if (k === 0 || entries[k - 1].kind !== 'action') lastRun = k;
  }
  let last = null;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const k = kindOf(e);
    // BROKEN ON SEVERITY TOO, not only on speaker. A run keyed on `kind` alone
    // shows one label for the whole run, so a warning followed by an error drew
    // the error under the word WARN — the label naming the wrong thing, which
    // is worse than no label.
    const key = e.kind === 'note' ? `note:${e.level || 'info'}` : e.kind;
    if (key !== last) {
      if (last !== null) out.push('');
      // The label carries the actor's own colour, so a glance down the left
      // edge tells you who said what without reading a word of it.
      //
      // AND FOR THE USER IT SAYS WHICH OF THREE THINGS THIS IS — a message, a
      // one-word decision, or a pasted attachment. See ui/anchors.js: a
      // decision is the most consequential thing in a long session and looked
      // like the least.
      const text = e.kind === 'user'
        ? (P[k.paint] || P.meta)(require('./anchors').label(e.source || e.text))
        : (P[k.paint] || P.meta)(k.label);
      // A KIND WITH NO LABEL STILL GETS ITS GAP. The blank row above is what
      // separates one speaker from the next, and it is doing more work than the
      // word ever did — dropping both would run the model's answer straight
      // into the tool calls above it.
      // ---- THE USER LABEL IS AN ANCHOR, NOT A HEADING --------------------
      //
      // Every other label here is decoration and rightly goes on a narrow
      // terminal — indentation alone still separates the model from the tools.
      // `USER` is different in kind: it is the marker Alt+arrow navigates
      // BETWEEN and a click restores FROM (ui/anchors.js, ui/mouse.js), and it
      // is what tells a paste apart from a decision when scrolling back through
      // an hour of work. Dropping it at 51 columns removed the visible half of
      // a navigation feature and left the invisible half working, which is the
      // worst of both: the anchors were still there and nothing showed where.
      //
      // It costs one short row, and it is the one label that earns it at every
      // width.
      if ((labels || e.kind === 'user') && k.label) out.push('  ' + text);
      last = key;
    }
    // ---- PROSE STARTS AT THE MARGIN --------------------------------------
    //
    // The indent existed to sit under a label. With no label above it, four
    // spaces are four spaces of nothing — and they were spent on the model's
    // answer, which is the one thing on the screen a person is actually
    // reading. It keeps its indent only where a label is genuinely above it.
    const indent = (labels || e.kind === 'user') && k.label ? '    ' : (e.kind === 'action' ? '   ' : '  ');

    // ---- A TOOL ACTION IS QUOTED, NEVER PROSE ---------------------------
    //
    // THE REQUIREMENT, and it is not cosmetic: a reader must be able to tell
    // WHAT LAIN SAID from WHAT A TOOL DID without reading either. Rendered as
    // ordinary indented rows, `✓ Read src/cache.js` sat at the same visual
    // weight as the sentence above it, so three calls outshouted the answer
    // they were evidence for.
    //
    // Behind a gutter the distinction survives MONOCHROME — it is structural,
    // not a colour. The whole run goes through one block so a call and its
    // result stay together instead of drifting apart down the column.
    if (e.kind === 'action') {
      let j = i;
      const rows = [];
      // WHICH OF THESE ROWS NAMES A FILE. Collected alongside the text rather
      // than derived from it afterwards: the entry knows its path, and reading
      // it back out of a painted sentence would be parsing our own output.
      const named = [];
      while (j < entries.length && entries[j].kind === 'action') {
        if (entries[j].text) {
          rows.push(entries[j].text);
          if (entries[j].path) named.push({ text: entries[j].text, path: entries[j].path });
        }
        j += 1;
      }
      if (rows.length) {
        const blocks = require('./blocks');
        // ---- FINISHED WORK RECEDES; THE CURRENT RUN DOES NOT ---------------
        //
        // Every completed call was drawn at `meta`, which is also the weight of
        // the call happening right now. Thirty finished reads therefore carried
        // exactly the force of the one in flight: the pane preserved every past
        // event with equal visual weight, and there was nothing for the eye to
        // follow down it.
        //
        // THE LAST RUN IS THE CURRENT WORK, and it keeps its weight. Everything
        // before it has already happened and becomes context — one step quieter
        // (see ui/paint.js `faint`), still legible, still exactly where it was.
        // Nothing is dropped and nothing moves; only the emphasis changes, which
        // is the whole of "compact and de-emphasise rather than delete".
        //
        // FROM THE ENTRIES, NOT A COUNTER. `lastRun` is computed once from the
        // list being drawn, so it cannot fall out of step with what is on screen
        // the way a flag set at push time would.
        const quoted = blocks.quote(rows, { width });
        const recede = i !== lastRun;
        for (const row of quoted) {
          // ---- A ROW THAT NAMES A FILE IS A ROW YOU CAN OPEN ---------------
          //
          // `quote` wraps and decorates, so the emitted rows are not one-to-one
          // with the entries that produced them. The mapping used here is the
          // one a person would make anyway: this row is navigable if the file's
          // name is VISIBLE ON IT. A wrapped continuation that does not show the
          // name is not something anybody would aim at.
          const hit = named.find((n) => row.includes(n.path));
          if (hit) out.fileAt[out.length] = hit.path;
          out.push('  ' + (recede ? P.faint(row) : row));
        }
        i = j - 1;
        continue;
      }
    }

    // ---- WHAT THE USER SAID, ON ITS OWN GROUND ---------------------------
    //
    // The whole run at once, so a message typed across several lines is ONE
    // block with one marker on it, rather than a `❯` per line pretending to be
    // several messages.
    if (e.kind === 'user') {
      let j = i;
      const rows = [];
      let source = '';
      while (j < entries.length && entries[j].kind === 'user') {
        if (!source && entries[j].source) source = entries[j].source;
        for (const row of V().wrap(entries[j].text || '', Math.max(12, width - indent.length - 2))) rows.push(row);
        j += 1;
      }
      userBlock(out, source || rows.join(String.fromCharCode(10)), rows, width, P);
      i = j - 1;
      continue;
    }

    // ---- A MODEL ANSWER IS RENDERED, NOT ECHOED --------------------------
    //
    // Its markup is instructions to a renderer, and until now there was none —
    // so ``` fences, ### hashes and `backticks` were shown as content, and the
    // code in an answer was the hardest part of it to find. The whole run is
    // taken together because a fence spans lines, and it is emitted
    // pre-painted so nothing downstream re-wraps and undoes it.
    //
    // The ENTRIES are untouched: they still hold exactly what the model wrote.
    // This is the draw step, where the width is known. See ui/markdown.js.
    if (e.kind === 'model') {
      let j = i;
      const run = [];
      while (j < entries.length && entries[j].kind === 'model') { run.push(entries[j].text || ''); j += 1; }
      const md = require('./markdown');
      if (md.looksMarked(run.join('\n'))) {
        for (const row of md.render(run, Math.max(12, width - indent.length - 2))) {
          out.push(row ? indent + row : '');
        }
        i = j - 1;
        continue;
      }
      // Plain prose with no markup falls through to the ordinary path, so the
      // common case pays nothing for any of this.
    }
    // COLOUR IS APPLIED AFTER WRAPPING, one row at a time. `wrap` splits on
    // whitespace, so colouring the whole entry first would tear an escape
    // sequence across two lines and leave the second one painted for good.
    // A LINE THE MODEL LEFT BLANK IS DRAWN BLANK. `wrap` returns nothing for
    // an empty string, so without this the gap between two paragraphs is the
    // one piece of the model's formatting that still disappears.
    if (!e.text) { out.push(''); continue; }
    // A LINE'S OWN INDENTATION IS PART OF THE LINE. `wrap` splits on
    // whitespace and rejoins, which flattens the leading spaces of every line
    // it touches — so a fenced code block kept its newlines and lost its
    // shape, and nested code came out flush against the margin. Held aside and
    // reapplied to every row of that line, so folded code stays aligned under
    // itself instead of jumping back to the left edge.
    const lead = (/^[ \t]+/.exec(e.text) || [''])[0].replace(/\t/g, '  ').slice(0, 24);
    const body = e.text.slice((/^[ \t]+/.exec(e.text) || [''])[0].length);
    let first = true;
    for (const row of V().wrap(body, Math.max(12, width - indent.length - lead.length - 2))) {
      out.push(indent + lead + paintRow(e, row, first, P, k));
      first = false;
    }
  }
  return out;
}

/** One row of an entry, painted for its kind. */
function paintRow(e, row, first, P, k) {
  if (e.kind === 'action') return first ? paintMark(row, P) : P.meta(row);
  // A user line is bright and marked, so it stands out of the scroll as the
  // thing that started everything below it.
  if (e.kind === 'user' && first) return P.key('❯ ') + P.key(row);
  if (e.kind === 'user') return P.key('  ' + row);
  // The body wears the kind's own weight, which for a note is its SEVERITY —
  // so a refused request is red text and not grey text with a red word above it.
  const paint = P[k.body];
  return paint && k.body !== 'plain' ? paint(row) : row;
}

/**
 * Green tick, red cross — the outcome, before anything else on the row.
 *
 * THE TEXT AFTER THE MARK IS SECONDARY, and it was not: the glyph was coloured
 * and the rest of the row left at full weight, so `✓ Read dashboard.py` carried
 * the same visual force as the sentence LAIN had just written — and the green
 * tick carried more. Three tool calls then outshouted the model's actual
 * answer, which is backwards: the calls are the EVIDENCE for that answer, not
 * the point of it.
 *
 * The mark keeps its colour, because passed-or-failed is the one thing worth
 * spotting from across the row. Everything after it goes quiet.
 */
function paintMark(row, P) {
  const m = V().MARK;
  if (row.startsWith(m.done)) return P.ok(m.done) + P.meta(row.slice(m.done.length));
  if (row.startsWith(m.error)) return P.bad(m.error) + P.meta(row.slice(m.error.length));
  // A wrapped detail line under a call, not an outcome of its own.
  return P.meta(row);
}


/**
 * HOW MANY CONVERSATIONAL MESSAGES — what `↓ 3 new` counts.
 *
 * Deliberately NOT rows and NOT tool calls: the indicator exists so a person
 * reading back through history knows somebody SAID something, and thirty reads
 * scrolling past is not somebody saying something.
 */
const SPOKEN = new Set(['user', 'model', 'external', 'mcp']);
function spokenCount(entries) {
  // A RUN OF ENTRIES IS ONE MESSAGE. A model's answer is one entry per line,
  // so counting entries would report a twenty-line reply as twenty new
  // messages — which is exactly the kind of number that teaches a person to
  // ignore the indicator.
  let n = 0;
  let last = null;
  for (const e of entries) {
    if (SPOKEN.has(e.kind) && e.kind !== last) n++;
    last = e.kind;
  }
  return n;
}



// FLOOD COMPACTION MOVED TO ui/compact.js — see its header for the seam.
// Re-exported under the same names so no caller had to move with it.
const { compactRuns, KEEP } = require('./compact');

module.exports = {
  pushAction, pushModel, pushUser, pushExternal, pushMcp, pushNote, pushLines,
  renderFeed, compactRuns, spokenCount, LABEL_MIN_WIDTH, KIND, KEEP,
};
