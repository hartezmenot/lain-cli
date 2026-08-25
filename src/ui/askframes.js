'use strict';

/**
 * THE QUESTION FRAMES — one per kind of answer.
 *
 * Split out of ui/adapters.js, which had grown past the god-object guard. The
 * seam is the one the design draws in: a question is not a picker. Every
 * other adapter in that file offers a LIST OF THINGS THAT EXIST — models,
 * files, commands, plan steps — and the user points at one. A question can ask
 * for a number, free text, yes or no, or several of a set, and each of those
 * needs a different surface and a different idea of what a typed line means.
 *
 * "Do not overload one MCQ renderer with incompatible input types." These are
 * five frames, not one renderer with five modes. They share the ONE panel and
 * the ONE input line and nothing else — so a NUMBER question cannot draw a
 * list of options that are not there, and a CHOICE question cannot promise a
 * numeric field it does not have.
 *
 * WHAT EACH KIND ACCEPTS lives in ui/answer.js, and is read by the rows here,
 * by the footer, and by the border of the input box. One declaration, three
 * surfaces, no way for them to disagree.
 */

const { KIND, MODE } = require('./panel');

/** What each kind of question accepts. The one declaration all three surfaces read. */
const A = require('./answer');

/** The choice/why split, so a compact row and its explanation stay in step. */
const { splitOption } = require('./adapters');

/**
 * ONE ENTRY POINT, FIVE FRAMES.
 *
 * "Do not overload one MCQ renderer with incompatible input
 * types." A question declares its KIND and gets the frame that kind needs — a
 * list to pick from, a validated number line, a free-text line, a yes/no, or a
 * set of togglable rows. They share the ONE panel and the ONE input line and
 * nothing else, so a NUMBER question cannot draw a list of options that are not
 * there, and a CHOICE question cannot promise a numeric field it does not have.
 * See ui/answer.js for what each kind accepts.
 */
function askAdapter({ question, options = [], title = 'LAIN NEEDS YOUR INPUT', input = null }) {
  const kind = A.kindOf(input, options);
  // The model's own "(please type a number)" is removed: the surface prints an
  // accurate prompt of its own, and two instructions that can disagree is how
  // the wrong one gets followed. See answer.stripUiInstruction.
  const asked = A.stripUiInstruction(question);

  if (kind === A.KIND.NUMBER) return numberAdapter({ question: asked, title });
  if (kind === A.KIND.TEXT) return textAdapter({ question: asked, title, options });
  if (kind === A.KIND.MULTI_SELECT) return multiAdapter({ question: asked, options, title });

  const rows = kind === A.KIND.CONFIRMATION && !options.length ? ['Yes', 'No'] : options;
  const lines = String(asked == null ? '' : asked).split('\n');
  const parsed = rows.map(splitOption);
  const hasWhy = parsed.some((p) => p.why);
  const marks = A.labels(rows, kind);
  return {
    title,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    // WHAT THIS SURFACE TAKES, stated once and read by all three places that
    // have to agree about it: these rows, the panel footer, and the border of
    // the input box you actually type into (see layout._inputLabel).
    takes: kind,
    options: rows,
    question: asked,
    items: [
      ...lines.map((l) => ({ label: l, selectable: false })),
      { label: '', selectable: false },
      ...rows.map((o, i) => ({ label: `${marks[i]}.  ${parsed[i].choice}`, value: o })),
    ],
    footer: A.footer(rows, kind, { escape: hasWhy ? 'details' : 'cancel' }),
    // Only offered when there is genuinely more to read. Escape that opens an
    // empty screen is worse than Escape that cancels.
    onEscape: hasWhy ? () => ({ push: askDetailsAdapter({ question: asked, options: rows }) }) : null,
    /**
     * A TYPED LINE IS THE ANSWER — the whole point of this rewrite.
     *
     * Enter used to resolve the HIGHLIGHTED row and throw away whatever had
     * been typed, so `2` + Enter against the options 1–4 answered "1". Now the
     * line is resolved against the options first (answer.match) and, failing
     * that, taken at face value: a person is not obliged to find their reply
     * in a list somebody else wrote.
     *
     * A CONFIRMATION is the exception, and deliberately: yes and no are the
     * only two answers it has, so prose is REJECTED with a reason rather than
     * quietly recorded as a third one.
     */
    onTyped(text) {
      if (kind === A.KIND.CONFIRMATION) {
        const v = A.validate(kind, text, rows);
        return v.ok ? { close: v.value } : { reject: v.why };
      }
      const m = A.match(text, rows, kind);
      if (!m) return undefined;                       // empty line: Enter means the row
      if (m.kind === 'OPTION' && A.optionIsOther(rows[m.index])) {
        return { push: textAdapter({ question: asked, options: rows, back: true }) };
      }
      return { close: m.value };
    },
    onSelect(item) {
      // PICKING "Other…" MUST LEAD SOMEWHERE YOU CAN TYPE. It used to close
      // the panel and print one dim line into the transcript, which is exactly
      // the "is this editable or is it just text?" confusion in the design.
      if (A.optionIsOther(item.value)) {
        return { push: textAdapter({ question: asked, options: rows, back: true }) };
      }
      return { close: item.value };
    },
    /**
     * THE LABEL MOVES TO THE CHOICE. It does not confirm it.
     *
     * A single keystroke is one key away from every other key, and this panel
     * is where LAIN asks a question whose answer it is about to act on — a
     * mistyped `b` that silently commits is the class of mis-click that must
     * never cost the user work. So the cursor moves and Enter still confirms.
     *
     * Numbers are NOT claimed here: they stay on the input line where they are
     * visible, editable and reviewable before Enter. `12` is two keystrokes,
     * and a shortcut that swallowed the `1` could never see the `2`.
     */
    shortcuts: A.isNumeric(rows) ? {} : Object.fromEntries(rows.map((o, i) => [
      String(marks[i]).toLowerCase(),
      (item, { panel }) => {
        const at = panel.items.findIndex((x) => x.value === o);
        if (at >= 0) panel.cursor = at;
        return true;
      },
    ])),
  };
}

/**
 * NUMBER — a validated line, and no list of options that do not exist.
 *
 * "Enter level: _" in the design. The rejection is why this is its own frame: a
 * number question that quietly accepts "about forty" has not been answered, it
 * has been answered WRONGLY, and the model will act on it.
 */
function numberAdapter({ question, title = 'LAIN NEEDS YOUR INPUT' }) {
  return {
    title,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.NUMBER,
    options: [],
    question,
    items: [
      ...String(question == null ? '' : question).split('\n').map((l) => ({ label: l, selectable: false })),
      { label: '', selectable: false },
      { label: 'Type a number on the line above and press Enter.', selectable: false },
    ],
    footer: A.footer([], A.KIND.NUMBER),
    onTyped(text) {
      const v = A.validate(A.KIND.NUMBER, text);
      return v.ok ? { close: v.value } : { reject: v.why };
    },
  };
}

/**
 * TEXT — free text, with a real place to type it.
 *
 * Reached directly for a text question, and from "Other…" on a list. There is
 * still exactly ONE editor: the line at the bottom of the screen, with its
 * history, its caret and its paste handling. What this frame changes is what
 * that line MEANS and what the screen says about it — the border above it reads
 * ANSWER, the footer names the two keys that work, and from "Other…" Escape
 * comes back to the choices rather than throwing the question away.
 */
function textAdapter({ question, options = [], title = 'YOUR ANSWER', back = false }) {
  const lines = String(question == null ? '' : question).split('\n');
  return {
    title,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.TEXT,
    options,
    question,
    items: [
      ...lines.map((l) => ({ label: l, selectable: false })),
      { label: '', selectable: false },
      { label: 'Type your answer on the line above and press Enter.', selectable: false },
      ...(back ? [{ label: 'Esc goes back to the listed choices.', selectable: false }] : []),
    ],
    footer: A.footer(options, A.KIND.TEXT, { escape: back ? 'back' : 'cancel' }),
    onEscape: back ? () => ({ back: true }) : null,
    onTyped(text) {
      const s = String(text == null ? '' : text).trim();
      return s ? { close: s } : undefined;
    },
  };
}

/**
 * MULTI_SELECT — any of them, none of them, all of them.
 *
 * Space marks the row under the cursor; Enter sends what is marked. A typed
 * `1,3` does the same in one line, and every token must resolve: half of what
 * somebody meant, silently accepted, is the same class of error as the wrong
 * single choice.
 */
function multiAdapter({ question, options = [], title = 'LAIN NEEDS YOUR INPUT' }) {
  const marks = A.labels(options, A.KIND.MULTI_SELECT);
  const chosen = new Set();
  const rows = () => [
    ...String(question == null ? '' : question).split('\n').map((l) => ({ label: l, selectable: false })),
    { label: '', selectable: false },
    ...options.map((o, i) => ({
      label: `${chosen.has(i) ? '[x]' : '[ ]'} ${marks[i]}.  ${splitOption(o).choice}`,
      value: o,
      index: i,
    })),
  ];
  const frame = {
    title,
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    takes: A.KIND.MULTI_SELECT,
    options,
    question,
    chosen,
    items: rows(),
    footer: A.footer(options, A.KIND.MULTI_SELECT),
    /** Space marks and unmarks. Enter is "send what is marked". */
    shortcuts: {
      ' ': (item, { panel }) => {
        if (!item || item.index === undefined) return true;
        if (chosen.has(item.index)) chosen.delete(item.index); else chosen.add(item.index);
        frame.items = rows();
        panel.stack[panel.stack.length - 1] = frame;
        return true;
      },
    },
    onSelect() {
      if (!chosen.size) return { reject: 'nothing is marked yet — Space marks a row, or type the numbers.' };
      return { close: [...chosen].sort((a, b) => a - b).map((i) => A.optionText(options[i])).join(', ') };
    },
    onTyped(text) {
      const v = A.validate(A.KIND.MULTI_SELECT, text, options);
      return v.ok ? { close: v.value } : { reject: v.why };
    },
  };
  return frame;
}

/**
 * The same question, with every option's reasoning in full.
 *
 * Read-only on purpose: this screen explains, and the choosing happens on the
 * screen you came from. Escape (or ←) goes back to it.
 */
function askDetailsAdapter({ question, options = [] }) {
  const items = [];
  for (const l of String(question == null ? '' : question).split('\n')) {
    items.push({ label: l, selectable: false });
  }
  items.push({ label: '', selectable: false });
  options.forEach((o, i) => {
    const { choice, why } = splitOption(o);
    items.push({ label: `${A.LETTERS[i] || i + 1} — ${choice}`, selectable: false });
    const body = why || '(no further explanation was given)';
    for (let at = 0; at < body.length && at < 400; at += 66) {
      items.push({ label: `    ${body.slice(at, at + 66)}`, selectable: false });
    }
    items.push({ label: '', selectable: false });
  });
  return {
    title: 'QUESTION DETAILS',
    kind: KIND.ASK_USER,
    mode: MODE.EXPANDED,
    items,
    footer: 'Esc back to the choices',
    onEscape: () => ({ back: true }),
  };
}

module.exports = { askAdapter, numberAdapter, textAdapter, multiAdapter, askDetailsAdapter };
