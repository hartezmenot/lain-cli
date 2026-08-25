'use strict';

/**
 * THE WITNESS — an external target that records what it actually received.
 *
 * THE VERDICT ON KEYBOARD DELIVERY MAY NOT COME FROM THE SENDER. `SendInput`
 * returning a count means Windows queued the events; the Probe reporting `ok`
 * means the call did not throw. Neither is receipt. The only thing entitled to
 * say a key arrived is the program that was supposed to get it.
 *
 * So: a real window, in a real process, owned by nothing in LAIN, which writes
 * every key event it receives to a file as it happens. LAIN reads that file
 * afterwards. If the file has no `KEY_DOWN W`, then no `KEY_DOWN W` arrived,
 * whatever anything else reported.
 *
 * WHY POWERSHELL AND WINDOWS FORMS. It needs a genuine top-level window with a
 * genuine message loop, because that is what receives keyboard input — a
 * console window is not the same thing and would prove less. Windows Forms is
 * present on every Windows install, needs nothing installed, and `KeyDown` /
 * `KeyUp` are exactly the two edges the hold lifecycle has to demonstrate.
 *
 * IT IS A TARGET, NOT A TOOL. It reads the keyboard that is sent TO ITS OWN
 * WINDOW, through the ordinary focused-window path every application uses.
 * There is no hook, nothing global, nothing that observes anything the user
 * types anywhere else, and it records only key names — never text, never
 * anything from another process.
 *
 *     node tools/keywitness.js <logfile> [--title "..."] [--seconds 120]
 *
 * It prints one line of JSON (`{"pid":…,"title":…,"log":…}`) as soon as the
 * window is up, so a caller knows when it is safe to aim at it, and exits on
 * its own after the timeout so a forgotten witness is not left on screen.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TITLE = 'LAIN KEY WITNESS';
const DEFAULT_SECONDS = 120;

/**
 * The PowerShell that builds the window.
 *
 * Written as a file rather than passed with -Command: an inline script this
 * size is at the mercy of two levels of quoting, and the one thing this
 * program must not do is fail in a way that looks like the key not arriving.
 */
function script({ title, log, seconds }) {
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$logPath = ${JSON.stringify(log)}
$sw = [System.IO.StreamWriter]::new($logPath, $true)
$sw.AutoFlush = $true
$nl = [Environment]::NewLine

function Note([string]$line) {
  $sw.WriteLine(("{0} {1}" -f ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()), $line))
}

$form = New-Object System.Windows.Forms.Form
$form.Text = ${JSON.stringify(title)}
$form.Width = 520
$form.Height = 260
$form.StartPosition = 'CenterScreen'
$form.KeyPreview = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(18, 18, 22)

$label = New-Object System.Windows.Forms.Label
$label.Dock = 'Fill'
$label.ForeColor = [System.Drawing.Color]::FromArgb(120, 230, 160)
$label.Font = New-Object System.Drawing.Font('Consolas', 12)
$label.Text = "waiting for keys" + $nl + "(this window records what it receives)"
$form.Controls.Add($label)

$script:count = 0
$form.Add_KeyDown({
  $script:count++
  Note ("KEY_DOWN " + $_.KeyCode)
  $label.Text = ("received " + $script:count + $nl + "last: KEY_DOWN " + $_.KeyCode)
})
$form.Add_KeyUp({
  $script:count++
  Note ("KEY_UP " + $_.KeyCode)
  $label.Text = ("received " + $script:count + $nl + "last: KEY_UP " + $_.KeyCode)
})
$form.Add_MouseDown({ Note ("MOUSE_DOWN " + $_.Button + " " + $_.X + " " + $_.Y) })
$form.Add_Activated({ Note "FOREGROUND gained" })
$form.Add_Deactivate({ Note "FOREGROUND lost" })
# READINESS GOES IN THE LOG, not to stdout. Output written inside an event
# handler does not reach the host's output stream, so a caller waiting on stdout
# waits for ever while the window sits there working perfectly. The log is the
# witness's own channel and the caller is reading it anyway.
$form.Add_Shown({ Note ("READY pid=" + $PID) })

# IT CLOSES ITSELF. A witness left on screen after a run is a window the user
# has to find and kill, and one they will mistake for part of their desktop.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = ${Math.max(1, Number(seconds) || DEFAULT_SECONDS) * 1000}
$timer.Add_Tick({ Note "TIMEOUT"; $timer.Stop(); $form.Close() })
$timer.Start()

[System.Windows.Forms.Application]::Run($form)
Note "CLOSED"
$sw.Close()
`;
}

/**
 * Start a witness and resolve once its window is really up.
 *
 * @returns {Promise<{pid,title,log,stop(),events(),received(name)}>}
 */
function start({ log, title = DEFAULT_TITLE, seconds = DEFAULT_SECONDS, dir = null } = {}) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('the key witness needs a Windows window to receive keys'));
  }
  const logFile = log || path.join(dir || process.cwd(), `keywitness-${Date.now()}.log`);
  fs.writeFileSync(logFile, '', 'utf8');
  const ps1 = logFile.replace(/\.log$/, '') + '.ps1';
  fs.writeFileSync(ps1, script({ title, log: logFile, seconds }), 'utf8');

  const child = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
    // `windowsHide` MUST STAY FALSE, and it is not a stray default.
    //
    // Node implements it with CREATE_NO_WINDOW plus a hidden default show
    // state, and a Windows Form inherits that state the first time it is
    // shown — so with it true the witness runs, logs READY, receives nothing,
    // and cannot be found by any window lookup, because it has no visible
    // window at all. It looked exactly like a delivery failure and was not one.
    //
    // The console window that comes with it is a second window on the same
    // process, which is precisely why nothing may aim at this by
    // MainWindowHandle. wininput.js finds it BY TITLE; the console's title is
    // the script path and can never be mistaken for the target.
    { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });

  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });

  const api = {
    pid: null,
    title,
    log: logFile,
    child,
    /** Everything the window has recorded so far, oldest first. */
    events() {
      let text = '';
      try { text = fs.readFileSync(logFile, 'utf8'); } catch { return []; }
      return text.split(/\r?\n/).filter(Boolean).map((l) => {
        const at = l.indexOf(' ');
        return { at: Number(l.slice(0, at)), event: l.slice(at + 1) };
      });
    },
    /** Did the window receive this exact event? The only answer that counts. */
    received(event) { return api.events().some((e) => e.event === event); },
    stop() { try { child.kill(); } catch { /* already gone */ } },
  };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      api.stop();
      reject(new Error(`the witness window did not appear within 20s: ${err.trim() || out.trim() || 'no output'}`));
    }, 20_000);
    const check = setInterval(() => {
      // THE LOG IS THE CHANNEL. See the note beside Add_Shown: a handler's
      // Write-Output never reaches stdout, so waiting on stdout waits for ever
      // while the window is up and working.
      const ready = api.events().find((e) => e.event.startsWith('READY pid='));
      if (!ready) return;
      clearInterval(check);
      clearTimeout(timer);
      api.pid = Number(ready.event.slice('READY pid='.length));
      resolve(api);
    }, 100);
    child.on('exit', (code) => {
      clearInterval(check);
      clearTimeout(timer);
      if (!api.pid) reject(new Error(`the witness exited ${code} before its window appeared: ${err.trim() || out.trim()}`));
    });
  });
}

module.exports = { start, DEFAULT_TITLE, DEFAULT_SECONDS };

// Run directly: `node tools/keywitness.js <logfile>` — useful on its own for
// checking by hand whether anything at all reaches a focused window.
if (require.main === module) {
  const log = process.argv[2] || path.join(process.cwd(), 'keywitness.log');
  const titleAt = process.argv.indexOf('--title');
  const secsAt = process.argv.indexOf('--seconds');
  start({
    log,
    title: titleAt > 0 ? process.argv[titleAt + 1] : DEFAULT_TITLE,
    seconds: secsAt > 0 ? Number(process.argv[secsAt + 1]) : DEFAULT_SECONDS,
  }).then((w) => {
    process.stdout.write(`${JSON.stringify({ pid: w.pid, title: w.title, log: w.log })}\n`);
    w.child.on('exit', () => {
      process.stdout.write(w.events().map((e) => e.event).join('\n') + '\n');
      process.exit(0);
    });
  }).catch((e) => {
    process.stderr.write(`${e.message}\n`);
    process.exit(1);
  });
}
