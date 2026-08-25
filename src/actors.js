'use strict';

/**
 * THE EXTERNAL ACTORS — who, other than LAIN, is looking at this problem.
 *
 * `/external` used to mean "which OTHER MODEL from LAIN's catalog reviews an
 * investigation", and the whole of it was a model id in the config. That is the
 * wrong question at the top: a second opinion can arrive through a credential
 * LAIN holds, through a chat page the USER is logged into, or from a person
 * reading the packet in another window — and only the first of those is a model
 * in the catalog. Making "which model" the top-level question forced every
 * other kind of reviewer to be spelled as one, or to not exist at all.
 *
 * So the question is WHO, and the answer is one of these:
 *
 *   API       a model LAIN can reach itself, with a credential it holds.
 *             AUTOMATED: the packet goes out and the review comes back with no
 *             human in the loop. This is the only kind that is automated.
 *
 *   BROWSER   a chat page the USER drives — the ChatGPT temporary chat, say.
 *             LAIN prepares the packet and opens the page. It does NOT read
 *             the page, drive it, or take anything out of it.
 *
 *   HUMAN     any external conversation at all. The packet goes to the
 *             clipboard, and the reply is pasted back.
 *
 *   REVERSE   a reverse-engineering adapter. Declared so the seam is named and
 *             bounded; NOT CONFIGURED, with no implementation. See its status().
 *
 * WHAT IS DELIBERATELY NOT HERE. There is no page scraping, no unofficial
 * endpoint, no websocket interception, and no cookie or credential extraction.
 * BROWSER opens a URL and prepares text; everything after that is the user's
 * own hands. Pretending a web page is an API is exactly the lie this split
 * exists to prevent — `status().automated` is the field that says which kind
 * you have, and the relay reads it rather than guessing.
 *
 * ONE CONTROLLER, unchanged. Whatever the actor, it REVIEWS. It gets no tools,
 * it cannot call one, and its RECOMMENDATION is handed to LAIN's ordinary turn
 * loop as a request. See investigation.js.
 *
 * The reply is read into the same four sections however it arrived (see
 * external.js), so a pasted answer and an API answer are held to one standard —
 * including the check for a reviewer claiming to have ACTED.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const externalMod = require('./external');

/** WHO is reviewing. The kind decides how the packet travels, and nothing else. */
const KIND = Object.freeze({
  API: 'API',
  BROWSER: 'BROWSER',
  HUMAN: 'HUMAN',
  REVERSE: 'REVERSE',
});

/**
 * What each kind is called on screen.
 *
 * BROWSER WAS "Browser companion", and the word companion was the whole of the
 * lie. It named an architecture in which LAIN opened a page in whatever browser
 * the machine considered default, put a packet on the clipboard, and waited to
 * be handed a reply — a bookmark with a copy button, in which LAIN saw nothing.
 * That is not what this actor does. It drives LAIN's OWN Chromium, in LAIN's
 * own profile, types the packet in and reads the reply back off the page. The
 * clipboard is what it falls back to when that browser is not running, so the
 * label now names the thing rather than the fallback.
 */
const LABEL = Object.freeze({
  [KIND.API]: 'API model',
  [KIND.BROWSER]: "LAIN's browser",
  [KIND.HUMAN]: 'Human relay',
  [KIND.REVERSE]: 'Reverse-engineering adapter',
});

/**
 * The page a BROWSER companion opens. A TEMPORARY chat by default, because the
 * packet describes someone's source tree and it should not be training anything.
 */
/** How long a driven page is given to produce a settled reply. */
const REPLY_LIMIT_MS = 180_000;

const DEFAULT_BROWSER_URL = 'https://chatgpt.com/?temporary-chat=true';

// ---------------------------------------------------------------- the seam --

/**
 * The interface every actor answers to: send / receive / close / status.
 *
 * `send` DELIVERS the packet by whatever means the kind implies; `receive`
 * produces the review. They are separate because for a human the two are
 * separated by however long it takes to read — and a single `review()` that hid
 * that would make the automated and the manual case look alike, which is the
 * thing this whole file exists to keep apart.
 */
class ExternalActor {
  constructor(app, cfg = {}) {
    this.app = app;
    this.cfg = cfg;
    this.sent = null;          // the last packet delivered, verbatim
    this.closed = false;
  }

  get kind() { throw new Error('an actor must declare its kind'); }

  /** @returns {{kind,label,ok,why,automated,model,connection,maxRounds}} */
  status() { throw new Error('an actor must report its status'); }

  async send() { throw new Error('an actor must accept a packet'); }
  async receive() { throw new Error('an actor must produce a review'); }

  close() { this.closed = true; }

  /** send + receive — what the relay actually wants, in one call. */
  async review(packet, opts = {}) {
    const s = await this.send(packet, opts);
    if (s && s.ok === false) return s;
    return this.receive(opts);
  }

  /**
   * Read any reply into the four sections, however it arrived.
   *
   * A pasted review is held to the SAME standard as an API one: same section
   * parser, same overclaim check. A human-relayed model that writes "I ran the
   * tests" has no tools here either.
   */
  read(text, extra = {}) {
    const t = String(text || '').trim();
    if (!t) return { ok: false, error: 'nothing came back', ...extra };
    return {
      ok: true,
      text: t,
      sections: externalMod.sections(t),
      overclaim: externalMod.overclaims(t),
      ...extra,
    };
  }
}

// ------------------------------------------------------------------- API ----

/**
 * A model LAIN reaches itself. The ONLY automated actor.
 *
 * It delegates wholesale to external.js, which resolves through the same
 * catalog and connection machinery a turn uses. There is no second routing path
 * here and there must never be one — two of them could disagree about which
 * endpoint a request went to.
 */
class ApiActor extends ExternalActor {
  get kind() { return KIND.API; }

  status() {
    const s = externalMod.settings(this.cfg);
    const r = s.ok ? externalMod.route(this.app) : null;
    return {
      kind: KIND.API,
      label: LABEL[KIND.API],
      automated: true,
      ok: Boolean(r && r.ok),
      why: r && r.ok ? '' : (r ? r.why : s.why),
      model: s.model,
      connection: s.connection,
      maxRounds: s.maxRounds,
    };
  }

  async send(packet) {
    this.sent = String(packet || '');
    return { ok: true, delivered: 'api' };
  }

  async receive({ signal = null, onStatus = null } = {}) {
    return externalMod.ask(this.app, this.sent || '', { signal, onStatus });
  }
}

// --------------------------------------------------------- human / browser --

/**
 * A conversation LAIN does not hold: the packet goes OUT to the user, and the
 * reply comes back the same way.
 *
 * The packet reaches the clipboard through the tool the platform already ships
 * (see copy.js) and falls back to a real file on disk — never to an apology.
 * The reply is captured by `app.pendingAsk`, which is the ONE existing
 * mechanism for "the next line is an ANSWER, not a new task". Reusing it is
 * what keeps a pasted review from starting a task, mutating the plan or
 * resetting a step, and is why there is no second input path here.
 */
class HumanActor extends ExternalActor {
  get kind() { return KIND.HUMAN; }

  status() {
    const s = externalMod.settings(this.cfg);
    const interactive = Boolean(this.app.ui && this.app.ui.enabled);
    return {
      kind: this.kind,
      label: LABEL[this.kind],
      automated: false,
      // A relay you paste into needs no credential and no model — it needs
      // someone at the keyboard. On a pipe there is nobody.
      ok: interactive,
      why: interactive ? '' : 'a relay you paste into needs an interactive terminal',
      model: null,
      connection: null,
      maxRounds: s.maxRounds,
    };
  }

  /** Hand the packet to the user, and report exactly how it was handed over. */
  async send(packet) {
    this.sent = String(packet || '');
    const { toClipboard } = require('./copy');
    const r = toClipboard(this.sent);
    if (r.ok) return { ok: true, delivered: 'clipboard' };
    const file = path.join(os.tmpdir(), `lain-packet-${Date.now()}.txt`);
    try {
      fs.writeFileSync(file, this.sent, 'utf8');
      return { ok: true, delivered: 'file', file, why: r.error };
    } catch (e) {
      return { ok: false, error: `could not hand over the packet: ${r.error} / ${e.message}` };
    }
  }

  /** Wait for the pasted reply. Cancelling is an answer of "no answer". */
  async receive() {
    const app = this.app;
    if (!app.ui || !app.ui.enabled) {
      return { ok: false, error: 'no interactive terminal — a pasted review needs one' };
    }
    // END OF INPUT IS A STATE, NOT AN EVENT — the same rule UI.askUser follows,
    // and for the same reason: repl.js cancels a question that is already open
    // when stdin closes, and cannot cancel one asked a moment later. Parking on
    // a stream nobody can type into is a hang, not a wait.
    if (app.inputClosed) return { ok: false, error: 'input has ended — no review can be pasted back', cancelled: true };
    const text = await new Promise((resolve) => { app.pendingAsk = resolve; });
    if (text == null) return { ok: false, error: 'no review was pasted back', cancelled: true };
    return this.read(text, { model: LABEL[this.kind], connection: 'pasted by you' });
  }
}

/**
 * A PAGE LAIN ACTUALLY DRIVES, in a browser LAIN actually owns.
 *
 * This used to hand the packet to the clipboard and open a URL in whatever
 * browser the machine considered default — the USER's, with their tabs, their
 * logins and their forty other windows. That is not a browser actor; it is a
 * clipboard handoff with a bookmark, and it fails for four reasons that are all
 * the same reason: LAIN could not tell its own window from the user's, so it
 * could not observe one, could not interact with one safely, and every piece of
 * evidence that came back had no provenance.
 *
 * Now it drives an isolated Chromium with LAIN's own profile (see browser.js):
 * open the page, type the packet, wait for the reply to settle, read it out.
 * The user's own browser is never touched.
 *
 * ------------------------------------------------------------------------
 * IT IS STILL NOT AN API, and must never be described as one. It is a person's
 * chat session being driven mechanically, which means:
 *
 *   · the user logs in THEMSELVES, once, in that window. Nothing here reads a
 *     cookie, fills a credential, or copies storage anywhere. The profile
 *     persists so they only have to do it once.
 *   · a page that has changed its markup breaks this, and the honest answer
 *     then is that no reply was read — never a guess at one.
 *   · the reply is attributed to THE PAGE, never to a model from the catalog.
 *
 * FALLING BACK IS NOT FAILING. With no Chromium on the machine, it returns to
 * the clipboard relay it inherits from HumanActor — which still works — and
 * says which of the two happened.
 */
class BrowserActor extends HumanActor {
  get kind() { return KIND.BROWSER; }

  get url() {
    const raw = this.cfg.externalTroubleshoot || {};
    return String(raw.url || DEFAULT_BROWSER_URL);
  }

  /**
   * WHICH PROVIDER THIS ACTOR IS. Its profile, and therefore its login and its
   * conversation, are keyed on this — see browser.runtimeFor.
   */
  get provider() {
    const raw = this.cfg.externalTroubleshoot || {};
    if (raw.provider) return String(raw.provider);
    // Derived from the URL so an actor configured only with a URL still gets
    // its own profile rather than sharing the default one.
    try { return new URL(this.url).hostname.replace(/^www\./, '').split('.')[0]; } catch { return 'profile'; }
  }

  /** This provider's browser, started on demand. One runtime per provider. */
  async runtime() {
    const { runtimeFor } = require('./browser');
    const b = runtimeFor(this.app, this.provider);
    if (!b) return { ok: false, error: 'no app to hold a browser' };
    if (b.running) return { ok: true, browser: b };
    const r = await b.start();
    return r.ok ? { ok: true, browser: b } : { ok: false, error: r.error, tried: r.tried };
  }

  status() {
    const base = super.status();
    const b = this.app._browser;
    const st = b ? b.status() : null;
    return {
      ...base,
      // A browser actor does NOT need somebody at the keyboard the way a pasted
      // relay does — it drives the page itself. It needs a browser.
      ok: true,
      why: '',
      browser: st ? st.state : 'NOT_STARTED',
      profile: st ? st.profile : null,
      isolated: true,
      url: this.url,
    };
  }

  /**
   * Open the page, type the packet, and send it.
   *
   * The selectors are the ones a chat page has had for years, tried in order
   * and CHECKED. When none matches, this says so and stops: a wrong selector
   * that "worked" would type a review packet into some other element.
   */
  /**
   * Open the page ONCE, attach any images, type the packet, send it.
   *
   * ------------------------------------------------------------------------
   * NAVIGATION IS THE THING THAT BROKE CONTINUITY. This used to call
   * `open(this.url)` on EVERY send, and the default URL carried
   * `?temporary-chat=true` — so each round deliberately began a new chat and
   * the provider remembered nothing. The packet compensated by restating
   * context, which is copy-and-paste performed by a machine.
   *
   * Now the page is opened only when this actor has not opened it yet. The
   * second message lands in the same conversation because nothing navigated.
   * ------------------------------------------------------------------------
   *
   * IMAGES ARE ATTACHED, NOT DESCRIBED. `images` are real paths; they go onto
   * the page's file input through the OS-level mechanism (see
   * browser.attach). If the page has no file input, that is reported as a
   * FAILURE rather than quietly sending the text alone — a message about a
   * picture that did not arrive reads as an answer about nothing.
   */
  async send(packet, { images = [] } = {}) {
    this.sent = String(packet || '');
    const files = (Array.isArray(images) ? images : []).map(String).filter(Boolean);
    const r = await this.runtime();
    if (!r.ok) {
      const handed = await super.send(packet);      // the clipboard still works
      return { ...handed, browser: false, why: r.error };
    }
    const b = r.browser;

    // ---- "ALREADY THERE" IS A PROPERTY OF THE PAGE, NOT OF THIS OBJECT ----
    //
    // The first version of this kept an `opened` flag on the actor, and the
    // continuity test caught it immediately: the panel constructs a FRESH
    // actor for every round, so the flag reset and the page was re-opened —
    // restarting the conversation, which is the exact defect being fixed.
    //
    // The runtime is the thing that persists per provider, and `open()`
    // already records where it went. Asking the page where it is is both
    // correct and impossible to get out of step.
    const alreadyThere = b.url === this.url;
    if (!alreadyThere) {
      const opened = await b.open(this.url);
      if (!opened.ok) {
        const handed = await super.send(packet);
        return { ...handed, browser: false, why: opened.error };
      }
    }

    const box = await this.compose(b);
    if (!box) {
      return {
        ok: false,
        browser: true,
        url: this.url,
        error: 'the page opened but no message box was found on it — it may need a login, or its '
          + 'markup may have changed. NOTHING WAS TYPED. Log in inside that window and try again.',
      };
    }

    // ---- THE PICTURE GOES FIRST -------------------------------------------
    //
    // Before the text, because a chat page attaches to the message being
    // composed: typing and sending first would post the words without them.
    let attached = [];
    if (files.length) {
      const input = await b.fileInput();
      if (!input) {
        return {
          ok: false,
          browser: true,
          url: this.url,
          error: `this page has no file input, so ${files.length} image(s) could NOT be attached. `
            + 'Nothing was sent — a message about an image the model never received is worse than no message.',
        };
      }
      const put = await b.attach(input, files);
      if (!put.ok) {
        return { ok: false, browser: true, url: this.url, error: `could not attach: ${put.error}` };
      }
      attached = put.files;
    }

    const typed = await b.type(box, this.sent);
    if (!typed.ok) return { ok: false, browser: true, error: typed.error, url: this.url };
    await b.key('Enter');
    // `continued` says whether this went into an EXISTING conversation. It is
    // the observable proof that continuity worked, so it is reported rather
    // than inferred: the first send is false, every send after it is true.
    // Recorded on the RUNTIME for the same reason the page location is: the
    // actor does not survive between rounds and the conversation does.
    const continued = Boolean(b.sentOnce);
    b.sentOnce = true;
    return {
      ok: true, delivered: 'browser', browser: true, url: this.url, box,
      provider: this.provider, attached, continued,
    };
  }

  /** The first message box this page actually has. Tried, never assumed. */
  async compose(b) {
    for (const sel of ['#prompt-textarea', 'div[contenteditable="true"]', 'textarea']) {
      const at = await b.inspect(sel);
      if (at.ok && at.found && at.visible) return sel;
    }
    return null;
  }

  /**
   * Read the reply off the page.
   *
   * WAITING IS DONE BY WATCHING THE TEXT SETTLE, not by a fixed sleep: a reply
   * streams in, so "it stopped growing across two consecutive checks" is the
   * only signal available without reading the site's own internals. Bounded,
   * and a timeout is reported as NO REPLY rather than as whatever had arrived
   * so far — half a review presented as a whole one is worse than none.
   */
  async receive() {
    const b = this.app._browser;
    if (!b || !b.running) return super.receive();     // the clipboard relay
    const started = Date.now();
    let last = '';
    let stable = 0;
    while (Date.now() - started < REPLY_LIMIT_MS) {
      await new Promise((r) => { const t = setTimeout(r, 2500); if (t.unref) t.unref(); });
      const text = await this.reply(b);
      if (text && text === last) {
        stable += 1;
        if (stable >= 2) {
          return this.read(text, { model: 'the page', connection: 'browser · ' + this.url });
        }
      } else {
        stable = 0;
        last = text || '';
      }
    }
    return {
      ok: false,
      timedOut: true,
      error: 'no reply had settled on the page within '
        + Math.round(REPLY_LIMIT_MS / 1000) + 's. Nothing was read.',
    };
  }

  /** The last message on the page, by the selectors a chat page tends to use. */
  async reply(b) {
    for (const sel of ['[data-message-author-role="assistant"]:last-of-type',
      'main article:last-of-type', 'main :last-child']) {
      const at = await b.inspect(sel);
      if (at.ok && at.found && at.text && at.text.length > 20) return at.text;
    }
    return '';
  }
}

/** Open a URL in the user's own browser. Reported, never silently skipped. */
function openUrl(url) {
  try {
    const child = process.platform === 'win32'
      // The empty argument is the window TITLE, which `start` consumes first —
      // without it a quoted URL is taken as the title and nothing opens.
      ? spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --------------------------------------------------------------- reverse ----

/**
 * THE REVERSE-ENGINEERING SEAM — declared, bounded, and NOT CONFIGURED.
 *
 * It is here so the shape is on the record rather than invented later under
 * time pressure, and so `/external` can say out loud that it exists and does
 * nothing. It follows mcp.js exactly: the capability would live in an EXTERNAL
 * process, LAIN ships none of it, and each capability is a separate named
 * permission that is temporary, narrow, revocable and logged.
 *
 *     process.select     which process, chosen explicitly by the user
 *     memory.read        read-only inspection of the selected process
 *     screen.inspect     what is on screen — already an MCP capability
 *     symbol.resolve     names for addresses
 *
 * There is deliberately NO memory write in that list, no code injection and no
 * process manipulation. This class exists to report NOT CONFIGURED; it has no
 * implementation, starts nothing, and reads nothing.
 *
 * ON `zhaoxuya520/reverse-skill`, WHICH WAS SUGGESTED AS A SOURCE.
 *
 * It was read before being ruled on, and it is not what it sounds like. It is a
 * SKILL ROUTER: a hierarchy of markdown routing rules that tells an agent which
 * methodology and which third-party tool to reach for — IDA, radare2, Ghidra,
 * Frida, jadx, nmap and forty-odd others. It contains no memory reader, no
 * screen inspector and no symbol resolver of its own; it invokes programs that
 * have them.
 *
 * So importing it would import PROMPTS, not capability, and would not move this
 * seam a single step closer to working. The capabilities above still need an
 * external process that actually implements them, which is exactly what the MCP
 * bridge already is.
 *
 * Licensing is also mixed rather than uniformly MIT: the repository is MIT
 * overall, but carries a GPLv3 sub-project (CTF-Sandbox-Orchestrator) and
 * references an AGPL-3.0 tool it shells out to. That is a real consideration
 * for a zero-dependency tree and another reason a wholesale import would be the
 * wrong move even if it did carry capability.
 *
 * CONCLUSION: not adopted, and not because of caution — because it does not
 * contain the thing this seam is missing.
 */
class ReverseActor extends ExternalActor {
  get kind() { return KIND.REVERSE; }

  status() {
    return {
      kind: KIND.REVERSE,
      label: LABEL[KIND.REVERSE],
      automated: false,
      ok: false,
      why: 'NOT CONFIGURED — a declared seam, not built',
      capabilities: ['process.select', 'memory.read', 'screen.inspect', 'symbol.resolve'],
      model: null,
      connection: null,
      maxRounds: 0,
    };
  }

  async send() { return { ok: false, error: this.status().why }; }
  async receive() { return { ok: false, error: this.status().why }; }
}

// ---------------------------------------------------------------- factory ---

const CLASSES = {
  [KIND.API]: ApiActor,
  [KIND.BROWSER]: BrowserActor,
  [KIND.HUMAN]: HumanActor,
  [KIND.REVERSE]: ReverseActor,
};

/**
 * Which actor is configured.
 *
 * The config key is UNCHANGED (`externalTroubleshoot`) so an existing setup
 * keeps working: a config that names a model and no actor IS an API actor,
 * which is exactly what it always was.
 */
function kindOf(cfg = {}) {
  const raw = cfg.externalTroubleshoot || {};
  const named = String(raw.actor || '').toUpperCase();
  return CLASSES[named] ? named : KIND.API;
}

/** The configured actor, or null when there is not one. */
/**
 * @param {object} [o.cfg]  a configuration to build from INSTEAD of the app's.
 *
 * Exists so the external panel can construct one actor per provider — same
 * class, same behaviour, only the url and profile differ. Without it the panel
 * would need its own construction path, which is a second way to make an actor
 * and therefore a second thing that can disagree about what an actor is.
 */
function create(app, { cfg: override = null } = {}) {
  const cfg = override || app.cfg || {};
  const raw = cfg.externalTroubleshoot || {};
  if (raw.enabled === false) return null;
  const kind = kindOf(cfg);
  // An API actor with no model is not an actor, it is an empty setting.
  if (kind === KIND.API && !raw.model) return null;
  return new CLASSES[kind](app, cfg);
}

/**
 * What `/external` reports: the state of EVERY actor, whether or not it is the
 * chosen one — so the menu can say what each would cost before you pick it.
 */
function status(app) {
  const cfg = app.cfg || {};
  const raw = cfg.externalTroubleshoot || {};
  const off = raw.enabled === false;
  // NOTHING RECORDED IS NOT A CHOICE. `kindOf` falls back to API so that an
  // existing model-only config keeps working — but with an empty config that
  // made the menu put its ● marker on an actor the user has never chosen and
  // which is not set up. A choice has to have actually been made.
  const recorded = Boolean(raw.actor || raw.model);
  const chosen = recorded ? kindOf(cfg) : null;
  const actors = Object.keys(CLASSES).map((k) => {
    const s = new CLASSES[k](app, cfg).status();
    return { ...s, chosen: !off && k === chosen };
  });
  return { off, chosen: off ? null : chosen, actors };
}

module.exports = {
  KIND, LABEL, DEFAULT_BROWSER_URL,
  ExternalActor, ApiActor, HumanActor, BrowserActor, ReverseActor,
  create, status, kindOf, openUrl,
};
