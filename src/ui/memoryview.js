'use strict';

/**
 * THE MEMORY PANE — what has been settled, so it is not settled again.
 *
 * The pane exists because the alternative is a future session reopening a
 * decision that was made deliberately, from a transcript where the reasoning
 * scrolled out of view months ago. "External JSON is the source of truth" is
 * one sentence; rediscovering it costs an afternoon and sometimes gets
 * "tidied up" by whoever looks next.
 *
 * ORDERED BY HOW SETTLED IT IS. Decisions and source-of-truth entries first —
 * those are the ones somebody is about to contradict — then conventions, then
 * limitations, and open notes last. A reader scanning from the top meets the
 * binding things before the loose ones.
 */

const { doc } = require('./doc');
const { P } = require('./paint');

/** What each kind is FOR, in one line, so an empty section still teaches. */
const MEANING = {
  decision: 'Settled deliberately. Do not reopen without a reason.',
  'source-of-truth': 'Where the real version lives. Anything else is a copy.',
  fact: 'A convention that is true of this project.',
  limitation: 'Something that cannot be done here, and why.',
  note: 'Noticed and not yet settled.',
};

/** Kinds that bind future work, and so are drawn with weight. */
const BINDING = new Set(['decision', 'source-of-truth']);

function render({ root, width = 80 }) {
  const memory = require('../memory');
  const d = doc();
  d.title('memory', 'project');
  d.subtitle('What is TRUE about this project — not what was said about it');

  let groups = [];
  try { groups = memory.grouped(root); } catch { groups = []; }

  if (!groups.length) {
    d.section('empty');
    d.text('Nothing has been recorded yet.');
    d.blank();
    d.text('This is engineering memory, not conversation history. It survives '
      + 'compaction, summarisation and restart — so a thing written here is still '
      + 'here in a session that has never seen this conversation.');
    d.section('keep something');
    d.field('note', '/note the context summary still feels compressed', { tone: P.cmd });
    d.field('decision', '/note decision external JSON is the source of truth', { tone: P.cmd });
    d.field('fact', '/note fact lain-probe takes decimal PIDs', { tone: P.cmd });
    d.field('limitation', '/note limitation browser checks need Chromium', { tone: P.cmd });
    return d.render(width);
  }

  for (const g of groups) {
    d.section(g.kind.replace(/-/g, ' '), `${g.items.length}`);
    if (MEANING[g.kind]) d.note(MEANING[g.kind]);
    for (const item of g.items) {
      // The id is metadata and stays quiet; the sentence is the point. Binding
      // kinds carry weight so the eye lands on them first.
      d.bullet(`${P.meta(item.id)}  ${BINDING.has(g.kind) ? P.key(item.text) : item.text}`,
        { mark: BINDING.has(g.kind) ? '▪' : '·' });
    }
  }

  d.section('managing it');
  d.field('add', '/note [kind] <text>', { tone: P.cmd });
  d.field('remove', '/note drop <id>', { tone: P.cmd });
  return d.render(width);
}

module.exports = { render, MEANING, BINDING };
