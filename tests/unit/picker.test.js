'use strict';

/**
 * THE MODEL PICKER — Enter means "use this".
 *
 * Found by driving the real TUI: `/models sonnet` → ↓↓ → Enter left the active
 * model unchanged. Enter was bound to "show me this model's routes", so
 * selecting a model cost three keypresses through two screens — and on the live
 * catalog 882 of 975 models have exactly ONE route, so those two screens offered
 * no choice at all. Enter did something; it never did the thing it was pressed
 * for.
 *
 * The rule these encode: COMMIT WHEN THERE IS NOTHING LEFT TO DECIDE, and drill
 * in only when there genuinely is.
 */

const assert = require('assert');
const { test } = require('../helpers');

const panel = require('../../src/ui/panel');
const catalog = require('../../src/catalog');

/** A catalog whose models have the route/effort shapes under test. */
function cat(spec) {
  return {
    models: spec.map((s) => ({
      id: s.id,
      displayName: s.name || s.id,
      connections: (s.routes || [{ id: 'only' }]).map((r) => ({
        connectionId: r.id,
        baseConnectionId: r.id,
        provider: r.provider || 'p',
        via: 'bridge',
        auth: 'none',
        efforts: r.efforts || [],
      })),
    })),
  };
}

module.exports = async function () {
  await test('PICK: Enter on a single-route model USES it, in one keypress', () => {
    let picked = null;
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'solo', name: 'Solo' }]),
      onPickRoute: (m, c, e) => { picked = { model: m.id, connection: c.connectionId, effort: e }; },
    }));
    const closed = p.select({ key: 'enter' });
    assert.deepStrictEqual(picked, { model: 'solo', connection: 'only', effort: null });
    assert.ok(closed, 'the picker must close on selection, not stay open');
    assert.deepStrictEqual(closed, { model: 'solo', connection: 'only', effort: null });
  });

  await test('PICK: a model with SEVERAL routes still asks which one', () => {
    // The drill-down is not gone — it appears exactly where a decision exists.
    let picked = null;
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'multi', routes: [{ id: 'a' }, { id: 'b' }] }]),
      onPickRoute: (m, c) => { picked = c.connectionId; },
    }));
    p.select({ key: 'enter' });
    assert.strictEqual(picked, null, 'nothing may be chosen while two routes are on offer');
    assert.match(p.frame.title, /MULTI/, 'it opened the routes instead');
  });

  await test('PICK: one route WITH effort levels asks for the level, and skips the empty screen', () => {
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'graded', name: 'Graded', routes: [{ id: 'only', efforts: ['low', 'high'] }] }]),
    }));
    p.select({ key: 'enter' });
    // Straight to the effort screen — the route list in between had one row and
    // no decision on it.
    const body = p.render(80, 16).join('\n');
    assert.match(body, /EFFORT/, `expected the effort screen:\n${body}`);
    assert.match(body, /low/);
    assert.match(body, /high/);
  });

  await test('PICK: → looks at the routes without committing', () => {
    let picked = null;
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'solo', name: 'Solo' }]),
      onPickRoute: () => { picked = 'chosen'; },
    }));
    p.select({ key: 'right' });
    assert.strictEqual(picked, null, '→ must not select');
    assert.match(p.frame.title, /SOLO/, '→ opens the route list');
  });

  await test('PICK: ← comes back from a drill-down with nothing chosen', () => {
    let picked = null;
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'solo', name: 'Solo' }]),
      onPickRoute: () => { picked = 'chosen'; },
    }));
    p.select({ key: 'right' });
    p.back();
    assert.match(p.frame.title, /MODELS/, '← returns to the list');
    assert.strictEqual(picked, null);
  });

  await test('PICK: ↑↓ move the selection, and Enter uses the row that is highlighted', () => {
    let picked = null;
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({
      catalog: cat([{ id: 'one' }, { id: 'two' }, { id: 'three' }]),
      onPickRoute: (m) => { picked = m.id; },
    }));
    p.move(1); p.move(1);
    p.select({ key: 'enter' });
    assert.strictEqual(picked, 'three', 'Enter used a different row than the one highlighted');
  });

  await test('PICK: the footer states what Enter does', () => {
    // The old footer said "Enter view routes", which was at least honest about
    // the behaviour being wrong.
    const p = new panel.InteractionPanel();
    p.open(panel.modelsAdapter({ catalog: cat([{ id: 'solo' }]) }));
    assert.match(p.frame.footer, /Enter use/);
    assert.match(p.frame.footer, /routes/, 'and that → is how you look first');
  });

  await test('PICK: a filter narrows the list and the count says so', () => {
    const c = cat([{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5' }, { id: 'gpt-5', name: 'GPT 5' }]);
    const f = panel.modelsAdapter({ catalog: c, filter: 'sonnet' });
    assert.strictEqual(f.items.length, 1);
    assert.match(f.title, /1 matching "sonnet"/);
  });

  await test('PICK: a filter that matches nothing says so instead of showing an empty box', () => {
    const f = panel.modelsAdapter({ catalog: cat([{ id: 'a' }]), filter: 'zzz' });
    assert.strictEqual(f.items.length, 1);
    assert.strictEqual(f.items[0].selectable, false);
    assert.match(f.items[0].label, /no model matches "zzz"/);
  });

  // ------------------------------------------------------- one search rule --

  await test('PICK: a search returns EVERY match, so nothing is silently hidden', () => {
    const c = catalog.build([{
      id: 'c1', provider: 'p', via: 'bridge', auth: 'none',
      models: ['claude-sonnet-5', 'claude-sonnet-4', 'gpt-5'],
    }]);
    assert.strictEqual(catalog.search(c, 'sonnet').length, 2);
    assert.strictEqual(catalog.search(c, 'claude-sonnet-5').length, 1, 'an exact id is unambiguous');
  });

  await test('PICK: an exact match outranks a partial one', () => {
    const c = catalog.build([{
      id: 'c1', provider: 'p', via: 'bridge', auth: 'none',
      models: ['sonnet-extended', 'sonnet'],
    }]);
    assert.strictEqual(catalog.search(c, 'sonnet')[0].id, 'sonnet');
  });
};
