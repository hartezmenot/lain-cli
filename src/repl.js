'use strict';

/**
 * THE INTERACTIVE SESSION LOOP — read, route, run, drain, shut down.
 *
 * Split out of app.js, which had grown past the god-object guard. The seam is
 * the one that file's own header draws: the App decides what ONE MESSAGE MEANS
 * and runs it — task identity, the system prompt, the turn, the completion
 * check. This owns the TERMINAL SESSION around that: opening the UI, wiring
 * every keystroke to an owner, holding the queue, and tearing down cleanly.
 *
 * They change for entirely different reasons. A new key binding is a change
 * here and nowhere else; a change to what a turn means is a change there and
 * nowhere else. Keeping both in one class is exactly how V1's repl.js reached
 * 17,511 lines.
 *
 * NOTHING HERE DECIDES ANYTHING ABOUT THE WORK. It routes input to the App and
 * draws what the App reports. There is no second task state, no second
 * classifier, and no model call.
 */

const { C } = require('./render');
const { Session } = require('./session');
const { Input } = require('./input');
const commands = require('./commands');
const { onInterrupt } = require('./interrupt');

async function start(app) {
  // TTY: the four-region UI. Pipe: the banner and linear output, unchanged.
  // A short splash on the NORMAL screen before the alternate buffer opens, so
  // launching from a shell shows what LAIN is and where it is pointed rather
  // than a terminal that abruptly becomes a full-screen app. It stays in the
  // scrollback after exit, which is where it belongs.
  if (process.env.LAIN_NO_TUI !== '1' && app.render.out.isTTY) app.splash();
  // BEFORE the alternate screen: discovery prints, and those lines belong in
  // the scrollback with the splash rather than flashing behind a UI that is
  // about to repaint over them.
  await app.prepare();

  // ---- THE DASHBOARD, BEFORE THE ALTERNATE SCREEN OPENS --------------------
  //
  // ON BY DEFAULT — `dashAutostart: false` in config.json is the way out. It was
  // opt-in first, on the reasoning that a CLI should not open a listening socket
  // for somebody who never asked; that holds up poorly against what it actually
  // binds — an OS-chosen port on 127.0.0.1, unreachable from the network,
  // serving a page that is a locked gate until a credential is proved.
  //
  // ANNOUNCED HERE AND NOWHERE ELSE, and the placement is the whole point. Two
  // wrong places were tried first:
  //
  //   IN CONTEXT, via render.notice — which put an address and a credential into the
  //     conversation on every single session, permanently, above the first thing
  // the user ever said. the design names those two as the examples of what must
  //     never be there.
  //   IN THE PANEL — which is the right home for `/dash` OUTPUT, but a panel
  //     that is already open at startup owns the keyboard, so Tab and Alt+N
  //     went to it instead of the workspace and the next command's output was
  //     refused because the band was occupied.
  //
  // Printed here it lands in the SCROLLBACK beside the splash, before the UI
  // exists: startup chrome, where a port number belongs. It is not in Context,
  // it is not a panel, it steals nothing, and it survives the session.
  //
  // FAILING TO START IS NOT FATAL. The REPL is the program; the dashboard is a
  // window onto it.
  if (!app.cfg || app.cfg.dashAutostart !== false) {
    try {
      const r = await require('./dash').start(app, { lan: Boolean(app.cfg.dashLan) });
      if (r.ok) {
        // THE STARTUP PASSWORD IS NOT PRINTED ONCE A CHOSEN ONE EXISTS: a
        // second, equally valid credential on every startup would make the
        // chosen password decorative.
        //
        // THE VALUE GETS ITS OWN ROW. This is ordinary scrollback written before
        // the UI exists, so nothing clips or wraps it for us and it has to fit a
        // 40-column terminal on its own. `  password <32 hex>` is 43 and wraps;
        // the label alone is 12 and the value alone is 34, so both fit. It used
        // to say `key` purely because that word is short — which is how the one
        // thing a person actually has to type ended up with a name nothing else
        // in the program used.
        const locked = require('./dashauth').configured(app.cfg);
        app.render.write(C.dim(`  dashboard ${r.urls[0]}\n`));
        if (locked) {
          app.render.write(C.dim('  password required\n'));
        } else {
          app.render.write(C.dim('  password\n'));
          app.render.write(C.dim(`  ${r.startupPassword}\n`));
        }
      } else {
        app.render.write(C.dim(`  dashboard  did not start: ${r.error} — /dash on to retry\n`));
      }
    } catch (e) {
      app.render.write(C.dim(`  dashboard  did not start: ${e.message} — /dash on to retry\n`));
    }
  }

  const tui = process.env.LAIN_NO_TUI === '1' ? false : app.ui.enable();

  // WHAT SURVIVED SINCE LAST TIME — one line each, only when there is
  // something to say. Session start is the first of the four places
  // reconciliation may run (doctor, explicit inspection, handover are the
  // others); here it is a COUNT, not a report — the runtime knows what
  // survived before the model reasons, and `/lain` has the detail.
  try {
    const root = app.session ? app.session.cwd : process.cwd();
    const lainstore = require('./lainstore');
    if (lainstore.has(root, 'architecture')) {
      const { report } = require('./reconcile').run(root);
      const bad = report.missing + report.damaged + report.drifted;
      if (bad) app.render.write(C.yellow(`  architecture: ${bad} recorded component(s) missing/damaged/drifted — /doctor\n`));
    }
    const orphans = require('./scratch').orphans(root, { exclude: app.session ? app.session.id : '' });
    if (orphans.length) app.render.write(C.yellow(`  ${orphans.length} unfinished turn(s) left findings behind — /lain\n`));
  } catch { /* startup chrome never blocks the session */ }

  if (!tui) app.banner();
  const input = new Input({ stdin: process.stdin, stdout: process.stdout });
  app.input = input;
  // In TUI mode the screen owns the input row; letting the reader echo too
  // would draw every character twice.
  input.echo = !tui;
  const promptStr = tui ? '' : C.green('› ');
  // Keys, in priority order. An open completion menu gets first refusal, then
  // the UI (modal panels, view tabs, scrolling); ↑/↓ mean HISTORY only when
  // nothing is open, which is why the two can never be confused.
  input.on('key', (k) => {
    app.disarmExit();              // any deliberate key clears the exit confirmation
    if (!tui) return;
    if (app.ui.completionKey(k)) return;
    if (app.ui.handleKey(k)) return;
    // Caret movement and history recall, once no menu has claimed the key.
    // The editor owns both, because both are about where the caret is.
    if (input.editKey(k)) { /* consumed by the line editor */ }
    // Enter on an empty line opens what the view offers; with text it SENDS.
    // ---- ENTER AGAIN MEANS "STEER NOW" ------------------------------------
    //
    // With something waiting and nothing typed, a second Enter promotes it: the
    // first press said "when you get a moment", the second says "as soon as you
    // safely can". Two presses of one key rather than a modifier nobody finds.
    //
    // IT HAS TO BE HERE. It was written on the `input` event first, which an
    // EMPTY line never reaches — an empty Enter is a KEY, handled below, and it
    // went to `workspaceSelect` instead. Verified against the real binary: the
    // steer queued correctly and the second Enter did nothing at all.
    else if (k === 'enter' && !input.line.trim()
             && Boolean(app.abort && !app.abort.signal.aborted)
             && !app.pendingAsk && app.steerQueue.length) {
      const n = app.promoteSteers();
      if (n) app.transient('info', `steering now — ${n} message(s) at the next step`);
    }
    else if (k === 'enter' && !input.line.trim()) app.ui.workspaceSelect();
    // Views move whether or not text is typed — requiring an empty line
    // disabled these exactly when you most want a look at the diff. Completion
    // had first refusal above; the editor never inserts a literal tab.
    else if (k === 'tab' || k === 'shift-tab') app.ui.nextView(k === 'tab' ? 1 : -1);
  });
  // THE MOUSE. Only ever asked for on a real terminal, and only in TUI mode:
  // a linear `lain -p` run has nothing to click, and enabling tracking there
  // would take text SELECTION away from the terminal for no gain.
  if (tui) input.enableMouse();
  input.on('mouse', (ev) => { app.disarmExit(); if (tui) app.ui.handleMouse(ev); });

  // ---- THE CLIPBOARD -----------------------------------------------------
  //
  // The reader emits an INTENTION — copy this, cut this, give me the
  // clipboard — because a byte-stream decoder has no business spawning
  // `clip.exe`. The app owns the system clipboard already (copy.js), so it
  // answers, and there is one implementation of "put text on the clipboard"
  // in the program rather than two.
  input.on('clipboard', (ev) => {
    app.disarmExit();
    const clip = require('./copy');
    if (ev.action === 'copy' || ev.action === 'cut') {
      const r = clip.toClipboard(ev.text);
      // SAID, EITHER WAY. A copy that silently did nothing is indistinguishable
      // from one that worked until the paste fails somewhere else entirely.
      app.transient(r.ok ? 'info' : 'warn', r.ok
        ? `copied ${ev.text.length} character(s)`
        : `could not copy: ${r.error}`);
      return;
    }
    if (ev.action === 'paste') {
      const text = clip.fromClipboard();
      if (!text.ok) { app.transient('warn', `could not paste: ${text.error}`); return; }
      // THROUGH THE READER, so it is one edit on the one line, with the paste
      // flag set exactly as a bracketed paste would set it.
      input.insertText(text.text, { pasted: true });
    }
  });
  input.on('edit', (text, meta) => {
    app.disarmExit();              // typing means the user is staying, not leaving
    if (!tui) return;
    // A letter the completion overlay advertises is a shortcut, not typing.
    if (app.ui.completionShortcut(text)) { input.setLine(''); return; }
    // Likewise a letter an OPEN PANEL advertises — `D` for details on the
    // session browser. The panel claims it or it is typed; see panel.shortcut.
    if (app.ui.panelShortcut(text)) { input.setLine(''); return; }
    app.ui.setInput(text, input.cursor);
    // The menus follow TYPING. A paste is content arriving in the box, so it
    // is shown and nothing is offered on the strength of it.
    app.ui.updateMenus(text, meta || {});
  });
  // Enter is the menu's while a menu is open, and the line's otherwise.
  // Enter belongs to ANY open panel, not only a completion menu.
  //
  // The model browser filters as you type, so the filter text lives on the
  // input line — and with the old rule Enter submitted that text as a prompt
  // instead of choosing the highlighted model. Typing `sonnet` then Enter
  // narrowed 934 models to 50 and then sent the word "sonnet" to the model.
  //
  // A modal panel owns the keyboard while it is open; that is what modal
  // means. Completion menus are handled first by `completionKey`, so their
  // behaviour is unchanged.
  //
  // WITH ONE EXCEPTION, and it is the one that proves the rule: an ADVISORY is
  // not modal and was not opened by the user — LAIN raised it mid-turn. Nothing
  // is waiting on it, so Enter still sends the line.
  //
  // ---- A SECOND EXCEPTION: A PASSIVE PANEL IS NOT A QUESTION EITHER ---------
  //
  // OUTPUT is the other PASSIVE kind — `/status`, `/dash`, a finished `/model`
  // receipt, an error or rate-limit notice opened through `openSurface`. It has
  // no selectable row and nothing awaiting an answer (see outputAdapter: "Esc
  // close" is the whole contract), so routing Enter to it went through
  // `panel.select()`, found nothing to select, and did NOTHING — Escape was
  // the only way out, and typing a command then pressing Enter was silently
  // swallowed by a box that could not hear it. That is the "Enter closes, a
  // second Enter submits" complaint: the first Enter did not even close it.
  //
  // Closed HERE, before the keystroke is routed anywhere, so the SAME Enter
  // that dismisses it also falls through to the ordinary submit path below —
  // one action, not two. An empty line then reads as a plain Enter with no
  // panel open, which is exactly "just close it" for that case.
  input.enterGoesToUI = () => {
    if (!tui || !app.ui.panel.visible) return false;
    if (app.ui.panel.isAdvisory) return false;
    if (app.ui.panel.isPassive) { app.ui.panel.close(null); app.ui.refresh(); return false; }
    return true;
  };

  const queue = [];
  let closed = false;
  let waiter = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };

  input.on('input', (ev) => {
    app.disarmExit();
    // A COMMAND TYPED DURING A TURN runs now, for the same reason a command
    // chosen from the palette does: the REPL loop is parked inside the turn,
    // so anything queued here waits for work the user is explicitly trying to
    // look away from. When nothing is running the ordinary queue is used and
    // behaviour is unchanged — this is a bypass for one situation, not a
    // second input path.
    // A TURN IS ACTIVE, OR ONE IS ON ITS WAY.
    //
    // `app.abort` alone was the test, and it has a hole in it: a line taken off
    // the queue now passes through the input gateway before `submit` mints the
    // controller, and everything typed inside that window read as "nothing is
    // running". With piped input the entire script lands in that window — the
    // lines that should have steered were queued instead, and the loop that
    // drains the queue was by then waiting for a turn that was waiting for an
    // answer sitting in the queue. See App.dispatching.
    const turnActive = Boolean(app.abort && !app.abort.signal.aborted) || app.dispatching > 0;
    // AN ANSWER NEVER QUEUES. Something inside the turn is awaiting this
    // line — ask_user's "Other…", or a review pasted back for the external
    // human relay — and the REPL loop that drains the queue is parked inside
    // that very turn. Queued, the answer would wait for the work that is
    // waiting for it, which is a deadlock the user experiences as "I pasted
    // it and nothing happened".
    if (app.pendingAsk && app.answerPending(ev.text)) return;
    if (turnActive && !ev.isPaste && !app.pendingAsk
        && commands.looksLikeCommand(ev.text)
        // ONLY the safe ones jump the queue. A blocked command stays in the
        // queue and runs when the turn finishes, which is the plain reading
        // of "wait for it to finish" — and is what keeps `/exit` from racing
        // a turn it is meant to outlive. Running one here instead let `/exit`
        // set wantExit while the model was mid-question, and the session tore
        // down around an open panel.
        && !commands.blockedDuringTurn(commands.parse(ev.text).name)) {
      Promise.resolve(commands.run(app, ev.text)).catch((e) => {
        app.render.notice('error', `${ev.text}: ${e && e.message}`);
      });
      return;
    }
    // ---- ANYTHING ELSE TYPED AT A WORKING LAIN IS A STEER — ----------
    //
    // It used to go in the queue, which meant it waited for the turn to end
    // and then started A WHOLE NEW TASK. "also check the backend" is almost
    // never a new task; it is a correction to the one you are watching, and
    // treating it as a task is how a correction arrives too late to correct
    // anything.
    //
    // QUEUED, NOT INJECTED. It goes to the pending region and reaches the
    // model at a safe point — never in the middle of a tool call. See
    // ui/pending.js for why it is a region rather than a line in the
    // conversation.
    //
    // (The second Enter that promotes a waiting steer is handled on the KEY
    // event — an empty line never reaches this one. See the `enter` branch in
    // the key handler above.)
    if (turnActive && !app.pendingAsk && app.queueSteer(ev.text)) return;
    queue.push(ev);
    wake();
  });
  input.on('close', () => {
    closed = true;
    // AND THE APP IS TOLD, because a question asked AFTER this point can never
    // be answered either. See UI.askUser: cancelling only what is already open
    // leaves a later ask parked forever on a stream nobody can type into.
    app.inputClosed = true;
    // An open panel awaits a selection. On EOF nothing will ever resolve it,
    // so the loop would never drain and the session would never be saved.
    // Cancel it — end of input is an answer of "no answer".
    if (app.ui.panel.visible) app.ui.panel.close(null);
    if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
    wake();
  });
  input.on('interrupt', () => {
    // WORKING means a request or tool is genuinely in flight — an already
    // aborted controller that is still unwinding does not count, so a second
    // Ctrl+C during teardown can reach the exit confirmation rather than
    // firing another cancel.
    const working = Boolean(app.abort && !app.abort.signal.aborted);
    const d = onInterrupt({ working, armedAt: app._exitArmedAt }, Date.now());
    if (d.action === 'cancel') {
      // SHOWN BEFORE THE UNWIND, not after it. Aborting a request in flight
      // takes as long as it takes; without this the screen sat unchanged and
      // the user could not tell whether Ctrl+C had registered at all.
      if (app.ui.enabled) {
        // A panel open over the work must not survive the cancellation — it
        // would keep reporting NEEDS USER for a turn that is being torn down.
        if (app.ui.panel.visible) app.ui.panel.close(null);
        if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
        app.ui.setInterrupting(true);
      }
      app.abort.abort();
      app.render.notice('warn', 'interrupted');
      app.disarmExit();
      return;
    }
    if (d.action === 'exit') {
      app.disarmExit();
      // AN OPEN PANEL IS AWAITING AN ANSWER, and `wantExit` is only read by
      // the REPL loop — which is currently parked inside `await ui.ask(...)`.
      // Without releasing it, two Ctrl+C presses set a flag nobody was in a
      // position to notice, and the only way out of the model picker was
      // Escape first. Ctrl+C is global; a panel does not get to hold it.
      // (EOF already did exactly this; the exit path had been missed.)
      if (app.ui.enabled && app.ui.panel.visible) app.ui.panel.close(null);
      if (app.pendingAsk) { const r = app.pendingAsk; app.pendingAsk = null; r(null); }
      app.wantExit = true; closed = true; wake();
      return;
    }
    app.armExit();                 // first idle press: arm + hint, do NOT exit
  });

  input.start();

  // ---- IS THIS DIRECTORY MINE TO WORK ON? ---------------------------------
  //
  // AFTER `input.start()`, AND THAT ORDERING IS THE WHOLE THING.
  //
  // It sat in `app.prepare()` first, which runs before `ui.enable()` — no UI,
  // nobody to ask, and the question silently never appeared. Moving it to just
  // after `enable()` made it appear and then HANG: the panel opened and waited
  // for an answer while the keyboard reader did not yet exist, so nothing could
  // possibly answer it. LAIN started, drew a question, and froze.
  //
  // Both were found by driving the real binary; neither is visible from a unit
  // test, because a test calls `ensureTrusted` with a reader that is already
  // listening. The question needs a panel to be asked in AND a keyboard to be
  // answered with, and this is the first line where both exist.
  //
  // Asked once per directory and remembered — see trust.js for why this
  // persists where the desktop permissions deliberately do not.
  if (tui) {
    try { await require('./trustask').ensureTrusted(app); } catch { /* an unreadable config still runs */ }
  }

  // ---- A REJECTION MUST NOT END THE SESSION ------------------------------
  //
  // The REPL used to await every turn, so anything a turn threw was caught by
  // the loop. It no longer awaits, and a job's own handlers settle its record
  // rather than rethrowing — but "rather than" is a property of the code as it
  // stands today, and the cost of being wrong about it is the process dying
  // under a person who was typing. Node's default for an unhandled rejection
  // is to terminate.
  //
  // REPORTED, NOT SWALLOWED. It is shown as an error and, with LAIN_DEBUG, with
  // its stack — a quiet catch-all would hide the very bug it exists to survive.
  const onRejection = (reason) => {
    const msg = (reason && reason.message) || String(reason);
    try {
      app.render.notice('error', `unhandled error (the session is still running): ${msg}`);
      if (process.env.LAIN_DEBUG && reason && reason.stack) app.render.write(String(reason.stack) + String.fromCharCode(10));
    } catch { /* the renderer is gone; the session ending is worse than a lost line */ }
  };
  process.on('unhandledRejection', onRejection);

  // ---- SOMETHING MAY HAVE BEEN QUEUED WHILE NOBODY WAS AT THIS PROMPT ------
  //
  // A `/continue` sent from a phone, a stop asked for from a phone, a model
  // switch. The runtime WROTE THOSE DOWN and cannot act on them: running a turn
  // needs the transcript, the tools and the abort controller, and all three are
  // in this process. So this watches for them, and only while a bot is actually
  // configured - a machine with no remote control starts no timer at all.
  //
  // NOT AWAITED. Asking the runtime whether a bot exists must not delay the
  // first prompt by a socket round trip.
  Promise.resolve()
    .then(() => require('./remotecontrol').status())
    .then((s) => { if (s && s.available && s.configured) require('./remotewatch').start(app); })
    .catch(() => { /* no runtime, nothing queued, nothing to watch */ });

  input.prompt(promptStr);

  for (;;) {
    if (app.wantExit) break;
    if (!queue.length) {
      if (closed) {
        // ---- EOF DOES NOT MEAN THE WORK IS OVER ---------------------------
        //
        // THE REGRESSION THIS FIXES, and it was invisible to the unit tier.
        // The loop no longer awaits a turn, so on PIPED input — which closes
        // the moment the last line is written, and is how every smoke test and
        // every `lain < file` runs — the queue drained, `closed` was true, and
        // the session tore itself down WHILE THE TURN WAS STILL RUNNING. The
        // work was genuinely started and genuinely abandoned a millisecond
        // later; 55 smoke tests reported it as the model never having answered.
        //
        // An interactive terminal hid it completely: a person's stdin does not
        // close, so the loop simply parked on the waiter as it always had.
        //
        // So end of input ends the INPUT, not the session. Anything running is
        // waited for — no polling: each job resolves its own promise — and the
        // loop comes back round in case that work queued more.
        const running = app.jobs.running();
        if (running.length) { await Promise.all(running.map((j) => j.wait())); continue; }
        break;                                 // drained, closed, and idle = real EOF
      }
      await new Promise((r) => { waiter = r; });
      continue;
    }
    // ---- QUEUED WORK STILL RUNS IN ORDER -----------------------------------
    //
    // THE SECOND HALF OF NOT AWAITING, and it is the half that bit. Interactively
    // this queue is EMPTY while a job runs: text typed during one becomes a
    // steer and a safe command runs on the spot, so nothing reaches here. But
    // PIPED input arrives all at once — `lain < script`, and every smoke test —
    // and the loop, no longer waiting for anything, drained the whole file into
    // a turn that had only just started. `/plan step` then ran DURING the turn,
    // was refused as blocked-during-a-turn, and the plan it was supposed to
    // build never existed. 55 smoke tests reported it as the model misbehaving.
    //
    // So the ORDER a person wrote things in is honoured: while the conversation
    // is working, the next queued line waits for it. This is not the defect
    // coming back — the defect was the PROMPT waiting, and the prompt does not
    // pass through here. `handle` returns the moment work begins and
    // `input.prompt()` is called immediately after; the reader was never
    // blocked at any point, before or after this change.
    if (queue.length) {
      const primary = app.jobs.primary();
      if (primary) { await primary.wait(); continue; }
    }
    const ev = queue.shift();
    try {
      if (tui) app.ui.setInput('');
      // ---- THE LINE THAT USED TO BLOCK THE WHOLE INTERFACE ----------------
      //
      // This was an await on the whole turn. The keyboard reader is
      // event-driven and never stopped, so the input LINE stayed editable -
      // which is what made the defect so hard to see. What stopped was the
      // DRAIN: nothing came off this queue until the turn resolved, so work
      // submitted during a six-second tool call did not START until that call
      // was over.
      //
      // `handle` now returns as soon as the work has BEGUN. A COMMAND still
      // runs to completion here - commands are fast, they are about LAIN
      // rather than about the work, and several depend on running in the order
      // they were typed. A TASK returns a job.
      //
      // NOTHING ELSE ABOUT A TURN CHANGED. `submit` is untouched and still
      // awaits; it is awaited by the job now instead of by this loop, and the
      // busy flag is set by the job rather than bracketed here. See
      // src/jobrunner.js.
      await app.handle(ev.text, { isPaste: ev.isPaste, from: ev.from, background: true });
    } catch (e) {
      // A bug in LAIN must not end the session.
      app.render.notice('error', `internal error: ${e && e.message}`);
      if (process.env.LAIN_DEBUG) app.render.write(String(e && e.stack) + '\n');
    }
    if (!app.wantExit) input.prompt();
  }

  input.stop();
  // ---- NOTHING KEEPS WORKING AFTER THE SESSION ENDS ----------------------
  //
  // A background job holds a provider request, a tool and a forked session.
  // It must not outlive the terminal that started it - the same rule the
  // shell jobs and the desktop bridge already follow below.
  try { app.jobs.cancelAll('the session ended'); } catch { /* none started */ }
  // A listening socket and a desktop bridge must not outlive the session that
  // opened them — a dashboard still answering after LAIN exits, or a bridge
  // still holding a grant, is exactly the thing nobody remembers turning off.
  try { require('./dash').stop(); } catch { /* was not running */ }
  if (app._desktop) app._desktop.bridge.close('the session ended');
  try { require('./controlwindow').close(app); } catch { /* no window */ }
  process.removeListener('unhandledRejection', onRejection);
  app.ui.disable();                       // restore the user's terminal
  try { app.session.save(); } catch { /* best effort on the way out */ }
  app.render.nl();
  // The REAL persisted session id — never a fresh one generated at exit.
  // The SHORT token, not the filename. It resolves to this exact session (see
  // Session.match) — a shorter thing to type, not a different thing.
  app.render.write(C.dim('  Session saved.') + '\n\n');
  app.render.write(C.dim('  Resume with:') + '\n');
  app.render.write(`    lain --resume ${Session.shortId(app.session.id)}` + '\n');
  return app.exitCode;
}

module.exports = { start };
