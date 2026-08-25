'use strict';

/**
 * WHAT KIND OF ANSWER A QUESTION IS ASKING FOR, AND WHAT A TYPED LINE MEANS.
 *
 * THE FAILURE THIS EXISTS TO REMOVE, reproduced against the real binary: LAIN
 * asked "level (please type a number)" with the options 1–4, the user typed `2`
 * and pressed Enter, and LAIN recorded "The user chose: 1". The rows were
 * labelled `[A]`–`[D]` while the question asked for a number; the digit went
 * into the input line, which the panel did not read; and Enter resolved the
 * HIGHLIGHTED row instead. A question was answered — silently, and wrongly.
 *
 * The deeper fault underneath it: a question did not SAY what it was asking
 * for. One renderer served every question, so "pick one of these" and "type a
 * number" and "say something" all drew the same list, and the prompt could
 * promise something the surface would not accept. So a question now declares
 * its KIND, and every surface that describes it reads that one declaration:
 *
 *     CHOICE        one of the listed options
 *     NUMBER        a number, validated, re-asked if it is not one
 *     TEXT          free text
 *     CONFIRMATION  yes or no
 *     MULTI_SELECT  any of the listed options, none or all
 *
 * This module holds no state and draws nothing. It decides what a line MEANS,
 * so the panel rows, the panel footer and the border of the input box can never
 * advertise different keys.
 *
 * THERE IS NO SECOND INPUT SYSTEM HERE. The line still comes from the one
 * InputReader, with its editing, its history and its paste handling; this only
 * interprets it once Enter is pressed.
 */

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The free-text row. One spelling, shared by the tool and the panel. */
const OTHER = 'Other…';

/**
 * WHAT THE SURFACE IS ASKING FOR. Declared by the question, read by everything
 * that describes it — the rows, the footer, the input border, the validator.
 */
const KIND = Object.freeze({
  CHOICE: 'CHOICE',
  NUMBER: 'NUMBER',
  TEXT: 'TEXT',
  CONFIRMATION: 'CONFIRMATION',
  MULTI_SELECT: 'MULTI_SELECT',
});

/** What a caller may name in `ask_user`, mapped to the kind it means. */
const FROM_TOOL = Object.freeze({
  choice: KIND.CHOICE,
  number: KIND.NUMBER,
  text: KIND.TEXT,
  confirm: KIND.CONFIRMATION,
  confirmation: KIND.CONFIRMATION,
  multi: KIND.MULTI_SELECT,
  multi_select: KIND.MULTI_SELECT,
});

/** The kind a caller asked for, or CHOICE. Never throws on a bad name. */
function kindOf(name, options = []) {
  const k = FROM_TOOL[String(name || '').trim().toLowerCase()] || (options.length ? KIND.CHOICE : KIND.TEXT);
  // NO OPTIONS MEANS THERE IS NOTHING TO CHOOSE BETWEEN, whatever was declared.
  // A "choice" with an empty list rendered a list of nothing under a question,
  // with no way to answer it at all — so it becomes the question it actually
  // is. This applies to a DECLARED kind too, not only to an absent one: a model
  // that says "choice" and forgets the options has still asked for free text.
  //
  // A CONFIRMATION IS EXEMPT because it brings its own two rows. Yes and No are
  // not something the caller has to supply, and demoting it to free text would
  // turn a two-answer question into one that accepts anything.
  if (needsOptions(k) && !options.length) return KIND.TEXT;
  return k;
}

/** True when this kind draws a list of rows to pick from. */
function listed(kind) {
  return kind === KIND.CHOICE || kind === KIND.CONFIRMATION || kind === KIND.MULTI_SELECT;
}

/** True when the CALLER has to supply those rows for the question to mean anything. */
function needsOptions(kind) {
  return kind === KIND.CHOICE || kind === KIND.MULTI_SELECT;
}

/**
 * THE KEYS A MODEL ACTUALLY USES when it sends an option as an object.
 *
 * Ordered: the label-ish keys first, then the explanation-ish ones. A row is
 * rendered as `<label> — <why>`, which is exactly the shape ui/adapters.js
 * `splitOption` takes apart again for the compact list and the details screen.
 */
const LABEL_KEYS = ['label', 'option', 'choice', 'title', 'name', 'text', 'value'];
const WHY_KEYS = ['description', 'detail', 'details', 'why', 'reason', 'explanation', 'subtitle'];

/**
 * A row's own text.
 *
 * ------------------------------------------------------------------------
 * `[object Object]`, AND WHY IT REACHED THE SCREEN.
 *
 * The `ask_user` schema declares `options: { items: { type: 'string' } }`, and
 * every surface here coerced with `String(o)`. Models send objects anyway —
 * `{ label, description }` is the natural way to write a choice that has a
 * reason attached, and the schema is a request, not an enforcement. `String()`
 * of an object is `[object Object]`, so a question with four well-explained
 * options rendered as four identical rows reading `A.  [object Object]`, the
 * shortcut letters keyed on the same string, and `match()` unable to tell any
 * of them apart. The question was unanswerable.
 *
 * Coercion was the bug. This NORMALISES instead, in the one place every
 * surface already asks what a row says — the panel rows, the letter
 * shortcuts, `match`, `validate`, `selection` and the details screen all get
 * the fix from here, and none of them needed to know it happened.
 * ------------------------------------------------------------------------
 */
function optionText(o) {
  if (o == null) return '';
  if (typeof o === 'string') return o;
  if (typeof o !== 'object') return String(o);
  if (Array.isArray(o)) return o.map(optionText).filter(Boolean).join(' — ');

  const pick = (keys) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
    return '';
  };
  const label = pick(LABEL_KEYS);
  const why = pick(WHY_KEYS);
  if (label) return why && why !== label ? `${label} — ${why}` : label;
  if (why) return why;

  // An object shaped like nothing above. The FIRST usable scalar is still a
  // better answer than `[object Object]`, and an empty row is better than a
  // row of JSON the user is invited to choose between.
  for (const v of Object.values(o)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  }
  return '';
}

/** Is this row the free-text row? Tolerant of the plain-ASCII spelling. */
function optionIsOther(o) {
  const s = optionText(o).trim().replace(/[.…]+$/, '').toLowerCase();
  return s === 'other';
}

/**
 * Are these options themselves numbers? Then the rows are numbered rather than
 * lettered, because `[A] 1 · [B] 2` is a question about its own labels.
 */
function isNumeric(options = []) {
  const real = options.filter((o) => optionText(o) !== OTHER);
  return real.length > 0 && real.every((o) => /^-?\d+(?:\.\d+)?$/.test(optionText(o).trim()));
}

/**
 * The visible label for each row.
 *
 * `Y`/`N` for a confirmation, digits when the choices are themselves numbers,
 * letters otherwise. Whatever is drawn is also what can be typed — that is the
 * entire contract, and breaking it is the bug this file was written for.
 */
function labels(options = [], kind = KIND.CHOICE) {
  if (kind === KIND.CONFIRMATION) return options.map((_, i) => (i === 0 ? 'Y' : 'N'));
  // MULTI_SELECT IS ALWAYS NUMBERED, because its hint says "type 1-3, comma
  // separated" and a row lettered A under that instruction is the same
  // promise-the-surface-will-not-keep this file exists to prevent. A caught it:
  // the rows read A/B/C while the footer asked for numbers.
  if (kind === KIND.MULTI_SELECT) return options.map((_, i) => String(i + 1));
  const numeric = isNumeric(options);
  return options.map((_, i) => (numeric ? String(i + 1) : (LETTERS[i] || String(i + 1))));
}

/**
 * WHAT THE SURFACE ACCEPTS RIGHT NOW, in the user's words.
 *
 * The brief is explicit that "(please type a number)" must not appear unless a
 * number really is accepted at that moment — so this is derived from the
 * declared kind and the same options the rows are drawn from, and can never
 * disagree with them.
 *
 * KEPT SHORT ON PURPOSE. The footer is clipped to the panel width, and a hint
 * cut off mid-word ("Esc det…") is a promise the screen failed to make.
 */
function hint(options = [], kind = KIND.CHOICE) {
  const n = options.length;
  switch (kind) {
    case KIND.NUMBER: return 'type a number';
    case KIND.TEXT: return 'type your answer';
    case KIND.CONFIRMATION: return 'type Y or N';
    case KIND.MULTI_SELECT:
      return n ? `type 1-${n}, comma separated` : 'type your answer';
    default:
      if (!n) return 'type your answer';
      return isNumeric(options)
        ? `type a number 1-${n}`
        : `type ${n === 1 ? 'A' : `A-${LETTERS[n - 1] || n}`}`;
  }
}

/** The border label for the input box while a question is open. */
function inputLabel(options = [], kind = KIND.CHOICE) {
  return `ANSWER — ${hint(options, kind)}`;
}

/** The panel footer. It names every key that works, and nothing that does not. */
function footer(options = [], kind = KIND.CHOICE, { escape = 'cancel' } = {}) {
  const keys = hint(options, kind);
  switch (kind) {
    case KIND.NUMBER:
    case KIND.TEXT:
      return `${keys} · Enter send · Esc ${escape}`;
    case KIND.MULTI_SELECT:
      return `${keys} · ↑↓ move · Space mark · Enter send · Esc ${escape}`;
    default:
      return `${keys} · ↑↓ choose · Enter send · Esc ${escape}`;
  }
}

/**
 * Resolve a typed line against the options.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *
 *   1. THE ROW'S OWN TEXT WINS. Someone who types `Svelte` meant Svelte.
 *   2. THEN THE ROW LABEL — `2`, `2.`, `b`, `[B]`, `Y`. A bare label only:
 *      `2 files` is a sentence that begins with a digit, not a choice, and
 *      treating it as one is the silent-wrong-answer bug in a new costume.
 *   3. OTHERWISE IT IS FREE TEXT, which is an answer in its own right. The user
 *      is not required to find their reply in a list somebody else wrote.
 *
 * @returns {{kind:'OPTION',index:number,value:string}|{kind:'TEXT',value:string}|null}
 *          null when there is nothing to resolve (an empty line).
 */
function match(typed, options = [], kind = KIND.CHOICE) {
  const s = String(typed == null ? '' : typed).trim();
  if (!s) return null;

  const exact = options.findIndex((o) => optionText(o).trim().toLowerCase() === s.toLowerCase());
  if (exact >= 0) return { kind: 'OPTION', index: exact, value: optionText(options[exact]) };

  const bare = /^\[?([A-Za-z0-9]{1,3})\]?[.)]?$/.exec(s);
  if (bare) {
    const token = bare[1].toLowerCase();
    const at = labels(options, kind).findIndex((l) => l.toLowerCase() === token);
    if (at >= 0) return { kind: 'OPTION', index: at, value: optionText(options[at]) };
    // AND THE PLAIN ORDINAL, whichever alphabet the rows are drawn in. The
    // brief asks for "number/letter selection", and someone counting rows down
    // a lettered list and typing 2 has said something perfectly clear. The
    // drawn labels are tried FIRST, so on a numbered list this can never
    // disagree with what is on screen.
    const ord = Number(token);
    if (Number.isInteger(ord) && ord >= 1 && ord <= options.length) {
      return { kind: 'OPTION', index: ord - 1, value: optionText(options[ord - 1]) };
    }
  }

  return { kind: 'TEXT', value: s };
}

/**
 * IS THIS LINE AN ACCEPTABLE ANSWER TO A QUESTION OF THIS KIND?
 *
 * The point of a declared kind. A NUMBER question that quietly accepts "about
 * forty" has not been answered — it has been answered wrongly, which is worse,
 * because the model will act on it. Refusing with a reason and leaving the
 * question open is the only honest response, and it costs the user one keypress.
 *
 * @returns {{ok:true, value}|{ok:false, why:string}}
 */
function validate(kind, typed, options = []) {
  const s = String(typed == null ? '' : typed).trim();
  if (!s) return { ok: false, why: 'nothing was typed' };

  if (kind === KIND.NUMBER) {
    if (!/^-?\d+(?:\.\d+)?$/.test(s)) {
      return { ok: false, why: `"${s}" is not a number. Type digits only, for example 12.` };
    }
    return { ok: true, value: s };
  }

  if (kind === KIND.CONFIRMATION) {
    if (/^(y|yes)$/i.test(s)) return { ok: true, value: optionText(options[0]) || 'Yes' };
    if (/^(n|no)$/i.test(s)) return { ok: true, value: optionText(options[1]) || 'No' };
    return { ok: false, why: `"${s}" is not yes or no. Type Y or N.` };
  }

  if (kind === KIND.MULTI_SELECT) {
    const picked = selection(s, options);
    if (!picked.ok) return picked;
    return { ok: true, value: picked.values.join(', ') };
  }

  return { ok: true, value: s };
}

/**
 * `1,3` or `a c` or `React, Svelte` → the rows they name.
 *
 * Every token must resolve. A list where one entry was a typo is not a partial
 * answer — half of what somebody meant, silently accepted, is the same class of
 * error as the wrong single choice.
 *
 * @returns {{ok:true, indexes:number[], values:string[]}|{ok:false, why:string}}
 */
function selection(typed, options = []) {
  const tokens = String(typed || '').split(/[,\s]+/).map((t) => t.trim()).filter(Boolean);
  if (!tokens.length) return { ok: false, why: 'nothing was selected' };
  const indexes = [];
  for (const t of tokens) {
    const m = match(t, options, KIND.MULTI_SELECT);
    if (!m || m.kind !== 'OPTION') {
      return { ok: false, why: `"${t}" is not one of the choices. Use the numbers beside them.` };
    }
    if (!indexes.includes(m.index)) indexes.push(m.index);
  }
  indexes.sort((a, b) => a - b);
  return { ok: true, indexes, values: indexes.map((i) => optionText(options[i])) };
}

/**
 * STRIP AN INSTRUCTION THE UI NOW OWNS.
 *
 * A model that has been told the answer arrives as text writes "level (please
 * type a number)" — and once the panel prints its own accurate prompt, the
 * question carries a second, competing one. Worse, the model's version can be
 * wrong about what is accepted, which is the thing the design forbids.
 *
 * Only a TRAILING parenthetical that is purely an instruction about HOW to
 * reply is removed. "Which port (the one in config.json)?" is information about
 * the question and is left exactly as written.
 */
const UI_INSTRUCTION = /\s*\(\s*(?:please\s+)?(?:just\s+)?(?:type|enter|reply\s+with|respond\s+with|answer\s+with|choose|pick|select|say)\b[^)]{0,60}\)\s*$/i;

function stripUiInstruction(question) {
  const s = String(question == null ? '' : question);
  const cut = s.replace(UI_INSTRUCTION, '');
  return cut.trim() ? cut.trimEnd() : s;
}

module.exports = {
  LETTERS, OTHER, KIND, FROM_TOOL,
  kindOf, listed, needsOptions, optionText, optionIsOther, isNumeric, labels,
  hint, inputLabel, footer, match, validate, selection, stripUiInstruction,
};
