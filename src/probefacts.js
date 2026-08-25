'use strict';

/**
 * THE PROBE CONTRACT — what this repository can prove, and what only a running
 * Probe can answer.
 *
 * The Probe is an EXTERNAL companion. Its source is not in this tree; LAIN
 * forwards `{op, params}` to it over a connection and the Probe decides
 * everything dangerous on its own side. That shapes what can honestly be said
 * here, and `probeskill.js` already states the governing rule for exactly this
 * situation:
 *
 *     "A copy kept here would drift the first time that document changed, and
 *      the drift would be silent — LAIN would go on describing a Probe that had
 *      moved. ... no attempt to restate a contract it cannot see."
 *
 * So this does NOT write down the Probe's parameter list. Writing it down is
 * the defect. What it does instead is three things, each of which is genuinely
 * establishable:
 *
 *   1. FACTS THE REPOSITORY PROVES about the shape of the call — the envelope,
 *      the discovery route, which operations demand a window, the timeouts.
 *   2. ONE REPRESENTATION FACT THAT IS PROVABLE BY GRAMMAR, below.
 *   3. AN EXPLICIT UNKNOWN for the per-operation schema, naming the one call
 *      that answers it, so a model asks the Probe instead of guessing at it.
 *
 * ------------------------------------------------------------------------
 * WHY `pid` IS DECIMAL IS NOT A GUESS.
 *
 * The advertised schema documents the params as `{ "pid": 1234 }` and
 * `{ "address": "0x1abc" }`. Those two are different JSON TYPES, and that is
 * the whole proof:
 *
 *   · `1234` is a JSON number. The JSON grammar has no hexadecimal literal —
 *     `0x3FA8` is a syntax error, not a number — so a PID sent as a number is
 *     necessarily decimal. There is no other thing it could be.
 *   · `"0x1abc"` is a JSON string carrying an `0x` prefix, so an address is
 *     transported as text and is hexadecimal.
 *
 * A PID and an address are therefore not interchangeable in either
 * representation or type, and that follows from the declared examples plus the
 * JSON grammar rather than from anybody's recollection.
 * ------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const F = require('./facts');
const { AREA, REPR, VIA } = F;
const { CONFIDENCE } = require('./findings');

/** The declared example in the advertised schema, which is the evidence. */
const SCHEMA_AT = 'src/tools/probe.js';

/** Read the advertised probe schema, if the tool is registered in this build. */
function advertisedSchema() {
  try {
    const s = require('./tools').schemas().find((x) => x.name === 'probe');
    return s || null;
  } catch { return null; }
}

/** The example string the schema uses to document `params`. */
function paramsExample(schema) {
  const p = schema && schema.parameters && schema.parameters.properties && schema.parameters.properties.params;
  return p && p.description ? String(p.description) : '';
}

/**
 * Facts about how a Probe call is SHAPED — provable from LAIN's own source,
 * because the envelope is LAIN's, not the Probe's.
 */
function envelopeFacts(live) {
  const out = [];
  const schema = advertisedSchema();

  out.push(F.make({
    area: AREA.PROBE,
    name: 'Availability',
    value: live ? 'CONNECTED' : 'not connected',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.RUNTIME,
    evidence: live
      ? 'probe.live() returned a connected Probe in this process'
      : 'probe.live() returned nothing; the user starts one with /mcp probe',
    at: 'src/probe.js',
    notes: live ? null : 'The probe tool is not advertised at all while no Probe is connected.',
  }));

  out.push(F.make({
    area: AREA.PROBE,
    name: 'Call envelope',
    value: 'probe(op: "<name>", params: {...})',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SCHEMA,
    examples: ['probe(op: "process.attach", params: { pid: 16296 })'],
    evidence: 'the advertised schema declares op (required) and params',
    at: SCHEMA_AT,
    notes: 'One tool with an op, not one tool per operation — the Probe implements dozens and each '
      + 'would otherwise cost schema tokens on every request of the session.',
  }));

  out.push(F.make({
    area: AREA.PROBE,
    name: 'Discovering an operation',
    value: 'probe(op: "capabilities") then params {of: "<name>"}',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    examples: ['probe(op: "capabilities", params: { of: "investigate.behavior" })'],
    evidence: 'capabilities() forwards to the Probe\'s own probe.tools, with describe: <name> for one operation',
    at: SCHEMA_AT,
    notes: 'This returns the AUTHORITATIVE parameter schema for that operation. It is the answer to any '
      + 'question this contract records as UNKNOWN.',
  }));

  // ---- THE WINDOW REQUIREMENT, which silently sends nothing when missing ---
  const windowProp = schema && schema.parameters && schema.parameters.properties
    && schema.parameters.properties.window;
  if (windowProp) {
    out.push(F.make({
      area: AREA.PROBE,
      name: 'Keyboard operations',
      value: 'window (a window TITLE) is required',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      examples: ['probe(op: "input.keyboard.tap", params: { key: "F5" }, window: "Notepad")'],
      evidence: 'the advertised schema states that without it NOTHING IS SENT',
      at: SCHEMA_AT,
      notes: 'Omitting it does not error loudly — the keystroke is simply not sent, because an unaimed '
        + 'keystroke lands wherever the user is looking.',
    }));
    out.push(F.make({
      area: AREA.PROBE,
      name: 'Keyboard delivery result',
      value: 'SENT_UNCONFIRMED',
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      evidence: 'the advertised schema declares keyboard results as SENT_UNCONFIRMED',
      at: SCHEMA_AT,
      notes: 'The OS accepted the key; nothing observed the target receiving it. To establish delivery, '
        + 'observe the target itself — its log, or a capture.',
    }));
  }

  out.push(F.make({
    area: AREA.PROBE,
    name: 'Permission model',
    value: "the Probe's own gate, per capability, at the moment it acts",
    confidence: CONFIDENCE.PROVEN,
    via: VIA.SOURCE,
    evidence: 'LAIN adds no gate of its own; a refusal returns flagged as denied',
    at: SCHEMA_AT,
    notes: 'A denial is FINAL for that request. Do not retry it; ask the user.',
  }));

  return out;
}

/**
 * THE REPRESENTATION FACTS — proved by the declared examples and JSON's grammar.
 *
 * See the header. These are the ones a model otherwise establishes by sending
 * hexadecimal to a field that wanted a number and reading the failure.
 */
function representationFacts() {
  const out = [];
  const schema = advertisedSchema();
  const example = paramsExample(schema);

  // The proof depends on the declared example actually saying this. If the
  // schema text changes, the fact degrades rather than silently going stale.
  const saysPidNumber = /"pid"\s*:\s*\d+/.test(example);
  const saysAddressHexString = /"address"\s*:\s*"0x[0-9a-f]+"/i.test(example);

  out.push(saysPidNumber
    ? F.make({
      area: AREA.PROBE,
      name: 'PID',
      value: `${REPR.DECIMAL} (JSON number)`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      examples: ['16296', '{ "pid": 16296 }'],
      counterExample: '0x3FA8 — not a JSON number at all; the JSON grammar has no hexadecimal literal',
      scope: 'params.pid on Probe operations',
      evidence: `the advertised schema documents ${example.match(/\{[^}]*"pid"[^}]*\}/)[0]}, and a JSON number `
        + 'cannot be hexadecimal',
      at: SCHEMA_AT,
      notes: 'A PID is not an address. They differ in representation AND in JSON type, and are never '
        + 'interchangeable.',
    })
    : F.unknown({
      area: AREA.PROBE,
      name: 'PID',
      why: 'the advertised schema no longer documents a pid example, so its representation is not established here — '
        + 'ask probe(op:"capabilities", params:{of:"<operation>"})',
      scope: 'params.pid',
    }));

  out.push(saysAddressHexString
    ? F.make({
      area: AREA.PROBE,
      name: 'Memory address',
      value: `${REPR.HEX_STRING}`,
      confidence: CONFIDENCE.PROVEN,
      via: VIA.SCHEMA,
      examples: ['"0x1abc"', '{ "address": "0x7FF123456789" }'],
      counterExample: '7FF123456789 as a number — addresses are transported as STRINGS, and a 64-bit address '
        + 'exceeds what a JSON number represents exactly',
      scope: 'params.address on Probe memory operations',
      evidence: `the advertised schema documents ${example.match(/\{[^}]*"address"[^}]*\}/)[0]}`,
      at: SCHEMA_AT,
      notes: 'An address is a quoted, 0x-prefixed string. A PID is an unquoted decimal number.',
    })
    : F.unknown({
      area: AREA.PROBE,
      name: 'Memory address',
      why: 'the advertised schema no longer documents an address example — '
        + 'ask probe(op:"capabilities", params:{of:"<operation>"})',
      scope: 'params.address',
    }));

  // ---- WHAT THE REPOSITORY GENUINELY CANNOT SETTLE -----------------------
  //
  // Offsets, scan ranges, byte representation, exit codes and target naming are
  // the PROBE's contract, and the Probe is not in this tree. Each is recorded
  // as UNKNOWN with the exact call that answers it. That is the difference
  // between a model asking one question and a model running four experiments.
  for (const [name, scope] of [
    ['Offset representation', 'params.offset'],
    ['Scan range representation', 'params.range / params.start / params.end'],
    ['Byte / value representation', 'params.value and read results'],
    ['Target naming and authorization', 'process selection'],
    ['Error format and exit codes', 'Probe responses'],
  ]) {
    out.push(F.unknown({
      area: AREA.PROBE,
      name,
      scope,
      why: 'this belongs to the Probe, whose source is not in this repository. It is answered exactly by '
        + 'probe(op:"capabilities", params:{of:"<operation>"}), which returns that operation\'s real schema. '
        + 'Do not infer it from the PID or address facts above — they do not generalise.',
    }));
  }

  return out;
}

/**
 * What a CONNECTED Probe says about itself, at no cost.
 *
 * Read from the capability list captured during the connect handshake, so this
 * makes no additional call and has no side effect. The per-operation schema is
 * still a separate request, and still the model's to make when it needs one.
 */
function liveFacts(live) {
  if (!live) return [];
  const caps = Array.isArray(live.capabilities) ? live.capabilities : [];
  if (!caps.length) return [];
  const names = caps.map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean);
  const groups = [...new Set(names.map((n) => String(n).split('.')[0]))].sort();
  return [F.make({
    area: AREA.PROBE,
    name: 'Operations offered',
    value: `${names.length} in ${groups.length} groups`,
    confidence: CONFIDENCE.PROVEN,
    via: VIA.RUNTIME,
    examples: [groups.join(', ')],
    evidence: 'the capability list this Probe sent during the connect handshake',
    at: 'src/probe.js',
    notes: 'Names are not guessable and change with the Probe version; this list came from the Probe itself.',
  })];
}

/**
 * State the Probe left on disk, which is evidence that it ran here before.
 *
 * Reported because it tells a model that this project HAS been instrumented,
 * and where the record is — not as a claim about the current session.
 */
function stateFacts(root) {
  const dir = path.join(root, '.lain-probe');
  let entries = null;
  try { entries = fs.existsSync(dir) ? fs.readdirSync(dir) : null; } catch { entries = null; }
  if (!entries || !entries.length) return [];
  return [F.make({
    area: AREA.PROBE,
    name: 'Probe state directory',
    value: '.lain-probe/',
    confidence: CONFIDENCE.PROVEN,
    via: VIA.FILESYSTEM,
    examples: [entries.slice(0, 6).join(', ')],
    evidence: `${entries.length} entries on disk in ${dir}`,
    notes: 'A Probe has run against this project before. The logs and findings there are prior evidence, '
      + 'not a statement about this session.',
  })];
}

/** Everything establishable about the Probe right now. */
function discover(root) {
  let live = null;
  try { live = require('./probe').live(); } catch { live = null; }
  // With no Probe tool registered at all there is nothing to say beyond the
  // state directory: the envelope facts describe a schema that is not offered.
  const registered = Boolean(advertisedSchema());
  if (!registered && !live) {
    return [
      ...stateFacts(root),
      F.unknown({
        area: AREA.PROBE,
        name: 'Probe contract',
        why: 'no Probe is connected, so the probe tool is not advertised in this session. '
          + 'The user starts one with /mcp probe; its contract is then read from the Probe itself.',
      }),
    ];
  }
  return [
    ...envelopeFacts(live),
    ...representationFacts(),
    ...liveFacts(live),
    ...stateFacts(root),
  ];
}

module.exports = { discover, envelopeFacts, representationFacts, liveFacts, stateFacts, advertisedSchema };
