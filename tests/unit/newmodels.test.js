'use strict';

/**
 * THE `NEW` MARKER.
 *
 * A refresh on a real router returns thousands of models and the refresh report
 * scrolls away; the marker is what carries "these three are the ones you just
 * added" into the picker. Its whole value is that it can be trusted, so:
 *
 *   - it is NEVER claimed for a model that was already known
 *   - it retires on a deterministic rule (next refresh, or you select it)
 *   - it cannot accumulate across refreshes
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('../helpers');

/** Each case gets its own config home, so none of them can see another's. */
function isolate(fn) {
  const before = process.env.LAIN_CONFIG_DIR;
  process.env.LAIN_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'newmodels-'));
  try { return fn(); } finally { process.env.LAIN_CONFIG_DIR = before; }
}

const nm = () => require('../../src/newmodels');

module.exports = async function () {
  await test('NEW: what the refresh added is marked, and nothing else is', () => {
    isolate(() => {
      nm().record(['qwen3.8-27b-free', 'some-new-model']);
      assert.strictEqual(nm().isNew('qwen3.8-27b-free'), true);
      assert.strictEqual(nm().isNew('claude-sonnet-5'), false, 'a model that was already there is not new');
    });
  });

  await test('NEW: selecting a model retires its marker, and only its own', () => {
    isolate(() => {
      nm().record(['a', 'b']);
      assert.strictEqual(nm().seen('a'), true);
      assert.strictEqual(nm().isNew('a'), false);
      assert.strictEqual(nm().isNew('b'), true, 'the others are still news');
      assert.strictEqual(nm().seen('a'), false, 'retiring it twice is not an error, and changes nothing');
    });
  });

  await test('NEW: a later refresh REPLACES the set — markers cannot pile up', () => {
    isolate(() => {
      nm().record(['a', 'b']);
      nm().record(['c']);
      assert.deepStrictEqual([...nm().all()], ['c']);
      assert.strictEqual(nm().isNew('a'), false, 'last time round is not news any more');
    });
  });

  await test('NEW: the FIRST discovery marks nothing — "all of it" is not news', () => {
    isolate(() => {
      nm().record(['a', 'b', 'c'], { firstCatalog: true });
      assert.deepStrictEqual([...nm().all()], []);
      // Nor is a refresh that somehow adds thousands: that is a first discovery
      // wearing another name, and marking every row helps nobody.
      nm().record(Array.from({ length: nm().MAX_TRACKED + 1 }, (_, i) => `m${i}`));
      assert.deepStrictEqual([...nm().all()], []);
    });
  });

  await test('NEW: it survives a restart, because refreshing and choosing later is normal', () => {
    isolate(() => {
      nm().record(['kept']);
      // A fresh require, as a new process would do — the state is on disk, not
      // in a module-level variable.
      delete require.cache[require.resolve('../../src/newmodels')];
      assert.strictEqual(require('../../src/newmodels').isNew('kept'), true);
    });
  });

  await test('NEW: an unreadable config home degrades to "nothing is new", never a crash', () => {
    const before = process.env.LAIN_CONFIG_DIR;
    process.env.LAIN_CONFIG_DIR = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now(), 'nope\u0000');
    try {
      assert.doesNotThrow(() => nm().all());
      assert.deepStrictEqual([...nm().all()], []);
    } finally { process.env.LAIN_CONFIG_DIR = before; }
  });

  await test('NEW: the picker row carries the marker, and the layout still lines up', () => {
    const { modelsAdapter } = require('../../src/ui/panel');
    const catalog = {
      models: [
        { id: 'a', displayName: 'qwen3.8 27b Free', connections: [{ provider: 'omniroute', efforts: [] }] },
        { id: 'b', displayName: 'claude-sonnet-5', connections: [{ provider: 'omniroute', efforts: [] }] },
      ],
      byId: new Map(),
    };
    const a = modelsAdapter({ catalog, isNew: new Set(['a']) });
    assert.match(a.items[0].label, /NEW\s+qwen3\.8 27b Free/);
    assert.ok(!/NEW/.test(a.items[1].label), 'the known model must not be marked');
    // Both rows start their name in the same column, or the list reads as ragged.
    const col = (s) => s.indexOf(s.trim().replace(/^[●\s]*(NEW\s+)?/, '').slice(0, 6));
    assert.strictEqual(col(a.items[0].label), col(a.items[1].label));
  });
};
