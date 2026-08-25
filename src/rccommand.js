'use strict';

/**
 * `/rc` — REMOTE CONTROL.
 *
 * ------------------------------------------------------------------------
 * THE THREE LAYERS, and this command configures the seams between them.
 *
 *     Telegram        transport. Carries bytes and nothing else.
 *     local model     the voice. Turns "what's still running?" into a
 *                     capability name, and facts back into English.
 *     Rust Guardian   the authority. Owns sessions, turns, workers, routes,
 *                     tokens and every decision about them.
 *
 * A person sets up the first two here, once. The third was already running.
 *
 * ------------------------------------------------------------------------
 * THE TOKEN IS TYPED ONCE AND NEVER SEEN AGAIN.
 *
 * It is asked for through the same masked panel `/api` uses — `secret: true`,
 * which ui/inputbox.js draws as dots and ui/index.js keeps out of ↑/↓ history —
 * handed straight to the runtime, and registered with redact.js on the way past
 * so that any surface which somehow gets hold of it draws `123…dsaw` instead.
 *
 * It is never written to config.json, never added to the session, never in a
 * prompt, a handover packet or the transcript. It lives in the supervisor's own
 * store, which is where machine-scoped credentials belong.
 *
 * ------------------------------------------------------------------------
 * THIS COMMAND USED TO MEAN SOMETHING ELSE. `/rc` was LAIN's RC-READINESS
 * report; that is now `/ready`, unchanged, same engine. The two were never
 * related and the name went to the feature people would type it looking for.
 */

const rc = require('./remotecontrol');

/** How much of a runtime error is worth putting on one line. */
const MAX_ERROR = 200;

/** Endpoints a local model runner listens on by default, in the order they are
 * worth trying. Offered as a suggestion, never assumed to be there. */
const LOCAL_DEFAULTS = Object.freeze([
  { label: 'Ollama          http://127.0.0.1:11434/v1', baseUrl: 'http://127.0.0.1:11434/v1' },
  { label: 'LM Studio       http://127.0.0.1:1234/v1', baseUrl: 'http://127.0.0.1:1234/v1' },
  { label: 'llama.cpp       http://127.0.0.1:8080/v1', baseUrl: 'http://127.0.0.1:8080/v1' },
]);

/** Is this a route that runs on the user's own machine? */
function isLocal(baseUrl) {
  try {
    // `URL.hostname` KEEPS THE BRACKETS on an IPv6 literal — `[::1]`, not
    // `::1` — so a bare comparison against `::1` silently fails and a genuine
    // loopback endpoint is refused as remote. Stripped rather than compared
    // both ways, so one more IPv6 form later cannot reintroduce it.
    const h = new URL(String(baseUrl)).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * ASK FOR THE TOKEN, WITHOUT SHOWING IT.
 *
 * `secret: true` is the same flag `/api` sets and is read by the same two
 * places. The BUFFER is untouched — what is sent is the real token, and only
 * the drawing is masked.
 */
function tokenAdapter() {
  return {
    title: 'TELEGRAM BOT TOKEN',
    kind: 'ASK_USER',
    mode: 'EXPANDED',
    takes: 'TEXT',
    secret: true,
    options: [],
    question: 'Paste the bot token from @BotFather.',
    items: [
      { label: 'Paste the bot token from @BotFather.', selectable: false },
      { label: '', selectable: false },
      { label: 'It is masked as you type and is never written to history,', selectable: false },
      { label: 'the transcript, a prompt, a handover packet or a log.', selectable: false },
      { label: 'It is checked against Telegram before anything is stored.', selectable: false },
      { label: '', selectable: false },
      { label: 'Enter confirms. Esc cancels and stores nothing.', selectable: false },
    ],
    footer: 'Enter confirm · Esc cancel',
    onTyped(text) {
      const t = String(text == null ? '' : text).trim();
      return t ? { close: t } : undefined;
    },
  };
}

/** Which local model does the talking. */
function brainAdapter(rows) {
  return {
    title: 'WHICH LOCAL MODEL ANSWERS REMOTELY?',
    // THE SAME PLAIN LIST `/api` uses to pick a provider. `MODEL_SELECTION` is a
    // richer screen whose Enter handler reaches for `item.model` and drills into
    // routes; this list has neither, and borrowing that kind would have wired a
    // picker to logic about a thing it is not.
    kind: 'PROVIDER_SELECTION',
    mode: 'EXPANDED',
    items: [
      ...rows,
      { label: 'Skip — commands only, no plain English', value: '__skip__' },
    ],
    footer: '↑↓ select · Enter confirm · Esc cancel',
  };
}

function typedAdapter(title, question, hint) {
  return {
    title,
    kind: 'ASK_USER',
    mode: 'EXPANDED',
    takes: 'TEXT',
    options: [],
    question,
    items: [
      { label: question, selectable: false },
      { label: '', selectable: false },
      { label: hint, selectable: false },
      { label: '', selectable: false },
      { label: 'Enter confirms. Esc cancels.', selectable: false },
    ],
    footer: 'Enter confirm · Esc cancel',
    onTyped(text) {
      const t = String(text == null ? '' : text).trim();
      return t ? { close: t } : undefined;
    },
  };
}

function register({ define, C }) {
  // ---- /session BELONGS TO THIS FAMILY ------------------------------------
  //
  // It is the terminal's window onto the same session model the bot answers
  // `/session` with — same capability, same text, same runtime. Registering it
  // here keeps the family in one file, which is the pattern jobcommands.js and
  // workcommands.js already follow.
  require('./sessionview').register({ define, C });

  const w = (app, line) => app.render.write(`${line}\n`);

  /** The status block, used by bare `/rc` and by `/rc status` alike. */
  function show(app, s) {
    w(app, '');
    w(app, C.bold('  Remote Control'));
    w(app, '');
    if (!s.available) {
      w(app, C.dim('  No runtime is answering on this machine, so nothing is listening.'));
      w(app, C.dim('  Remote control lives in the supervisor, not in this terminal — it has to'));
      w(app, C.dim('  keep running after you close this window.'));
      w(app, '');
      w(app, C.dim('  Run  /rc connect  to set it up.'));
      w(app, '');
      return;
    }
    const link = String(s.link || 'STOPPED');
    const colour = link === 'LISTENING' ? C.green : (link === 'DEGRADED' || link === 'UNAVAILABLE' ? C.yellow : C.dim);
    w(app, `  Telegram:   ${colour(link)}`);
    if (s.bot_name || s.bot_username) {
      w(app, `  Bot:        ${s.bot_name || ''}${s.bot_username ? C.dim(`  @${s.bot_username}`) : ''}`);
    }
    w(app, `  Authorized: ${s.authorized_chats || 0} chat(s)`);
    // ---- THE VOICE, AND WHAT IT COSTS TO NOT HAVE ONE ---------------------
    w(app, `  Voice:      ${s.brain_configured
      ? `${C.green('local')}  ${s.brain_model || ''}${s.brain_endpoint ? C.dim(`  ${s.brain_endpoint}`) : ''}`
      : C.dim('none — commands work, plain English does not')}`);
    w(app, `  Authority:  ${C.dim('Rust Guardian — sessions, turns, workers, routes, tokens')}`);
    if (s.last_error) {
      w(app, `  Last error: ${C.yellow(String(s.last_error).slice(0, MAX_ERROR))}`);
    }
    if (s.transport === false) {
      w(app, C.yellow('  No HTTPS transport: curl was not found, so Telegram cannot be reached.'));
    }
    if (s.pairing_code) {
      w(app, '');
      w(app, '  Open your bot in Telegram and send:');
      w(app, `      ${C.bold(`/pair ${s.pairing_code}`)}`);
      w(app, C.dim('  The code is single-use and expires in ten minutes.'));
    }
    w(app, '');
    if (s.configured) {
      w(app, C.dim('  From Telegram:  /session  /status  /models  /tokens  /jobs  /continue  /stop'));
      w(app, C.dim('  Or just ask — "which projects are still running?"'));
      w(app, '');
      w(app, C.dim('  /rc pair       a fresh pairing code'));
      w(app, C.dim('  /rc model      choose the local model that answers'));
      w(app, C.dim('  /rc reconnect  restart the adapter, keep the credential'));
      w(app, C.dim('  /rc disconnect remove the credential and every authorization'));
      w(app, '');
    }
  }

  /** Choose the local model that does the talking. Returns true if one was set. */
  async function chooseBrain(app) {
    if (!app.ui || !app.ui.enabled) return false;
    // ---- THE CONNECTIONS THE USER ALREADY HAS -----------------------------
    //
    // NOT A NEW PROVIDER SYSTEM. LAIN already models "a place a model lives" as
    // a connection with a base URL; a local model is one of those with a
    // loopback host. Inventing a second registry for the same fact is how two
    // lists of endpoints come to disagree.
    let conns = [];
    try { conns = (app.connections() || []).filter((c) => isLocal(c.baseUrl)); } catch { conns = []; }
    const rows = [];
    for (const c of conns) {
      const models = Array.isArray(c.models) ? c.models : [];
      const first = models.length ? (models[0].id || models[0]) : '';
      rows.push({
        label: `${c.id}${first ? `   ${first}` : ''}${C.dim(`   ${c.baseUrl}`)}`,
        value: JSON.stringify({ baseUrl: c.baseUrl, model: String(first || ''), key: c.apiKey || '' }),
      });
    }
    for (const d of LOCAL_DEFAULTS) {
      if (conns.some((c) => String(c.baseUrl).startsWith(d.baseUrl))) continue;
      rows.push({ label: d.label, value: JSON.stringify({ baseUrl: d.baseUrl, model: '', key: '' }) });
    }
    rows.push({ label: 'Other…   (type an endpoint)', value: '__other__' });

    const picked = await app.ui.ask(brainAdapter(rows));
    if (!picked || picked === '__skip__') return false;

    let choice = { baseUrl: '', model: '', key: '' };
    if (picked === '__other__') {
      const url = await app.ui.ask(typedAdapter(
        'LOCAL MODEL ENDPOINT',
        'Which endpoint should remote questions be asked of?',
        'An OpenAI-compatible /v1 root, for example  http://127.0.0.1:11434/v1',
      ));
      if (!url) return false;
      choice.baseUrl = String(url).trim();
    } else {
      try { choice = JSON.parse(picked); } catch { return false; }
    }
    if (!choice.model) {
      const model = await app.ui.ask(typedAdapter(
        'LOCAL MODEL NAME',
        'Which model should answer?',
        'The name that runner uses, for example  qwen2.5:3b  or  llama3.2',
      ));
      if (!model) return false;
      choice.model = String(model).trim();
    }
    // ---- A REMOTE VOICE MUST RUN ON THIS MACHINE --------------------------
    //
    // Refused rather than warned about. The whole point of the conversational
    // layer being local is that an untrusted message from a chat is never sent
    // to somebody else's API; allowing a cloud endpoint here would quietly undo
    // that, and the user would have no way to notice.
    if (!isLocal(choice.baseUrl)) {
      w(app, C.yellow('  The remote voice must be a model on this machine.'));
      w(app, C.dim('  Messages from a chat are untrusted text; sending them to a hosted API'));
      w(app, C.dim('  would forward whatever a stranger typed at your bot. Nothing was changed.'));
      return false;
    }
    const r = await rc.setBrain(choice);
    if (!r.ok) {
      w(app, C.yellow(`  ${r.error}`));
      return false;
    }
    w(app, C.green(`  Voice: ${choice.model}`) + C.dim(`  ${choice.baseUrl}`));
    return true;
  }

  /** The first-time flow: token, proof, voice, pairing. */
  async function setup(app) {
    if (!app.ui || !app.ui.enabled) {
      w(app, C.yellow('  /rc needs the interactive panel to ask for a token safely.'));
      w(app, C.dim('  Without a terminal there is nowhere to type one that is not echoed first.'));
      return;
    }
    w(app, '');
    w(app, C.bold('  Remote Control'));
    w(app, '');
    w(app, '  Telegram is not connected.');
    w(app, C.dim('  Telegram carries the messages. A local model turns them into questions.'));
    w(app, C.dim('  The Rust runtime answers them — it is the only thing that knows anything.'));
    w(app, '');

    const token = await app.ui.ask(tokenAdapter());
    if (!token) { w(app, C.dim('  Cancelled. Nothing was stored.')); return; }

    w(app, C.dim('  Checking the token with Telegram…'));
    const r = await rc.connect(String(token).trim());
    if (!r.ok) {
      // ---- THE TOKEN IS NOT QUOTED BACK -----------------------------------
      w(app, C.yellow(`  ${String(r.error).slice(0, MAX_ERROR)}`));
      w(app, C.dim('  Nothing was stored.'));
      return;
    }
    const bot = r.remote || {};
    w(app, '');
    w(app, C.green('  ✓ Telegram connected'));
    w(app, `    Bot: ${bot.bot_name || ''}${bot.bot_username ? C.dim(`  @${bot.bot_username}`) : ''}`);
    w(app, '');

    await chooseBrain(app);

    w(app, '');
    w(app, '  One more step — the bot will not answer anybody it has not been introduced to.');
    w(app, '  Open it in Telegram and send:');
    w(app, '');
    w(app, `      ${C.bold(`/pair ${r.pairingCode}`)}`);
    w(app, '');
    w(app, C.dim('  Single-use, expires in ten minutes. /rc pair issues another.'));
    w(app, '');
  }

  define('/rc', {
    // MACHINERY: LAIN talking about its own plumbing. It goes to the command
    // surface and never into the conversation the model reads.
    surface: true,
    flashMs: 0,
    args: '[status|connect|pair|model|reconnect|disconnect]',
    desc: 'Remote control — a Telegram bot, answered by a local model, over the Rust runtime',
    async run(app, ctx) {
      const sub = String((ctx.args && ctx.args[0]) || '').toLowerCase();
      const s = await rc.status();

      if (sub === 'disconnect') {
        if (!s.available || !s.configured) {
          w(app, C.dim('\n  Nothing is connected.\n'));
          return;
        }
        // The confirm SCREEN this codebase already has — see ui/adapters.js.
        // A new yes/no pattern here would be a second convention for the same
        // question.
        if (app.ui && app.ui.enabled) {
          const yes = await app.ui.ask(require('./ui/adapters').confirmAdapter({
            question: 'Remove the bot credential and every authorized chat?',
            yes: 'Yes — disconnect',
            no: 'No — keep it',
          }));
          if (!yes) { w(app, C.dim('\n  Nothing was changed.\n')); return; }
        }
        const r = await rc.disconnect();
        w(app, '');
        if (!r.ok) { w(app, C.yellow(`  ${r.error}`)); w(app, ''); return; }
        w(app, C.green('  Disconnected.'));
        w(app, C.dim('  The credential and every authorization were removed from disk.'));
        w(app, C.dim('  A restart will not bring the bot back — /rc sets it up again.'));
        w(app, '');
        return;
      }

      if (sub === 'reconnect') {
        const r = await rc.reconnect();
        w(app, '');
        if (!r.ok) { w(app, C.yellow(`  ${r.error}`)); w(app, ''); return; }
        w(app, C.green('  Adapter restarted. The credential and authorizations are unchanged.'));
        show(app, { available: true, ...(r.remote || {}) });
        return;
      }

      if (sub === 'pair') {
        const r = await rc.pairCode();
        w(app, '');
        if (!r.ok) { w(app, C.yellow(`  ${r.error}`)); w(app, ''); return; }
        w(app, '  Send this to your bot in Telegram:');
        w(app, '');
        w(app, `      ${C.bold(`/pair ${r.code}`)}`);
        w(app, '');
        w(app, C.dim('  Single-use, expires in ten minutes.'));
        w(app, '');
        return;
      }

      if (sub === 'model' || sub === 'voice') {
        if (!s.available || !s.configured) {
          w(app, C.dim('\n  Connect a bot first — run /rc.\n'));
          return;
        }
        w(app, '');
        await chooseBrain(app);
        w(app, '');
        return;
      }

      if (sub === 'status') { show(app, s); return; }

      // BARE `/rc`: set it up, or say where it stands. Never ask for a token
      // that has already been given — §18.
      if (s.available && s.configured) { show(app, s); return; }
      if (sub === 'connect' || !sub) { await setup(app); return; }
      show(app, s);
    },
  });
}

module.exports = { register, isLocal, tokenAdapter, brainAdapter, LOCAL_DEFAULTS };
