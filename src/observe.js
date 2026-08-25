'use strict';

/**
 * WATCHING SOMETHING RUN WITHOUT STARING AT IT.
 *
 *: "LAIN should NOT continuously screenshot/OCR the computer while a bot is
 * running. That is wasteful and can actually make investigations worse."
 *
 * ------------------------------------------------------------------------
 * WHY STARING IS WORSE THAN USELESS, and not merely expensive.
 *
 * The obvious way to watch a bot is to look at the screen, ask the model what
 * it sees, and repeat. That fails three ways at once:
 *
 *   IT COSTS A MODEL REQUEST PER GLANCE. A twenty-minute run at one look every
 *     five seconds is 240 requests to observe a program that was writing a log
 *     the whole time.
 *
 *   IT FILLS THE CONTEXT WITH SAMENESS. 240 near-identical screenshots crowd
 *     out the one frame that differed — the evidence is buried by the act of
 *     collecting it, which is the reported failure in another form.
 *
 *   IT STILL MISSES THINGS. Polling has a period; a minigame indicator that
 *     shows for three seconds falls between two five-second glances and is gone.
 *     Looking more often costs more and still guarantees nothing.
 *
 * So the design is inverted. The bot's own output is the clock:
 *
 *     the RUN emits lines          →  matched against rules, here, in-process
 *     a rule that matters FIRES    →  evidence is captured immediately
 *     everything else              →  counted, and nothing else happens
 *     the run STOPS                →  the model reads the accumulated evidence
 *
 * The model is called ONCE, at the end, with the few captures that mattered —
 * and the indicator is caught because a log line fires the capture at the
 * instant it appears, not because something was looking at the right moment.
 *
 * ------------------------------------------------------------------------
 * THE RULE THAT KEEPS IT HONEST. An event NEVER becomes a conclusion here.
 * A rule fires and evidence is recorded, with its source and its timestamp.
 * What it MEANS is decided later, by the model, with both sources in front of
 * it — see correlate.js, which is the only thing allowed to put a LOG line and
 * a SCREEN capture side by side and say whether they agree.
 */

const jobs = require('./jobs');

/**
 * THE STATES OF AN OBSERVATION.
 *
 * Named for what LAIN is doing, because that is what the user is asking about
 * when they look at the screen. They deliberately do NOT duplicate
 * jobs.STATE — that is the PROCESS's state, and the two are different facts:
 * a bot can be RUNNING while LAIN is ANALYZING evidence from a minute ago, and
 * a bot can be dead while LAIN is still waiting for the user to answer a
 * question about it. Merging them is how "it stopped" came to mean four things.
 */
const STATE = Object.freeze({
  PREPARING: 'PREPARING',
  OBSERVING: 'OBSERVING',
  STOP_REQUESTED: 'STOP_REQUESTED',
  STOPPED: 'STOPPED',
  ANALYZING: 'ANALYZING',
  WAITING_FOR_USER: 'WAITING_FOR_USER',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

/** Observation is over and the evidence will not grow. */
const FINAL = new Set([STATE.COMPLETED, STATE.FAILED]);

/**
 * WHERE A PIECE OF EVIDENCE CAME FROM. NEVER MERGED — see correlate.js.
 *
 * FIVE SOURCES, AND THE LIST IS THE POINT. Each has a different reliability and
 * a different way of being wrong, and the moment two of them are recorded as
 * one fact the difference is gone for good:
 *
 *   LOG      what the program under test SAID it did. Cheap, plentiful, and a
 *            statement of intent — it reports what the code believed.
 *   VISUAL   what a capture actually showed. Expensive, sparse, and the only
 *            source that can contradict the log about the outside world.
 *   MEMORY   what inspecting the process found. Precise about state and silent
 *            about whether anyone could SEE that state.
 *   PROCESS  what the process did — started, exited, crashed, its code.
 *   USER     what the person watching says happened. The only source that can
 *            settle a contradiction between the others.
 *
 * MEMORY IS HERE BECAUSE OF A SPECIFIC FAILURE. Mid-investigation LAIN said
 * "memory correlation is the stronger evidence anyway" and stopped looking at
 * the screen — a ranking decided from convenience, before the sources had been
 * compared. Recording memory as its own source is what makes that comparison
 * possible instead of a preference.
 */
const SOURCE = Object.freeze({
  LOG: 'LOG',
  VISUAL: 'VISUAL',
  MEMORY: 'MEMORY',
  PROCESS: 'PROCESS',
  USER: 'USER',
});

/**
 * How many captures one observation may take, however many rules fire.
 *
 * A RUNAWAY GUARD, not a leash on the model (): a rule matching a line the
 * bot prints in a tight loop would otherwise take a screenshot per line until
 * the disk filled. It bounds a mechanical process on this machine, which is
 * exactly the kind of limit the design keeps.
 */
const MAX_CAPTURES = 24;

/** And how many events are kept. Enough to reconstruct a run; never unbounded. */
const MAX_EVENTS = 500;

/** A capture may not fire more often than this for the SAME rule. */
const RULE_COOLDOWN_MS = 3000;

/**
 * ONE THING WORTH NOTICING, as the user described it.
 *
 * `pattern` is matched against each line of the run's output. `capture` says
 * whether it is worth a picture — most events are not, and a rule that captures
 * on every line is the polling this file exists to avoid, one rule at a time.
 */
function rule({ name, pattern, capture = false, why = '' }) {
  return {
    name: String(name || 'event'),
    pattern: pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i'),
    capture: Boolean(capture),
    why: String(why || ''),
    fired: 0,
    lastAt: 0,
  };
}

class Observation {
  /**
   * @param {object} o
   *   expectation  what the user says SHOULD happen — recorded, never enforced
   *   rules        what is worth noticing
   */
  constructor({ id = 'obs', command = '', expectation = [], rules = [] } = {}) {
    this.id = id;
    this.command = String(command);
    this.state = STATE.PREPARING;
    /**
     * WHAT WAS SUPPOSED TO HAPPEN, in the user's words, recorded BEFORE the run.
     *
     * Written down first on purpose: an expectation formed after seeing the
     * result is not an expectation, it is a description. This is what the
     * evidence is later compared against, and having it in advance is what
     * makes "it did not do step 3" a finding rather than a feeling.
     */
    this.expectation = (Array.isArray(expectation) ? expectation : [expectation])
      .filter(Boolean).map((s) => String(s));
    this.rules = rules.map(rule);
    this.events = [];
    this.captures = [];
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.stopReason = '';
    /** Lines seen, so "quiet" can be told from "nothing ran". */
    this.lines = 0;
    this.job = null;
  }

  get running() { return this.state === STATE.OBSERVING || this.state === STATE.STOP_REQUESTED; }

  /** Elapsed observation time, or 0 before it starts. */
  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.stoppedAt || Date.now()) - this.startedAt;
  }

  /**
   * Record something that happened. The ONLY way anything enters the ledger.
   *
   * SOURCE IS MANDATORY and is never inferred. "The log said the round finished"
   * and "the screen showed the round finished" are different claims with
   * different reliability, and the whole value of the correlation step is that
   * they were never allowed to blur into "the round finished".
   */
  note(source, kind, detail = '', extra = {}) {
    if (this.events.length >= MAX_EVENTS) return null;
    const ev = {
      at: Date.now(),
      sinceStartMs: this.startedAt ? Date.now() - this.startedAt : 0,
      source,
      kind: String(kind),
      detail: String(detail || '').slice(0, 400),
      ...extra,
    };
    this.events.push(ev);
    return ev;
  }

  /** Every event from one source, in order. Correlation reads these. */
  from(source) { return this.events.filter((e) => e.source === source); }

  /**
   * FEED ONE LINE OF THE RUN'S OUTPUT.
   *
   * Returns the rules that want a capture. It does NOT capture anything itself:
   * taking a screenshot needs a transport, a permission and an await, and this
   * has to stay a pure synchronous match so that the whole event pipeline can
   * be tested without a machine — and so a slow screen capture can never apply
   * backpressure to the bot's stdout.
   */
  feed(line) {
    const text = String(line == null ? '' : line);
    if (!text.trim()) return [];
    this.lines += 1;
    const wants = [];
    const now = Date.now();
    for (const r of this.rules) {
      if (!r.pattern.test(text)) continue;
      r.fired += 1;
      this.note(SOURCE.LOG, r.name, text.trim(), { rule: r.name });
      if (!r.capture) continue;
      // COOLDOWN PER RULE, not globally: two different rules firing on the same
      // line are two different things worth seeing, and suppressing the second
      // because the first just fired would lose exactly the correlation the
      // capture was for.
      if (now - r.lastAt < RULE_COOLDOWN_MS) continue;
      if (this.captures.length >= MAX_CAPTURES) continue;
      r.lastAt = now;
      wants.push(r);
    }
    return wants;
  }

  /** Record a capture that was actually taken. Path or refusal, never a guess. */
  addCapture({ rule: ruleName, kind, path = '', text = '', why = '', ok = true }) {
    const c = {
      at: Date.now(),
      sinceStartMs: this.startedAt ? Date.now() - this.startedAt : 0,
      rule: String(ruleName || ''),
      kind: String(kind || 'screenshot'),
      path: String(path || ''),
      text: String(text || '').slice(0, 2000),
      ok: Boolean(ok),
      why: String(why || ''),
    };
    this.captures.push(c);
    this.note(SOURCE.VISUAL, c.kind, ok ? (c.path || 'captured') : `NOT CAPTURED — ${c.why}`, { rule: c.rule, ok });
    return c;
  }

  /** A plain account of what happened, for the model and for the report. */
  summary() {
    const byKind = new Map();
    for (const e of this.events) byKind.set(e.kind, (byKind.get(e.kind) || 0) + 1);
    return {
      id: this.id,
      state: this.state,
      command: this.command,
      expectation: this.expectation,
      elapsedMs: this.elapsedMs,
      lines: this.lines,
      events: this.events.length,
      captures: this.captures.filter((c) => c.ok).length,
      capturesRefused: this.captures.filter((c) => !c.ok).length,
      stopReason: this.stopReason,
      kinds: [...byKind.entries()].map(([kind, n]) => ({ kind, n })),
    };
  }
}

/**
 * THE OBSERVATIONS OF ONE SESSION.
 *
 * One at a time, deliberately. Two bots watched at once would make every event
 * ambiguous about which run it belongs to, and the correlation step would be
 * comparing a log from one against a screen from the other.
 */
class Observatory {
  constructor() {
    this.current = null;
    this.past = [];
    this.seq = 0;
  }

  /**
   * START WATCHING A COMMAND.
   *
   * @param {object} o
   *   run       (line) => void subscription; see attach()
   *   onCapture async (rule, obs) => void — what to do when a rule wants a look
   */
  begin({ command = '', expectation = [], rules = [] } = {}) {
    if (this.current && this.current.running) {
      return { ok: false, why: `already watching ${this.current.id} — stop it first` };
    }
    this.seq += 1;
    const obs = new Observation({ id: `o${this.seq}`, command, expectation, rules });
    this.current = obs;
    return { ok: true, observation: obs };
  }

  /** The observation an id names, current or finished. */
  find(id) {
    if (this.current && this.current.id === id) return this.current;
    return this.past.find((o) => o.id === id) || null;
  }

  /** Move a finished observation out of the way, keeping its evidence. */
  retire(obs) {
    if (this.current === obs) this.current = null;
    if (!this.past.includes(obs)) this.past.push(obs);
    while (this.past.length > 5) this.past.shift();
    return obs;
  }
}

/**
 * SUBSCRIBE AN OBSERVATION TO A RUNNING JOB.
 *
 * WHY THE JOB'S STREAM RATHER THAN A POLL: jobs.js already receives the child's
 * output as it arrives and its `wait` resolves on the child's own exit event.
 * Reading from it costs nothing and adds no timer — the file's opening argument
 * is that a poll is a block paid for in instalments, and an observer that polled
 * the job would reintroduce exactly that below the model.
 *
 * @param {Observation} obs
 * @param {object} job     a jobs.Job
 * @param {Function} onCapture  async (rule, obs) => void
 */
function attach(obs, job, onCapture) {
  obs.job = job;
  obs.state = STATE.OBSERVING;
  obs.startedAt = Date.now();
  obs.note(SOURCE.PROCESS, 'STARTED', obs.command);

  let pending = '';
  const consume = (chunk) => {
    pending += String(chunk == null ? '' : chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() || '';           // an unterminated tail waits for more
    for (const line of lines) {
      const wants = obs.feed(line);
      for (const r of wants) {
        // NOT AWAITED, and that is the point: the bot's output must never wait
        // for a screenshot. A capture that takes 400ms would otherwise stall
        // the stream and shift every later timestamp by the time it took to
        // observe — measurement changing the thing measured.
        if (typeof onCapture === 'function') {
          Promise.resolve(onCapture(r, obs)).catch((e) => {
            obs.addCapture({ rule: r.name, kind: 'screenshot', ok: false, why: (e && e.message) || 'capture failed' });
          });
        }
      }
    }
  };

  if (typeof job.on === 'function') job.on('output', consume);
  return consume;
}

/**
 * THE RUN IS OVER. Records why, and moves to the state where looking is allowed.
 *
 * STOPPING THE BOT IS NOT STOPPING THE INVESTIGATION (). This ends the
 * OBSERVATION — the process, the subscription, the evidence collection — and
 * leaves everything gathered in place, because the analysis that follows is the
 * reason any of it was collected.
 */
function finish(obs, reason = 'stopped') {
  if (!obs) return null;
  obs.stoppedAt = Date.now();
  obs.stopReason = String(reason);
  obs.state = STATE.STOPPED;
  obs.note(SOURCE.PROCESS, 'STOPPED', reason);
  return obs;
}

module.exports = {
  Observation, Observatory, STATE, FINAL, SOURCE, rule, attach, finish,
  MAX_CAPTURES, MAX_EVENTS, RULE_COOLDOWN_MS, jobsState: jobs.STATE,
};
