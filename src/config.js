'use strict';

/**
 * Configuration. Owned by the App instance — `load()` returns a fresh object
 * every call and this module holds no cached state.
 *
 * V2 uses its OWN config home (`~/.lain-v2`). V1's `~/.lain` holds the user's
 * real credentials and a 1.8 MB model registry; V2 must never read or write it.
 * LAIN_CONFIG_DIR overrides, which is how tests get an isolated home instead of
 * touching anything real.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function configDir() {
  return process.env.LAIN_CONFIG_DIR || path.join(os.homedir(), '.lain-v2');
}
function configFile() { return path.join(configDir(), 'config.json'); }
function sessionsDir() { return path.join(configDir(), 'sessions'); }

const DEFAULTS = {
  model: null,          // null = "not chosen yet", never a fake default
  provider: null,
  /**
   * 0 = NO LIMIT, and that is now the default.
   *
   * It was 30, and thirty ended a turn — reported as STEP LIMIT — because a
   * counter reached a number nobody chose for the task in hand. A model that
   * needs forty tool calls is not malfunctioning, and a count cannot tell a
   * long job from a stuck one. See turn.js DEFAULT_MAX_STEPS.
   *
   * A NON-ZERO VALUE IS STILL HONOURED, because it means something different: a
   * person saying "do not spend more than this on my behalf". That is the
   * user's authority over their own budget, not LAIN's opinion about how long
   * the model may work.
   */
  maxSteps: 0,
  stream: true,
  /**
   * WHETHER LAIN TAKES THE TERMINAL'S MOUSE. Off by default, and that is a
   * reversal.
   *
   * ---- WHAT THE DEFAULT COST ------------------------------------------
   *
   * `?1002h` gives LAIN a clickable caret, click targets in the feed, and its
   * own drag-to-select. In exchange the TERMINAL stops doing selection — and
   * LAIN's replacement only covers the FEED. The live region at the bottom of
   * the screen, where `/app` prints its URL, where an error lands, where a
   * path or a command appears, is selectable by neither: LAIN captured the
   * gesture and then had nothing to do with it there.
   *
   * So the person could not copy the one thing they most often need to copy,
   * and the standing advice — hold Shift — is true in Windows Terminal, iTerm2
   * and GNOME Terminal and false in the legacy Windows console and several
   * multiplexer setups. For those people it was a dead end.
   *
   * ON IS STILL ONE COMMAND AWAY (`/mouse on`) and now PERSISTS, which is the
   * other half of the fix: the preference used to be re-asserted at every start,
   * so `/mouse off` lasted until the next launch and no further.
   *
   * The trade is a convenience against a necessity, and copying an error out of
   * your own terminal is the necessity.
   */
  mouse: false,
};

/**
 * The step ceiling LAIN used to impose on itself, before the default became
 * "no limit". See RETIRED_MAX_STEPS below.
 */
const LEGACY_MAX_STEPS = 30;

/**
 * A SAVED `maxSteps: 30` IS LAIN'S OLD OPINION, NOT THE USER'S CHOICE.
 *
 * Changing the DEFAULT to 0 was not enough, and a live session showed why: the
 * old default had already been written into every existing config file, because
 * `save()` persists the whole merged object. So a user who never asked for a
 * limit still had one, still had their turn stopped mid-work with
 *
 *     STEP LIMIT — it reached the step limit you configured
 *
 * and still had to type "proceed" to carry on — while the message blamed them
 * for a number LAIN had chosen and written down on their behalf.
 *
 * So exactly the legacy value is dropped on load. A value the user actually
 * picked — anything other than 30 — is theirs and is honoured.
 *
 * IT CANNOT BE PERFECT, and the direction of the error is deliberate. Someone
 * could have cycled the old ladder to exactly 30, and this discards that. The
 * cost of being wrong is a turn that runs as long as the work needs, which is
 * the behaviour asked for; the cost of the opposite mistake is the screen
 * above. `/config` sets it again, and the ladder now starts at "no limit".
 */
function retireLegacyStepLimit(saved) {
  if (Number(saved.maxSteps) === LEGACY_MAX_STEPS) {
    const out = { ...saved };
    delete out.maxSteps;
    return out;
  }
  return saved;
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { saved = {}; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  return { ...DEFAULTS, ...retireLegacyStepLimit(saved) };
}

function save(cfg) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = configFile();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

module.exports = { DEFAULTS, load, save, configDir, configFile, sessionsDir,
  LEGACY_MAX_STEPS, retireLegacyStepLimit };
