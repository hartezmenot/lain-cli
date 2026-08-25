'use strict';

/**
 * TEST APPARATUS — a bare SendInput, so a failure can be ATTRIBUTED.
 *
 * READ THIS BEFORE ASSUMING IT IS A CAPABILITY. It is not one, and it must
 * never become one:
 *
 *   · nothing in `src/` requires it, so no model can reach it
 *   · it is not registered as a tool and is not in the tool catalogue
 *   · it lives in `tools/`, beside the witness it exists to check
 *
 * lain-probe owns OS input. That boundary is deliberate and this does not move
 * it. What this exists for is one question the Probe cannot answer about
 * itself:
 *
 *      when a key does not arrive, is the Probe wrong, or can nothing on this
 *      machine deliver a synthesised keystroke to a focused window at all?
 *
 * Those two have identical symptoms and completely different fixes, and
 * guessing between them is how "it doesn't work" surveys the wrong half of the
 * system. So the live keyboard test sends one key through THIS path first. If
 * the witness records it, the machine is capable and any Probe failure is the
 * Probe's; if the witness records nothing here either, the problem is below
 * both of them — Windows is refusing injection into that window — and saying
 * so is the honest verdict.
 *
 * IT AIMS BEFORE IT FIRES, exactly as the real path must: focus the window,
 * read the foreground back, and send nothing at all unless they match. An
 * unaimed keystroke goes into whatever the person is looking at.
 */

const { spawnSync } = require('child_process');

/** Virtual-key codes for the few keys the apparatus needs. */
const VK = Object.freeze({ W: 0x57, A: 0x41, S: 0x53, D: 0x44, SPACE: 0x20, F13: 0x7C });

const PINVOKE = `
$sig = @"
using System;
using System.Runtime.InteropServices;
public static class LainNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size=40)]
  public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] p, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  public static string TitleOf(IntPtr h) { var sb = new System.Text.StringBuilder(512); GetWindowTextW(h, sb, 512); return sb.ToString(); }
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  // RAISE A WINDOW THE WAY WINDOWS ACTUALLY ALLOWS.
  //
  // A bare SetForegroundWindow is REFUSED when another application owns the
  // foreground. That is the foreground lock, and it is not a bug in Windows.
  // Measured here: with Chrome in front, SetForegroundWindow on the target
  // returned and the foreground did not move, so every key that followed would
  // have gone to Chrome.
  //
  // The documented way round it is to attach this thread's input queue to the
  // foreground thread's for the duration of the call, which makes the two share
  // one foreground state and lets the change through. It is detached again
  // immediately: leaving it attached couples the two message queues.
  //
  // THIS IS WHAT THE PROBE'S window.focus DOES NOT DO. It is a bare
  // SetForegroundWindow followed by a GetForegroundWindow check, so it reports
  // not-focused honestly and cannot succeed while anything else owns the
  // foreground. That is a real, reproducible cause of "the Probe focused the
  // game and the keys went nowhere", and it is a finding about the Probe rather
  // than something LAIN can fix from this side.
  public static bool Raise(IntPtr h) {
    uint fgPid;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
    uint me = GetCurrentThreadId();
    bool attached = (fgThread != me) && AttachThreadInput(me, fgThread, true);
    try {
      // NO ShowWindow HERE, and this is not an omission.
      //
      // It was ShowWindow(h, SW_SHOW) and it HID the window. The first
      // ShowWindow against a process uses the show state in that process's
      // STARTUPINFO rather than the flag passed, and for a spawned helper
      // that state is hidden. Measured directly: IsWindowVisible true before
      // the call and false after it, after which every lookup reported "no
      // visible window" and refused to send — a self-inflicted delivery
      // failure that looked exactly like the one under investigation.
      //
      // A window that is already up does not need showing. It needs raising.
      BringWindowToTop(h);
      return SetForegroundWindow(h);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }
  // FIND THE WINDOW BY ITS TITLE, not by MainWindowHandle.
  //
  // MainWindowHandle is whatever Windows currently considers a process's main
  // window, and for a PowerShell-hosted form that is not stable: it moved once
  // the form lost the foreground, so the second half of a hold aimed at a
  // different window, verified THAT one in front, and sent the key up into it.
  // The target's own log is what caught it - KEY_DOWN, then nothing. A title is
  // what the caller actually named, and it does not move.
  public static IntPtr FindByTitle(uint wantPid, string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      if (!IsWindowVisible(h)) return true;
      if (TitleOf(h) != title) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (wantPid != 0 && pid != wantPid) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static uint Key(ushort vk, bool up) {
    INPUT[] i = new INPUT[1];
    i[0].type = 1;
    i[0].ki.wVk = vk;
    i[0].ki.dwFlags = up ? (uint)2 : (uint)0;
    return SendInput(1, i, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
Add-Type -TypeDefinition $sig -Language CSharp
`;

function ps(body) {
  const r = spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PINVOKE + '\n' + body],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return { out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), code: r.status };
}

/**
 * Bring a window to the front BY ITS TITLE, and read the foreground back.
 *
 * `pid` narrows the search when given, so a stray window of the same name
 * belonging to something else is never the thing that gets typed into.
 *
 * @returns {{ok:boolean, title:string, why:string}}
 */
function focus(pid, title) {
  const want = String(title || '');
  const r = ps(`
$h = [LainNative]::FindByTitle(${Number(pid) || 0}, ${JSON.stringify(want)})
if ($h -eq 0) { Write-Output "NOWINDOW"; exit }
[void][LainNative]::Raise($h)
Start-Sleep -Milliseconds 250
$fg = [LainNative]::GetForegroundWindow()
Write-Output ("FG " + ($fg -eq $h) + " " + [LainNative]::TitleOf($fg))
`);
  if (r.out.startsWith('NOWINDOW')) {
    return { ok: false, title: '', why: `no visible window titled "${want}"${pid ? ` in process ${pid}` : ''}` };
  }
  const m = /^FG (True|False) ?(.*)$/s.exec(r.out);
  if (!m) return { ok: false, title: '', why: r.err || r.out || 'no answer from the foreground check' };
  return {
    ok: m[1] === 'True',
    title: (m[2] || '').trim(),
    why: m[1] === 'True' ? '' : `the foreground is "${(m[2] || '').trim()}" — Windows refused the change`,
  };
}

/**
 * Send one key DOWN or UP, but only with `pid`'s window verified in front.
 *
 * `verify` is not optional and there is no flag to skip it. The whole point of
 * this apparatus is to be the trustworthy half of the comparison, and a keypress
 * fired at an unknown foreground is not trustworthy — it is the bug.
 *
 * @returns {{sent:boolean, accepted:number, why:string, title:string}}
 */
function key(pid, vk, { up = false, title = '' } = {}) {
  // FIND, FOCUS, VERIFY AND SEND IN ONE PROCESS.
  //
  // These were two PowerShell invocations, and the gap between them was a real
  // hole: when the focusing process exits, Windows hands the foreground back to
  // whatever had it before, so the second process injected into a foreground
  // nobody had checked. The target's own log is what exposed it — a hold that
  // recorded KEY_DOWN, then `FOREGROUND lost`, and no KEY_UP at all.
  //
  // The verification and the injection have to be the same instant, or the
  // verification is about a moment that has already passed. That is the same
  // rule keyboarddelivery.js follows on the Probe path, for the same reason.
  const r = ps(`
$h = [LainNative]::FindByTitle(${Number(pid) || 0}, ${JSON.stringify(String(title || ''))})
if ($h -eq 0) { Write-Output "NOWINDOW"; exit }
[void][LainNative]::Raise($h)
Start-Sleep -Milliseconds 250
$fg = [LainNative]::GetForegroundWindow()
if ($fg -ne $h) { Write-Output ("NOTFRONT " + [LainNative]::TitleOf($fg)); exit }
Write-Output ("N " + [LainNative]::Key(${Number(vk)}, $${up ? 'true' : 'false'}) + " " + [LainNative]::TitleOf($h))
`);
  if (r.out.startsWith('NOWINDOW')) {
    return { sent: false, accepted: 0, title: '', why: `NOTHING WAS SENT — no visible window titled "${title}"` };
  }
  if (r.out.startsWith('NOTFRONT')) {
    const front = r.out.slice('NOTFRONT'.length).trim();
    return { sent: false, accepted: 0, title: front, why: `NOTHING WAS SENT — the foreground is "${front}"` };
  }
  const m = /^N (\d+) ?(.*)$/m.exec(r.out);
  return {
    sent: Boolean(m) && Number(m[1]) > 0,
    accepted: m ? Number(m[1]) : 0,
    why: m ? '' : (r.err || r.out || 'SendInput gave no count'),
    title: m ? (m[2] || '').trim() : '',
  };
}

/** A tap is the pair, in order, with the window verified before each edge. */
/**
 * WHAT IS IN FRONT RIGHT NOW.
 *
 * So a test can NAME what took the foreground instead of reporting "the key did
 * not arrive". A fullscreen game that keeps grabbing it back is not a failure of
 * the code under test, and it is not verification either — it is a desktop that
 * cannot answer the question, and saying which window is doing it is the
 * difference between a diagnosis and a shrug.
 */
function foreground() {
  const r = ps('Write-Output ("FG " + [LainNative]::TitleOf([LainNative]::GetForegroundWindow()))');
  const m = /^FG ?(.*)$/m.exec(r.out);
  return m ? (m[1] || '').trim() : '';
}

function tap(pid, vk, { title = '' } = {}) {
  const down = key(pid, vk, { up: false, title });
  if (!down.sent) return { down, up: null };
  const up = key(pid, vk, { up: true, title });
  return { down, up };
}

module.exports = { VK, focus, key, tap, foreground };
