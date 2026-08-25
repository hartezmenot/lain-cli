'use strict';

/**
 * WHAT MAKES A TASK A PROBE TASK — one vocabulary, shared by everything that
 * needs to ask.
 *
 * WHY A WHOLE FILE FOR A REGEX LIST. Three callers need the same answer and
 * cannot be allowed to drift: `mode.js` classifies a new request, `identify.js`
 * performs the handoff on that verdict, and the tests pin the boundary. A second
 * word list in any of them is a second classifier that can disagree with the
 * first.
 *
 * WHY DETERMINISTIC. Same rule as mode.js: deciding how to spend model calls
 * with a model call is circular, and "inspect this target" is a Probe task under
 * any reading. Pure string work — no network, no tokens, no I/O.
 *
 * WHY BROAD RATHER THAN NARROW. The cost of a false positive is one sentence of
 * environment decoration the model reads on a turn that was already about a
 * running program. The cost of a false negative is the measured failure this
 * whole change exists to fix: a live-process question answered by searching the
 * source tree. The verbs below are all runtime-investigation verbs; ordinary
 * coding verbs (read, write, refactor, migrate, test, build) are deliberately
 * absent.
 *
 * THE BOUNDARY. A Probe task names the TARGET'S behaviour or state — a value in
 * a running process, a window, memory, an observation over time. A task about
 * this codebase is not a Probe task even when the codebase is the Probe: "scan
 * the project for TODOs" matches nothing here and correctly stays in CLI.
 *
 * IMPLEMENTATION NOTE. The patterns below are STRINGS, assembled with | and
 * compiled once. They were originally RegExp literals joined with `.join('|')`,
 * which stringifies each as "/pattern/i" — literal slashes that never match.
 * A regex vocabulary that silently matches nothing is worse than none.
 */

/** Runtime-investigation verbs: watch/observe/attach a TARGET, not a build.
 *
 * A bare "watch" also matches "watch the test suite while it runs", which is
 * ordinary CLI work about a build, so the verb needs a runtime OBJECT nearby —
 * a process, a game, the target, its memory, a window. "Watch this process",
 * "monitor the game", "watch the target" all pass; "watch the tests" does not.
 */
const RUNTIME_VERBS = String.raw`\b(?:watch|monitor|observe|snapshot)\b[^.?!]{0,40}\b(?:process|target|game|app|application|window|memory|pid|exe|thread|module)\b
|\b(?:process|target|game|app|application|window|memory|pid|exe)\b[^.?!]{0,40}\b(?:watch|monitor|observe|snapshot)\b
|\b(?:correlate|correlation)\b
|\b(?:attach|detaches?)\b
|\bbaseline\b
|\b(?:freeze|frozen|frame)\b`;

/** Scanning memory: the operation only a live-process instrument can do. */
const MEMORY = String.raw`\b(?:scan|scanning|scanned|sweep)[^.?!]{0,40}\bmemory\b
|\bmemory\b[^.?!]{0,40}\b(?:scan|scanning|sweep|regions?|addresses?|values?)\b
|\b(?:addresses?|pointer(?:s|chain|chains|path)?)\b
|\b(?:heap|stack)\b[^.?!]{0,30}\b(?:values?|addresses?|scan)\b`;

/** Runtime values: things a user watches change while a program runs. */
const RUNTIME_VALUE = String.raw`\b(?:runtime|live|current)\b[^.?!]{0,30}\b(?:value|values|address|addresses|state|memory)\b
|\b(?:health|hp|mana|ammo|inventory|position|coordinates?|coords|velocity|speed|stamina|xp|score|gold|currency|level)\b[^.?!]{0,40}\b(?:value|address|addresses|offset|pointer|memory|changes?|changed|changes when)\b
|\b(?:float|int\d*|uint\d*|byte|double)\b[^.?!]{0,30}\b(?:at|address|offset)\b
|\b0x[0-9a-f]+\b`;

/** What the user does with a target: an executable, a process, a PID, a window. */
const TARGET = String.raw`\.(?:exe|dll)\b
|\bpid\b[^.?!]{0,20}\d+
|\bprocess\b[^.?!]{0,30}\b(?:attach|pid|authori[sz]e|target|memory|running)\b
|\b(?:process|target|program)\b[^.?!]{0,40}\brunning\b
|\b(?:running|live)\b[^.?!]{0,20}\b(?:process|program|target|game|app)\b`;

/** Explicitly naming the environment: the Probe, an investigation, a stage. */
const PROBE_NAMED = String.raw`\bprobe\b
|\b(?:inspect|examine|check|look at|analyse|analyze)\b[^.?!]{0,30}\b(?:the\s+)?target\b
|\binvestigation\b[^.?!]{0,30}\b(?:target|stage|evidence|finding|intelligence)\b
|\b(?:resume|continue|restore)\b[^.?!]{0,30}\b(?:investigation|probe|finding|experiment)\b
|\b(?:observed?|observation|observations)\b`;

/** The Probe lifecycle's later stages, which are always Probe work. */
const LIFECYCLE = String.raw`\b(?:implement|build|generate|write)\b[^.?!]{0,40}\b(?:reader|writer|trainer|bot|artifact|script)\b[^.?!]{0,40}\b(?:finding|address|value|target|from)\b
|\b(?:finding|findings|hypothes[ie]s|experiment)\b
|\b(?:verify|validation|validate)\b[^.?!]{0,40}\b(?:finding|artifact|address|value|behaviou?r(?:al)?|reader)\b
|\b(?:artifact|capability)\b`;

/** "do X, then Y": a compound instruction whose second half names the runtime. */
const COMPOUND = String.raw`\b(?:then|and then|after that|while|during|when it)\b[^.?!]{0,60}\b(?:watch|monitor|observe|changes?|window|memory|target)\b`;

/** THE ONE PATTERN. Compiled once at require time; stateless and cheap. */
const PROBE_TASK_RE = new RegExp(
  [RUNTIME_VERBS, MEMORY, RUNTIME_VALUE, TARGET, PROBE_NAMED, LIFECYCLE, COMPOUND]
    .map((s) => `(?:${s.replace(/\n/g, '')})`).join('|'), 'i');

module.exports = { PROBE_TASK_RE };
