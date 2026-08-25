'use strict';

/**
 * THE PANEL ADAPTERS — DATA, never drawing code.
 *
 * Split out of ui/panel.js, which had grown past the god-object guard. The seam
 * is the one that file's own header already draws: the panel is a pure state
 * machine over `{ items, cursor, scroll }`, and an adapter is a description of
 * WHAT TO OFFER. They change for entirely different reasons — a new picker is a
 * change here and nowhere else; a change to how selection works is a change
 * there and nowhere else.
 *
 * Every function here reads state that already exists and returns a plain
 * object. Nothing here draws, and nothing here does I/O, which is what keeps
 * every picker in the program testable without a terminal.
 *
 * panel.js re-exports all of these, so no caller had to move with them.
 */

const { KIND, MODE, pad, clip } = require('./panel');

//
// Adapters are DATA. They read existing application state and never draw.

/** `/effort` — one owner; `auto` clears the pin. */
function effortAdapter({ available = [], current = null }) {
  const levels = [...available, 'auto'];
  return {
    title: 'EFFORT',
    kind: KIND.EFFORT_SELECTION,
    mode: MODE.COMPACT,
    items: levels.map((l) => ({
      label: `${l}${l === (current || 'auto') ? '   (current)' : ''}`,
      value: l,
    })),
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

/** `/models` — MODEL-CENTRIC. One row per identity; routes on drill-down. */
function modelsAdapter({ catalog, current = null, currentConnection = null, onPickRoute = null, readinessOf = null, availabilityOf = null, availabilityRaw = null, filter = '', isNew = null }) {
  // THE SAME SEARCH THE COMMAND USES. This used to be a second, stricter
  // filter — `includes()` on one contiguous string — so `/models qwen free`
  // found a model and typing `qwen free` into the picker found nothing. One
  // implementation, one answer.
  const q = String(filter || '').trim();
  const models = q ? require('../catalog').search(catalog, q, 400) : catalog.models;
  const items = models.map((m) => {
    // WHAT HELPS SOMEONE CHOOSE, and nothing else. A route count is only worth
    // a person's attention when there is actually a choice in it; effort levels
    // likewise. One provider name is orientation, not diagnostics.
    const routes = m.connections.length;
    const efforts = (m.connections[0] && m.connections[0].efforts) || [];
    const meta = routes > 1
      ? `${routes} providers`
      : [(m.connections[0] || {}).provider, efforts.length > 1 ? `${efforts.length} levels` : null]
        .filter(Boolean).join('  ·  ');
    // The mark goes in FRONT of the name, where a person looks for it, not in a
    // column after it.
    const mark = m.id === current ? '● ' : '  ';
    // NEW, for the models the LAST refresh actually brought in. It leads the
    // name because that is the thing you are scanning a thousand rows for; it is
    // never claimed for a model that was already known (see newmodels.js).
    const fresh = isNew && isNew.has && isNew.has(m.id) ? 'NEW ' : '    ';
    return {
      label: `${mark}${fresh}${pad(clip(m.displayName, 40), 42)}${meta}`,
      value: m.id,
      model: m,
    };
  });
  if (!items.length) items.push({ label: `no model matches "${filter}"`, selectable: false });
  const at = models.findIndex((m) => m.id === current);
  // THE CURRENT MODEL NEVER SILENTLY DISAPPEARS. Filtering can hide the row
  // carrying the ● mark, and then the picker shows no current state at all —
  // so the title carries it when the list cannot.
  const currentModel = current && catalog.models.find((m) => m.id === current);
  const currentShown = at >= 0;
  const title = q
    ? `MODELS   ${models.length} matching "${filter}"`
      + (currentModel && !currentShown ? `   ·   current: ${clip(currentModel.displayName, 28)}` : '')
    : `MODELS   ${models.length}`;
  return {
    title,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    cursor: at > 0 ? at : 0,
    footer: '↑↓ select · Enter use · → routes · Esc cancel',
    /**
     * ENTER MEANS "USE THIS MODEL".
     *
     * It used to mean "show me this model's routes", which is a different
     * question and one almost nobody was asking: measured on the live catalog,
     * 882 of 975 models have exactly ONE route. Picking one of those cost three
     * Enters — model, route, "use this route" — through two screens that
     * offered no choice at all. That is the whole of "Enter doesn't select the
     * model": Enter did something, just never the thing it was pressed for.
     *
     * So Enter commits as soon as there is nothing left to decide, and only
     * drills in when there genuinely is. `→` still opens the routes for a model
     * with one route, for anyone who wants to look before committing.
     */
    onSelect(item, { key } = {}) {
      const m = item.model;
      if (!m) return undefined;
      const routes = m.connections;
      const drill = key === 'right' || routes.length > 1;
      if (drill) {
        return { push: modelRoutesAdapter({ model: m, onPickRoute, readinessOf, availabilityOf, availabilityRaw, currentConnection }) };
      }
      const c = routes[0];
      // NEVER SHOW A SCREEN THAT HAS ONE ANSWER ON IT. One route with SEVERAL
      // effort levels is a real decision and gets asked; one route with one
      // level, or none, is not, and is resolved here.
      if (c.efforts.length > 1) {
        return { push: routeDetailAdapter({ model: m, connection: c, onPickRoute, readinessOf, availabilityOf }) };
      }
      const effort = c.efforts.length === 1 ? c.efforts[0] : null;
      if (onPickRoute) onPickRoute(m, c, effort);
      return { close: { model: m.id, connection: c.connectionId, effort } };
    },
  };
}

/**
 * MODEL → PROVIDER / CONNECTION.
 *
 * Level two of three. Each route is ONE row plus its effort summary, so a model
 * served twenty ways is twenty pairs of lines rather than a hundred and sixty.
 * The previous version printed eight labelled fields per route inline, which
 * turned "which route should I use?" into a scroll through a data dump.
 *
 * The detail is not lost — it moves to level three, where it is being asked for.
 */
/**
 * CAN I CALL THIS ROUTE RIGHT NOW — as a colour and a sentence.
 *
 * THE COLOUR MEANS WHAT YOU CAN DO ABOUT IT, which is the only distinction that
 * helps while you are choosing:
 *
 *   GREEN   callable. Go.
 *   YELLOW  temporary — rate limited, too many calls, try again later. It will
 *           clear ON ITS OWN, and the countdown says when, so waiting is a real
 *           option rather than a guess.
 *   RED     it will NOT clear on its own. A missing credential, a refused key,
 *           a route that is down. Something has to be done.
 *   DIM     nobody has called it yet, so nothing is known. Not a claim.
 *
 * The distinction that matters most is yellow against red: both are "it did not
 * work", and only one of them is worth waiting for.
 */
function routeHealth(c, { readinessOf, availabilityOf, availabilityRaw } = {}) {
  const avail = availabilityOf ? String(availabilityOf(c) || '') : '';
  const ready = readinessOf ? String(readinessOf(c) || '') : '';
  const raw = availabilityRaw ? availabilityRaw(c) : null;

  // TEMPORARY FIRST. A rate-limited route is not broken, and calling it red
  // sends people off to check credentials that are perfectly fine.
  if (raw && raw.rateLimited) {
    const left = raw.resumeAt ? raw.resumeAt - Date.now() : 0;
    const when = left > 0 ? ` · clears in ${require('../ratelimit').human(left)}` : ' · should have cleared';
    return { tone: 'warn', text: `rate limited${when}` };
  }
  if (/RATE|LIMIT|TOO MANY/i.test(avail)) return { tone: 'warn', text: 'rate limited · try again later' };
  if (/MAINTENANCE|DISABLED/i.test(avail)) return { tone: 'warn', text: avail.toLowerCase() };

  // PERMANENT UNTIL SOMEBODY ACTS.
  if (/AUTH|CREDENTIAL|KEY/i.test(ready) && !/READY|PRESENT|OK/i.test(ready)) {
    return { tone: 'bad', text: ready.toLowerCase().replace(/_/g, ' ') };
  }
  if (/UNAVAILABLE|DOWN|FAILED/i.test(avail)) return { tone: 'bad', text: avail.toLowerCase() };

  if (/AVAILABLE|READY/i.test(avail) || /READY|PRESENT/i.test(ready)) {
    return { tone: 'ok', text: 'ready' };
  }
  return { tone: 'meta', text: avail ? avail.toLowerCase() : 'not tried yet' };
}

function modelRoutesAdapter({ model, onPickRoute = null, readinessOf = null, availabilityOf = null, availabilityRaw = null, currentConnection = null }) {
  const items = [];
  for (const c of model.connections) {
    const here = c.connectionId === currentConnection;
    const name = [c.provider, c.route && c.route !== c.provider ? c.route : null].filter(Boolean).join(' · ');
    const health = routeHealth(c, { readinessOf, availabilityOf, availabilityRaw });
    items.push({
      // WHICH ROUTE, AND WHETHER IT WILL ANSWER, on the row you choose from —
      // rather than one level deeper, which is where it used to be. Choosing a
      // model is exactly the moment "can I actually call this" matters.
      label: `${here ? '● ' : '  '}${(name || c.connectionId).padEnd(28)}${health.text}`,
      tone: health.tone,
      value: c, connection: c,
    });
    items.push({
      label: `      ${c.efforts.length ? c.efforts.join(' · ') : '(no effort levels on this route)'}`,
      selectable: false,
    });
  }
  const at = model.connections.findIndex((c) => c.connectionId === currentConnection);
  return {
    title: `${model.displayName.toUpperCase()}   ·   ${model.connections.length} route${model.connections.length === 1 ? '' : 's'}`,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    cursor: at > 0 ? at * 2 : 0,
    footer: '↑↓ select · Enter open route · ← back · Esc close',
    onSelect(item) {
      if (!item.connection) return undefined;
      return { push: routeDetailAdapter({ model, connection: item.connection, onPickRoute, readinessOf, availabilityOf }) };
    },
  };
}

/**
 * MODEL → ROUTE → EFFORT. Level three.
 *
 * Identity, provider, connection, credential, readiness, availability and
 * effort stay SEPARATE fields — never flattened into one string, because
 * "the server is down", "you are not logged in" and "you disabled it" are
 * different problems with different fixes.
 *
 * Choosing an effort here selects the route AND the level in one act, which is
 * the thing the user actually came to do.
 */
function routeDetailAdapter({ model, connection, onPickRoute = null, readinessOf = null, availabilityOf = null }) {
  const c = connection;
  const items = [
    { label: `  connection    ${c.connectionId}`, selectable: false },
    { label: `  provider      ${c.provider}  ·  via ${c.via}`, selectable: false },
    { label: `  credential    ${c.auth}`, selectable: false },
  ];
  if (readinessOf) items.push({ label: `  readiness     ${readinessOf(c)}`, selectable: false });
  if (availabilityOf) items.push({ label: `  availability  ${availabilityOf(c)}`, selectable: false });
  items.push({ label: '', selectable: false });

  if (c.efforts.length) {
    items.push({ label: '  EFFORT', selectable: false });
    for (const e of c.efforts) items.push({ label: `    ${e}`, value: e, effort: e });
  } else {
    // Not an error and not an empty list: this route genuinely exposes none,
    // and selecting it is still the right action.
    items.push({ label: '  This route exposes no effort levels.', selectable: false });
    items.push({ label: '    use this route', value: null, useRoute: true });
  }

  return {
    title: `${model.displayName.toUpperCase()}   ·   ${c.provider}`,
    kind: KIND.MODEL_SELECTION,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter use · ← back · Esc close',
    onSelect(item) {
      if (!item.effort && !item.useRoute) return undefined;
      if (onPickRoute) onPickRoute(model, c, item.effort || null);
      return { close: { model: model.id, connection: c.connectionId, effort: item.effort || null } };
    },
  };
}

/** `/provider` — availability + connection state. No health checks, no polling. */
function providerAdapter({ connections = [], availabilityOf = () => 'UNKNOWN' }) {
  const items = [];
  for (const c of connections) {
    items.push({ label: c.id, value: c.id });
    items.push({ label: `    availability: ${availabilityOf(c.id)}`, selectable: false });
    items.push({ label: `    provider:     ${c.provider}  ·  via ${c.via}`, selectable: false });
    items.push({ label: `    credential:   ${c.auth}`, selectable: false });
    items.push({ label: `    readiness:    ${c.readiness}`, selectable: false });
    items.push({ label: `    models:       ${c.models.length}`, selectable: false });
    items.push({ label: '', selectable: false });
  }
  if (!items.length) items.push({ label: '  no connections configured', selectable: false });
  return { title: 'PROVIDERS', kind: KIND.PROVIDER_SELECTION, mode: MODE.EXPANDED, items, footer: '↑↓ select · Enter select · Esc close' };
}

/**
 * `/config` — reads the EXISTING config store; there is no second one.
 *
 * Enter EDITS. It used to say so in the footer and then merely close, which is
 * the worst kind of UI promise. Each row declares how it is edited, and the
 * editors are the same adapters the matching commands already use — choosing a
 * model here and choosing one from `/models` run the identical code.
 */
function configAdapter({ cfg, keys = null, editors = {} }) {
  const shown = keys || ['model', 'connection', 'effort', 'maxSteps', 'stream'];
  return {
    title: 'CONFIG',
    kind: KIND.CONFIG,
    mode: MODE.EXPANDED,
    items: shown.map((k) => ({
      label: `${k.padEnd(14)}${pad(fmt(cfg[k]), 34)}${editors[k] ? '' : '(read-only)'}`,
      value: k,
      key: k,
    })),
    footer: '↑↓ navigate · Enter change · Esc close',
    onSelect(item) {
      const edit = editors[item.key];
      if (typeof edit !== 'function') return undefined;      // nothing to do
      const outcome = edit(cfg);
      // An editor either hands back another panel to drill into, or it applied
      // the change itself and we redraw this list with the new value.
      if (outcome && outcome.push) return { push: outcome.push };
      return { push: configAdapter({ cfg, keys, editors }) };
    },
  };
}

function fmt(v) {
  if (v === null || v === undefined) return 'auto';
  if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
  return String(v);
}

/**
 * `ask_user` / MCQ — choices rendered deterministically from the tool input.
 *
 * THE QUESTION IS ONE ITEM PER LINE. It used to be a single item, which the
 * panel clips to one row — so a multi-line question showed its first sentence
 * and an ellipsis. That is merely unhelpful for an ordinary question and
 * genuinely unsafe for the desktop permission request, where the lines being
 * eaten were the LIST OF CAPABILITIES: the user was being asked to grant
 * control of their machine without being shown what they were granting.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** How much of an option is a CHOICE, and how much is its explanation. */
function splitOption(text) {
  // WHAT A ROW SAYS is ui/answer.js's question, not this one. An option that
  // arrived as an object — `{ label, description }`, which models send freely
  // whatever the schema asks for — is normalised there into `label — why`,
  // which is precisely the shape the split below then takes apart. Coercing
  // with `String()` here instead is what put `[object Object]` on every row.
  const s = require('./answer').optionText(text).replace(/\s+/g, ' ').trim();
  // A model writes `Left panel — keeps the toolbar clear, but hides it on
  // mobile`: the part before the dash is the choice, the rest is why. Splitting
  // on it is what lets the compact list stay one row per option while the
  // reasoning survives intact one level down.
  const m = /^(.{1,60}?)\s+[—–-]\s+(.+)$/.exec(s);
  if (m) return { choice: m[1].trim(), why: m[2].trim() };
  if (s.length <= 60) return { choice: s, why: '' };
  return { choice: s.slice(0, 57).trimEnd() + '…', why: s };
}

/**
 * `ask_user` — TWO LEVELS, because a question and its reasoning are different
 * sizes.
 *
 * The panel clips every row to one line, so a model that explained its options
 * — which is exactly what a good question does — produced a list of truncated
 * sentences with the reasoning cut off mid-word. Worse, the one key a person
 * presses when they want to know more (Escape) CANCELLED the question.
 *
 * So: the choices stay compact and lettered, one row each, and Escape opens the
 * explanations rather than throwing the question away. Escape again returns to
 * the choices, with the highlighted option preserved (see panel.push/back).
 *
 * The answer still comes back through the ONE `ask()` promise and, for free
 * text, the ONE `pendingAsk` slot. This is a second SCREEN, never a second
 * ask_user system.
 */

function confirmAdapter({ question, yes = 'Yes', no = 'No' }) {
  return {
    title: 'CONFIRM',
    kind: KIND.CONFIRM,
    mode: MODE.COMPACT,
    items: [
      { label: question, selectable: false },
      { label: '', selectable: false },
      { label: yes, value: true },
      { label: no, value: false },
    ],
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

/**
 * `/` — the command palette.
 *
 * The list comes from the command REGISTRY the dispatcher itself uses, passed in
 * by the caller. There is no second command list to drift out of date: a command
 * that is not registered cannot appear here, and one that is registered cannot
 * be missing. `/effort` appears exactly once because it is defined exactly once.
 */
function commandPaletteAdapter({ commands = [], filter = '' }) {
  const f = String(filter || '').toLowerCase();
  const matches = commands.filter((c) => c.name.startsWith(f));
  // ---- WHAT YOU TYPED IN FULL IS WHAT YOU MEANT --------------------------
  //
  // THE DEFECT THIS FIXES: `/session` and `/sessions` both start with
  // `/session`, and the palette listed them in registry order — so typing the
  // whole of `/session` and pressing Enter ran `/sessions`, a different command
  // about a different subject. The user had typed a complete, unambiguous name
  // and been given something else.
  //
  // A COMPLETE NAME OUTRANKS A LONGER ONE. Everything else keeps the order it
  // had, so this changes nothing for any other prefix: `/mod` still offers
  // `/model` and `/models` exactly as before.
  matches.sort((a, b) => Number(b.name === f) - Number(a.name === f));
  const items = matches.map((c) => ({
    label: (c.name + (c.args ? ' ' + c.args : '')).padEnd(30) + (c.desc || ''),
    value: c.name,
    command: c.name,
  }));
  if (!items.length) items.push({ label: `no command matches "${filter}"`, selectable: false });
  return {
    title: 'COMMANDS',
    kind: KIND.COMMAND_PALETTE,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Tab complete · Enter run · Esc cancel',
  };
}

/**
 * `@` — project-relative path completion.
 *
 * Entries are supplied already listed and bounded by the caller; this only
 * arranges them. Choosing a directory re-lists one level deeper, so a path is
 * walked a segment at a time and nothing is ever read into the prompt.
 */
function fileCompletionAdapter({ entries = [], filter = '' }) {
  const items = entries.map((e) => ({
    label: e.isDir ? e.path : '  ' + e.path,
    value: e.path,
    entry: e,
  }));
  if (!items.length) items.push({ label: `no path matches "@${filter}"`, selectable: false });
  return {
    title: 'FILES',
    kind: KIND.FILE_COMPLETION,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Tab/→ insert · Enter insert · Esc cancel',
  };
}

/**
 * Which changed file to open in the DIFF view.
 *
 * The workspace itself stays a read-only rendering of state; SELECTION goes
 * through the one panel, so the diff view needs no cursor of its own and no
 * second key-handling path.
 */
function changedFilesAdapter({ files = [] }) {
  const items = files.map((f) => ({
    label: `${pad(f.kind.toUpperCase(), 9)} ${pad(clip(f.rel, 46), 48)} +${f.added} -${f.removed}`,
    value: f.rel,
    file: f,
  }));
  if (!items.length) items.push({ label: 'nothing has changed in this session yet', selectable: false });
  return {
    title: `CHANGED FILES   ${files.length}`,
    kind: KIND.FILE_PICKER,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter open the diff · Esc close',
  };
}

/** Which plan step to expand. Expansion is display-only; this cannot edit a plan. */
function planStepsAdapter({ steps = [], expanded = new Set() }) {
  const items = steps.map((s) => ({
    label: `${expanded.has(s.n) ? '▼' : '◆'} ${String(s.n).padStart(2)}  ${pad(clip(s.text, 52), 54)} ${s.status}`,
    value: s.n,
    step: s,
  }));
  if (!items.length) items.push({ label: 'no plan in this session', selectable: false });
  return {
    title: 'PLAN STEPS',
    kind: KIND.STEP_PICKER,
    mode: MODE.EXPANDED,
    items,
    footer: '↑↓ select · Enter expand or collapse · Esc close',
  };
}

function helpAdapter({ commands = [] }) {
  return {
    title: 'COMMANDS',
    mode: MODE.EXPANDED,
    items: commands.map((c) => ({ label: `${(c.name + (c.args ? ' ' + c.args : '')).padEnd(24)}${c.desc}`, value: c.name })),
    footer: '↑↓ select · Enter insert · Esc close',
  };
}


/**
 * WHAT A COMMAND SAID — `/status`, `/dash`, `/effort`, a compaction notice.
 *
 * THE PANEL IS THE PLACE, and the first attempt at this got it wrong. Command
 * output was polluting Context, so it was moved out — into a NEW region drawn
 * just above the input. That fixed the pollution and introduced a second window
 * in the same corner of the screen: `/` opens the command palette here, `/model`
 * opens the model list here, and `/status` opened something else that looked
 * almost, but not quite, like them and overlapped the same band.
 *
 * ONE SURFACE ANSWERS "LAIN IS SHOWING YOU SOMETHING". This is that surface, and
 * the output of a command is no more special than the list of commands.
 *
 * NOTHING IS SELECTABLE. Every row is text, so no row takes the cursor and Enter
 * has nothing to commit. `Esc close` is the whole contract — the same Esc that
 * closes the palette and the model list, which is the point.
 */
function outputAdapter({ title = '', lines = [] }) {
  return {
    title: String(title || '').trim().toUpperCase(),
    mode: MODE.EXPANDED,
    kind: KIND.OUTPUT,
    // WRAPPED, NOT CLIPPED. These rows are sentences and paths, not choices, so
    // a long one continues on the next line instead of being cut. Clipping took
    // "Chat history exceeds the 800-message limit" and left
    // "…exceeds the 800-mes…" — it announced that a limit had been reached and
    // then removed the number, which is the one fact in the sentence.
    wrap: true,
    // Blank rows are dropped: a command that opens with `\n` to separate itself
    // from a prompt is padding for a scrolling terminal, and this is a box with
    // a title bar that already does that job.
    items: lines
      .map((l) => String(l == null ? '' : l).replace(/\s+$/, ''))
      .filter((l) => l.trim())
      .map((label) => ({ label, selectable: false })),
    footer: 'Esc close',
  };
}

module.exports = { routeHealth, effortAdapter, modelsAdapter, modelRoutesAdapter, routeDetailAdapter, providerAdapter, configAdapter, fmt, LETTERS, splitOption, confirmAdapter, commandPaletteAdapter, fileCompletionAdapter, changedFilesAdapter, planStepsAdapter, helpAdapter, outputAdapter };


// THE QUESTION FRAMES LIVE IN ui/askframes.js — see its header for why. Required
// HERE, at the bottom, so this file's own exports (splitOption) already exist
// when that one destructures them. Re-exported so every existing caller keeps
// its single import.
Object.assign(module.exports, require('./askframes'));
