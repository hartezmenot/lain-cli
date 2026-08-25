'use strict';

/**
 * Slash commands, and the single authority on WHAT COUNTS AS ONE.
 *
 * V1 dispatched on the first character of the input, before it knew anything
 * about pastes. V2 requires all three of:
 *
 *   1. the input is a SINGLE line (a 40-line paste is never a command)
 *   2. it starts with '/'
 *   3. its first token is a REGISTERED command name
 *
 * So `/usr/local/bin/node --version` pasted as a note is content, a pasted diff
 * beginning with `/*` is content, and an unknown `/frobnicate` is content rather
 * than an error — LAIN does not get to decide the user meant a command when no
 * such command exists.
 *
 * The registry is also the duplicate check: V1 shipped two `case '/status'`
 * branches in one switch, the second unreachable, while an unused validator that
 * would have caught it sat in the tree. Here a duplicate name throws at load.
 */

const path = require('path');
const { Session } = require('./session');
const { C } = require('./render');
const toolRegistry = require('./tools');
const providerMod = require('./provider');
const config = require('./config');
// The catalog and connection modules moved out with the route commands; this
// file no longer knows what a route is.

const REGISTRY = new Map();

/**
 * MAY THIS COMMAND RUN WHILE A TURN IS IN FLIGHT?
 *
 * The user must be able to look things up without stopping the work — that is
 * the whole point of being able to open the palette mid-task. But a turn owns
 * the session, its messages and the files on disk, and a command that rewrites
 * those from underneath it is a corruption, not a convenience.
 *
 * So each command declares which it is, and the answer is enforced in one
 * place. `blocked` commands are not silently dropped and do not hang: they say
 * what they are waiting for.
 */
const DURING_TURN = Object.freeze({
  SAFE: 'safe',        // reads state, or changes only what the NEXT turn reads
  BLOCKED: 'blocked',  // would rewrite the session, the plan or the working tree
});

/**
 * `surface: true` — THIS COMMAND TALKS ABOUT LAIN'S OWN MACHINERY.
 *
 * THE LINE, and it took getting wrong once to find it. `/dash` printing a URL
 * and a token into the conversation is pollution: nobody said it to the model,
 * the model will never read it, and it is of no interest ten minutes later. So
 * that goes to the command panel and out of Context.
 *
 * But `/plan done` answering "not complete — nothing has been run to check" is
 * NOT machinery. It is the work: a statement about the task, in the record of
 * the task, which the next turn and the person reading back both need. The
 * first version of this routed EVERY command to the panel and put that sentence
 * in a box that closes on Esc — the task's own history, discarded on a
 * keystroke.
 *
 * So the test is not "is this a command" but "is this about LAIN or about the
 * work". Machinery — routes, models, the dashboard, compaction, the bridge —
 * opts in. Everything about the task or the project stays in Context, which is
 * the default because getting it wrong that way is merely untidy, while getting
 * it wrong the other way loses the record.
 */
/**
 * HOW LONG A MACHINERY NOTICE STAYS BEFORE CLEARING ITSELF.
 *
 * THE DEFAULT IS TO CLEAR. "Model changed", "unchanged", "effort high",
 * "compacted 296k -> 294k" are NOTIFICATIONS: you asked for something, this
 * says what happened, and there is nothing further to do with it. Requiring Esc
 * to dismiss your own confirmation is a keystroke that buys nothing, and until
 * you remember to press it the box sits over the conversation.
 *
 * Long enough to read a sentence unhurried, short enough not to be in the way.
 * Esc still closes it immediately.
 *
 * A command whose output you actually READ - /dash, /status - opts out with
 * flashMs: 0 and waits to be dismissed.
 */
const FLASH_MS = 1500;
function define(name, { args = '', desc, run, duringTurn = DURING_TURN.SAFE, surface = false, flashMs = FLASH_MS }) {
  const key = name.toLowerCase();
  if (REGISTRY.has(key)) throw new Error(`duplicate command: ${key}`);
  REGISTRY.set(key, { name: key, args, desc, run, duringTurn, surface, flashMs });
}

/** True when this command must wait for the active turn to finish. */
function blockedDuringTurn(name) {
  const c = REGISTRY.get(String(name || '').toLowerCase());
  return Boolean(c && c.duringTurn === DURING_TURN.BLOCKED);
}

/** All three conditions, in one place. */
function looksLikeCommand(input) {
  const s = String(input == null ? '' : input);
  if (s.includes('\n')) return false;            // multi-line input is content
  const t = s.trim();
  if (!t.startsWith('/')) return false;
  const first = t.split(/\s+/)[0].toLowerCase();
  return REGISTRY.has(first);
}

function parse(input) {
  const t = String(input).trim();
  const parts = t.split(/\s+/);
  return { name: parts[0].toLowerCase(), args: parts.slice(1), rest: t.slice(parts[0].length).trim() };
}

async function run(app, input) {
  const { name, args, rest } = parse(input);
  const cmd = REGISTRY.get(name);
  if (!cmd) return; // unreachable via looksLikeCommand, kept honest anyway
  // THE ONE GATE. A turn is in flight exactly when there is a controller that
  // could still abort it. A blocked command SAYS SO rather than hanging or
  // half-applying: the user gets a sentence and their turn keeps running.
  const turnActive = Boolean(app.abort && !app.abort.signal.aborted);
  if (turnActive && cmd.duringTurn === DURING_TURN.BLOCKED) {
    app.render.notice('warn',
      `${cmd.name} can't run while a turn is in flight — it would change the session under it. `
      + 'Press Ctrl+C to stop the turn first, or wait for it to finish.');
    return;
  }

  // ---- WHERE THE COMMAND'S OUTPUT GOES ------------------------------------
  //
  // Machinery goes to the command panel — the same one `/` and `/model` open —
  // and never into Context. Everything about the TASK stays in Context, because
  // that is the record of the work. See `define` for where the line is drawn.
  if (!cmd.surface) return cmd.run(app, { args, rest });
  app.render.openSurface(cmd.name);
  try {
    return await cmd.run(app, { args, rest });
  } finally {
    // `flashMs` MARKS A RECEIPT — output that confirms an action the user just
    // took deliberately, and so clears itself rather than waiting for an Esc
    // that buys nothing. Anything you READ (`/dash`, `/status`) has no flashMs
    // and stays until dismissed. See Renderer.doneSurface.
    app.render.doneSurface({ closeAfterMs: cmd.flashMs || 0 });
  }
}

// ------------------------------------------------------------- commands ----


// Leaving mid-turn would abandon work in flight, so it is BLOCKED and says so
// rather than half-happening. Ctrl+C twice is the way to leave right now.
const LEAVE = 'Save the session and leave (Ctrl+C twice to leave immediately)';
define('/exit', { duringTurn: DURING_TURN.BLOCKED, desc: LEAVE, run(app) { app.wantExit = true; } });
define('/quit', { duringTurn: DURING_TURN.BLOCKED, desc: LEAVE, run(app) { app.wantExit = true; } });


define('/status', {
  // READ, not glanced at: a dozen facts you look through. It waits for Esc.
  flashMs: 0,
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  desc: 'Session, provider and tool state',
  run(app) {
    app.render.write('\n' + C.bold('Status') + '\n');
    for (const [k, v] of require('./diagnose').statusRows(app, { dim: C.dim })) {
      app.render.write('  ' + k.padEnd(16) + v + '\n');
    }
  },
});

/**
 * `/tokens` — WHERE THE INPUT WENT, for the requests this turn actually made.
 *
 * THE CONDITION THIS EXISTS FOR was reported as requests of 325,000-343,000
 * input tokens against a few hundred output, exhausting a rate limit in
 * minutes. Nothing inside LAIN could say why: `usage.inputTokens` is one number
 * handed back after the fact, and it cannot tell a system prompt from a tool
 * schema from the ninth replay of a file read an hour ago.
 *
 * So token growth is now EXPLAINABLE rather than merely observable. The
 * breakdown is measured at the one place the transmitted array exists
 * (contextfit.js) and kept on the turn record; this reads it back.
 */
const EOL = String.fromCharCode(10);

define('/tokens', {
  flashMs: 0,
  surface: true,
  desc: 'What the recent requests cost, and of what',
  run(app) {
    const w = (s) => app.render.write(s);
    const turns = (app.session && app.session.turns) || [];
    // The finished turn's record is what the session keeps; a turn still in
    // flight has not been appended yet, which is why this reads the last
    // COMPLETED one rather than reaching into a running turn's state.
    const audits = (turns.length && turns[turns.length - 1].audits) || [];
    w(EOL + C.bold('Token accounting') + C.dim('  — estimated from characters; see src/tokenaudit.js') + EOL);
    if (!audits.length) {
      w(C.dim('  no request has been measured yet in this session.' + EOL));
      return;
    }
    const ta = require('./tokenaudit');
    // THE LAST FEW, NEWEST LAST, because the question is always about the
    // request that just happened and how it compares with the one before it.
    for (let i = 0; i < audits.length; i++) {
      for (const line of ta.report(audits[i], { n: i + 1 })) w(C.dim('  ' + line) + EOL);
      w(EOL);
    }
    const last = audits[audits.length - 1];
    // AMPLIFICATION, MEASURED NOT ENFORCED: real provider requests the session
    // made per turn it recorded. A turn that needed N attempts (retries,
    // post-413 folds) shows here as N, because each attempt was admitted and
    // closed as its own request — requestadmission.test.js proves that count.
    const turnsAll = turns.filter((x) => x.usage && x.usage.requests > 0);
    if (turnsAll.length) {
      const reqs = turnsAll.reduce((a, x) => a + x.usage.requests, 0);
      const steps = turnsAll.reduce((a, x) => a + (x.steps || 1), 0);
      w(C.dim(`  amplification: ${reqs} request(s) over ${turnsAll.length} turn(s), ${steps} model step(s)`)
        + (reqs > steps ? C.yellow(` — ${reqs - steps} retry/fold attempt(s)`) : '') + EOL);
    }

    if (last && last.overBudget) {
      w('  ' + C.yellow('this request was over budget and was compacted before it was sent') + EOL);
    }
  },
});

/**
 * A PROBLEM WITHOUT A KNOWN CAUSE — trace it, do not guess.
 *
 * "The button doesn't turn on" is not automatically a coding task: it could be
 * config, a dead service, a stale display, or a real bug, and editing the first
 * suspicious file is how you fix the wrong thing. This forces the TROUBLESHOOT
 * workflow (see mode.js / prompt.js) for the description you give — narrow it
 * down with evidence, cheapest checks first, and say what has been ruled out.
 *
 * BLOCKED during a turn: it starts a turn of its own, and two turns cannot own
 * the session at once.
 */
define('/troubleshoot', {
  duringTurn: DURING_TURN.BLOCKED,
  args: '<what is going wrong>',
  desc: 'Trace a problem to its cause with evidence, and report it as a report',
  run(app, ctx) { return require('./troubleshoot').runCommand(app, ctx, { C }); },
});

/**
 * `/dash` LIVES IN dashcommand.js — it is the one command that runs a server,
 * and it carries the three decisions that go with that (network, actions,
 * autostart). It registers into THIS registry from the bottom of this file.
 */


/**
 * `/mcp` — the desktop bridge: connect it, see it, and take it away.
 *
 * The bridge is an EXTERNAL process the user configures; LAIN ships none and
 * automates nothing itself. `revoke` is the STOP button and is the one thing
 * here that cannot fail — it drops every grant immediately, and the next
 * desktop action is refused rather than the next session.
 */
define('/mcp', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  args: '[status|connect|revoke|disconnect|probe|stop probe]',
  desc: 'The desktop bridge and what it is currently allowed to do',
  async run(app, { args }) {
    const mcpMod = require('./mcp');
    const probeCmd = require('./probecommand');
    const { bridge, permissions } = app.desktop();
    const sub = String(args[0] || 'status').toLowerCase();
    const w = (s) => app.render.write(s);

    // ---- the Probe: a SEPARATE seam beside the desktop bridge.
    // It lives in probecommand.js; this is only the routing.
    if (probeCmd.handles(sub, args)) return probeCmd.run(app, sub, w, C);

    if (sub === 'connect') {
      if (!mcpMod.configured(app.cfg)) {
        w('  ' + C.yellow('✕ NOT CONFIGURED') + C.dim(' — add mcp.command to ' + require('./config').configFile() + ':\n'));
        w(C.dim('    { "mcp": { "command": ["node", "C:\\\\path\\\\to\\\\bridge.js"] } }\n'));
        w(C.dim('    The bridge is a separate program you provide. LAIN automates nothing itself.\n'));
        return;
      }
      w(C.dim('  starting the bridge…\n'));
      const r = await bridge.connect();
      if (!r.ok) { w('  ' + C.red('✕ ' + r.state) + C.dim(` — ${r.reason}\n`)); return; }
      w('  ' + C.green('✓ CONNECTED') + C.dim(`  ${r.info.name}${r.info.version ? ' ' + r.info.version : ''}\n`));
      w(C.dim(`    capabilities: ${r.capabilities.join(', ') || 'none advertised'}\n`));
      w(C.dim('    nothing is permitted yet — you are asked at the moment each one is needed.\n'));
      return;
    }
    if (sub === 'revoke') {
      // Reaches the Probe too. A STOP handle that covers half the surface
      // is not a STOP handle.
      if (app._probe && app._probe.state === require('./probe').STATE.CONNECTED) {
        try {
          await app._probe.revoke();
          w('  ' + C.green('REVOKED') + C.dim('  the Probe permissions are gone') + '\n');
        } catch { /* the lines below still tell the truth */ }
      }
      const had = permissions.revoke('you revoked it');
      try { require('./controlwindow').update(app); } catch { /* no window */ }
      w(had.length
        ? '  ' + C.green('✓ REVOKED') + C.dim(`  ${had.join(', ')} — the next desktop action will be refused\n`)
        : C.dim('  nothing was granted; nothing to revoke.\n'));
      return;
    }
    if (sub === 'disconnect' || sub === 'stop') {
      bridge.close('you stopped it');
      try { require('./controlwindow').close(app); } catch { /* no window */ }
      w('  ' + C.green('✓ STOPPED') + C.dim(' — the bridge is closed and every grant is gone\n'));
      return;
    }

    const s = bridge.status();
    const ok = s.state === mcpMod.STATE.CONNECTED;
    w('\n' + C.bold('MCP') + '\n');
    // EVERY CONFIGURED SERVER, not only the one being talked to.
    //
    // A server that is present but switched off, and one that is present but
    // simply not the active bridge, are different facts from one that was never
    // configured — and showing only the active bridge made all three look
    // identical. See mcp.servers().
    const all = mcpMod.servers(app.cfg);
    const active = mcpMod.settings(app.cfg);
    if (all.length) {
      w(C.dim('  servers') + '\n');
      for (const srv of all) {
        const isActive = active && srv.id === active.id;
        const state = !srv.enabled ? C.dim('○ DISABLED')
          : isActive && ok ? C.green('✓ CONNECTED')
            : isActive ? C.yellow('⚠ ' + s.state)
              : C.dim('○ configured, not the active bridge');
        w('    ' + srv.id.padEnd(16) + state + '\n');
        w(C.dim('      ' + srv.command.join(' ').slice(0, 70)) + '\n');
      }
      w('\n');
    }
    w('  ' + 'Bridge'.padEnd(20) + (ok ? C.green('✓ CONNECTED') : s.configured ? C.yellow('⚠ ' + s.state) : C.red('✕ NOT CONFIGURED')) + '\n');
    if (!ok && s.reason) w('  ' + 'Reason'.padEnd(20) + C.dim(s.reason) + '\n');
    if (s.name) w('  ' + 'Process'.padEnd(20) + C.dim(s.name) + '\n');
    const perms = s.permissions.capabilities || {};
    for (const [cap, state] of Object.entries(perms)) {
      const label = cap[0].toUpperCase() + cap.slice(1);
      w('  ' + label.padEnd(20)
        + (state.granted
          ? C.green('✓ ALLOWED') + C.dim(`  ${Math.ceil(state.msLeft / 1000)}s left · ${state.scope}`)
          : C.dim('— ' + state.why)) + '\n');
    }
    w('  ' + 'Target'.padEnd(20) + C.dim(s.target || '—') + '\n');
    // CAN LAIN ACTUALLY LOOK AT THE SCREEN RIGHT NOW? A different question from
    // "is a bridge configured", and the one that decides whether a UI change
    // can be visually VERIFIED or merely made. It lives in computer.js because
    // it has to answer for EITHER transport and for the user's own refusals —
    // asked of one bridge, a Probe-only machine was told nothing could see.
    const vis = require('./computer').visualReadiness(app);
    w('  ' + 'Visual inspection'.padEnd(20)
      + (vis.ok ? C.green('✓ POSSIBLE') : C.dim('— ' + vis.why)) + '\n');
    if (s.activity.length) {
      w('\n' + C.dim('  recent\n'));
      for (const a of s.activity.slice(-6)) w(C.dim(`    ${a.ok ? '·' : '✕'} ${a.text}\n`));
    }
    await probeCmd.status(app, w, C);
    w(C.dim('\n  /mcp connect · /mcp revoke (stops everything now) · /mcp disconnect\n'));
    w(C.dim('  /mcp probe (runtime investigation) | /mcp stop probe') + '\n');
  },
});

/**
 * `/copy` — a LOCAL utility. It sends nothing to a model and starts no turn; it
 * puts something LAIN already knows on the system clipboard. See copy.js.
 */
/**
 * `/image` — LOOK AT ONE.
 *
 * "ASCII representation is not visual evidence." LAIN already
 * refuses to pretend — an image in a tool result is reported as a real path,
 * real dimensions and a real format, with NOT SEEN said plainly (ui/images.js).
 * That is honest, and on its own it is a dead end: the one thing a person wants
 * at that moment is to LOOK, and there was no way to.
 *
 * This is the other half. LAIN's own Chromium when one is running — it is the
 * browser LAIN owns, and the design says not to put LAIN's automation into the user's
 * session — and the machine's own viewer otherwise.
 *
 * With no argument it offers the images LAIN has seen mentioned, read from the
 * OUTPUT surface that already lists them rather than from a second record kept
 * for this.
 *
 * IT DOES NOT CLAIM ANYTHING WAS SEEN. Opening a window is not looking at one;
 * `visual_choice` is how a judgment is obtained.
 */
define('/image', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '[path]',
  desc: 'Open an image so you can actually look at it (a terminal cannot show one)',
  async run(app, { rest }) {
    const view = require('./imageview');
    let file = String(rest || '').trim().replace(/^["']|["']$/g, '');

    if (!file) {
      const seen = view.recent(app);
      if (!seen.length) {
        app.render.write(C.dim('  No images seen yet. /image <path> opens one.\n'));
        return;
      }
      if (seen.length > 1 && app.ui.enabled) {
        // THE ONE QUESTION SURFACE, never a second picker. See ui/answer.js.
        const picked = await app.ui.askUser({
          question: 'Which image?', options: seen, input: 'choice',
        });
        if (!picked) return;
        file = picked;
      } else {
        [file] = seen;
      }
    }

    const r = await view.open(app, file);
    if (!r.ok) {
      app.render.write('  ' + C.yellow('NOT OPENED') + C.dim(` — ${r.why}\n`));
      return;
    }
    const f = r.facts || {};
    const size = f.ok
      ? `${f.kind} ${f.width}×${f.height}, ${Math.round(f.bytes / 1024)} KB`
      : 'size unknown';
    // WHICH WINDOW IT IS IN MATTERS: one of them is LAIN's and one is the user's.
    app.render.write('  ' + C.green('OPENED') + C.dim(` in ${r.how} — ${size}\n`));
    app.render.write(C.dim(`    ${r.file}\n`));
  },
});



define('/copy', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  args: '[last|output|diff|audit|health|rc|troubleshoot|task|activity|context]',
  desc: 'Copy what you are looking at to the clipboard (local; costs nothing)',
  run(app, ctx) { return require('./copy').runCommand(app, ctx, { C }); },
});

define('/tools', {
  // MACHINERY: LAIN talking about itself, not about the work. Goes to the
  // command panel, never into the conversation the model reads.
  surface: true,
  // READ, not glanced at — it waits for Esc.
  flashMs: 0,
  desc: 'List the tools the model can call',
  run(app) {
    app.render.write('\n');
    for (const n of toolRegistry.names()) {
      app.render.write('  ' + n.padEnd(18) + C.dim(toolRegistry.isMutating(n) ? 'mutating' : 'read-only') + '\n');
    }
  },
});

define('/cwd', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  duringTurn: DURING_TURN.BLOCKED,
  args: '[dir]',
  desc: 'Show or change the working directory',
  run(app, { rest }) {
    if (!rest) { app.render.write('  ' + app.session.cwd + '\n'); return; }
    const next = path.resolve(app.session.cwd, rest);
    try {
      process.chdir(next);
      app.session.cwd = next;
      app.cwd = next;
      app.render.write(C.dim('  ' + next + '\n'));
    } catch (e) { app.render.notice('error', `cannot cd: ${e.message}`); }
  },
});

define('/task', {
  // NOT MACHINERY, for the same reason as /plan: the objective, the lifecycle
  // state and the evidence behind it ARE the work, and they belong in the
  // record of it rather than in a box that closes on Esc.
  desc: 'The active task, its lifecycle state and its evidence',
  run(app) {
    const t = app.session.task;
    if (!t) { app.render.write(C.dim('  No active task.\n')); return; }
    const w = (k, v) => app.render.write('  ' + String(k).padEnd(16) + v + '\n');
    app.render.write('\n' + C.bold('Task') + '\n');
    // A pasted objective is multi-line; collapse it so the table stays a table.
    const oneLine = t.objective.replace(/\s+/g, ' ').trim();
    w('objective', oneLine.slice(0, 90) + (oneLine.length > 90 ? '…' : ''));
    w('started', t.startedAt);
    const l = app.session.lifecycle;
    if (l) {
      const s = l.summary();
      w('state', s.state + (s.reason ? C.dim(` — ${s.reason}`) : ''));
      w('turns', String(s.turns));
      w('tool calls', String(s.toolCalls));
      w('files changed', String(s.filesChanged));
      w('commands run', String(s.commandsRun));
      w('repeats', String(s.repeatedObservations));
    }
    if (t.steers.length) {
      app.render.write('  ' + 'steers'.padEnd(16) + '\n');
      for (const s of t.steers.slice(-5)) app.render.write(C.dim(`      - ${s.text.slice(0, 90)}\n`));
    }
    const ev = app.session.evidence.digest(6);
    if (ev) app.render.write('\n  ' + ev.split('\n').join('\n  ') + '\n');
  },
});

define('/plan', {
  // NOT MACHINERY — and this was got wrong once already, by me, in the sweep
  // that moved every other command's output to the panel. `/plan done`
  // answering "not complete — nothing has been run to check" is a statement
  // ABOUT THE TASK, in the record of the task. Routed to the panel it sits in a
  // box that closes on Esc: the work's own history, discarded on a keystroke
  // and absent from the next turn's context. See the note on `surface` above,
  // and tests/smoke/surface.test.js, which exists because of it.
  duringTurn: DURING_TURN.BLOCKED,
  args: '[show|step <text>|done <note>|drop <n>|clear]',
  desc: 'The session-owned plan (optional — plans are never required)',
  run(app, ctx) { return require('./plan').runCommand(app, ctx, { C }); },
});

define('/config', {
  // MACHINERY: about LAIN, not about the work. Goes to the command panel.
  surface: true,
  desc: 'Show configuration (opens the interaction panel on a TTY)',
  async run(app) {
    // Reads the EXISTING config store. There is no second config system, and
    // nothing here is derived by asking a model.
    const keys = ['model', 'connection', 'effort', 'maxSteps', 'stream'];
    if (app.ui && app.ui.enabled) {
      const p = require('./ui/panel');
      const cat = app.catalog();
      // The editors REUSE the adapters the matching commands use, so there is
      // one model picker and one effort picker in the program, not three.
      const editors = {
        model: () => ({
          push: p.modelsAdapter({
            catalog: cat,
            current: app.cfg.model,
            onPickRoute: (model, conn, effort) => {
              app.cfg.model = model.id;
              app.cfg.connection = conn.connectionId;
              config.save(app.cfg);
            },
          }),
        }),
        // These two adapters only OFFER a value — their commands apply it after
        // `ask` returns. Reached from here nobody is waiting on that return, so
        // the choice is applied by the same rules the commands use.
        connection: () => ({
          push: {
            ...p.providerAdapter({
              connections: app.connections(),
              availabilityOf: (cid) => app.availability.get(cid).status,
            }),
            onSelect(item) {
              app.cfg.connection = item.value;
              config.save(app.cfg);
              return { close: item.value };
            },
          },
        }),
        effort: () => {
          const m = app.cfg.model ? cat.byId.get(app.cfg.model) : null;
          const conn = m && (app.cfg.connection ? m.connections.find((c) => c.connectionId === app.cfg.connection) : m.connections[0]);
          return {
            push: {
              ...p.effortAdapter({ available: conn ? conn.efforts : [], current: app.cfg.effort }),
              onSelect(item) {
                // `auto` is the ABSENCE of a pin, exactly as /effort treats it.
                app.cfg.effort = item.value === 'auto' ? null : item.value;
                config.save(app.cfg);
                return { close: item.value };
              },
            },
          };
        },
        // Applied in place: a toggle and a short cycle need no second screen.
        stream: (cfg) => { cfg.stream = !cfg.stream; config.save(cfg); },
        maxSteps: (cfg) => {
          // 0 IS ON THE LADDER, AND IT IS THE HOME POSITION. The default is no
          // limit: LAIN does not decide the model has worked long enough. A
          // number here is the USER capping their own spend, so the cycle
          // starts at "no limit" and returns to it.
          const ladder = [0, 10, 20, 30, 50, 100];
          const i = ladder.indexOf(Number(cfg.maxSteps) || 0);
          cfg.maxSteps = ladder[(i + 1) % ladder.length];
          config.save(cfg);
        },
      };
      await app.ui.ask(p.configAdapter({ cfg: app.cfg, keys, editors }));
      return;
    }
    app.render.write('\n' + C.bold('Config') + '\n');
    for (const k of keys) {
      const v = app.cfg[k];
      app.render.write('  ' + k.padEnd(18) + (v === null || v === undefined ? C.dim('auto') : String(v)) + '\n');
    }
    app.render.write(C.dim('\n  stored in ' + config.configFile() + '\n'));
  },
});


// THE ROUTE COMMANDS register into THIS registry, from their own file.
//
// `/models`, `/model`, `/effort`, `/api`, `/provider`, `/oauth` and `/external`
// are all one question — which model, through which connection — and this file
// had grown past the god-object guard carrying them alongside the session and
// workspace commands. It is a split of the FILE, not of the registry: there is
// still one map, one `define`, and one duplicate check. Registered last so a
// duplicate name still throws at load, exactly as before.
require('./sessioncommands').register({ define, REGISTRY, DURING_TURN, C });
require('./routecommands').register({ define, REGISTRY, C });
// THE WORKING-TREE COMMANDS do the same, for the same reason: /undo and
// /changes are one subject — the bytes on disk and how to put them back — and
// they read the ONE byte-snapshot system rather than keeping a record of their
// own. See workcommands.js.
require('./workcommands').register({ define, DURING_TURN, C });
// AND /dash, which left for a reason of its own: it is the only command that
// runs a SERVER, and the decisions that come with that — bind the network or
// not, allow actions or not, come up by itself or not — are its subject and
// nobody else's. See dashcommand.js.
require('./dashcommand').register({ define, C });
// AND /trust + /permissions, which are one subject — what this session may
// touch, and what it was stopped from touching. See trustcommand.js.
require('./trustcommand').register({ define, C });
// AND /jobs + /bg + /cancel, which are one subject — work in flight and what
// it is doing. All three are SAFE during a turn by construction: a command
// about running work that could not run while work was running would be
// useless. See jobcommands.js.
require('./jobcommands').register({ define, C });
// AND /runtime + /session + /rc — ONE subject: the process that outlives this
// one, and the windows onto it. rccommand.js registers /session too.
require('./runtimecommand').register({ define, C });
require('./rccommand').register({ define, C });
// AND /stop + /observing, whose subject is A RUN BEING WATCHED. `/stop` exists
// because "stop the bot" and "stop LAIN" were one key everywhere else, so
// stopping a misbehaving run meant risking the investigation of it. See
// observecommand.js.
require('./observecommand').register({ define, DURING_TURN, C });
// `/compact` uses the same context authority as the automatic path, in its own
// module so the command registry stays below the architecture guard.
require('./compactcommand').register({ define, DURING_TURN, C });
// `/lain` surveys what `.lain/` remembers — architecture, wiring, vocabulary,
// facts and unfinished turns — in its own module for the same reason.
require('./laincommand').register({ define, C });
// AND THE REPORT COMMANDS — /compare, /audit, /health, /ready, /doctor: read
// something and say what is true of it, changing nothing.

// `/note` — the one door into RUNTIME NOTES (this machine's observations; evidence-gated FACTS are .lain's). See notecommand.js
// it is one command and not four.
require('./notecommand').register({ define, C });
require('./reportcommands').register({ define, C, config });
// `/brief` — the engineering briefing. A report command by nature, but its own
// file because it orchestrates every instrument in the tree; see briefcommand.js
// for why it is not called `/steer`.
require('./briefcommand').register({ define, C });
// AND /help, which is a VIEW OF THIS REGISTRY rather than a family of
// commands: it renders what is defined here, plus the keys — which is the
// half that grew, because a key nobody is told about is a key that does not
// exist. See helpcommand.js.
require('./helpcommand').register({ define, REGISTRY, C });

module.exports = {
  REGISTRY, define, looksLikeCommand, parse, run,
  DURING_TURN, blockedDuringTurn,
  names: () => [...REGISTRY.keys()],
};
