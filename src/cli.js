'use strict';

const pkg = require('../package.json');

const USAGE = `LAIN v${pkg.version} — agentic coding CLI

Usage
  lain                      Start an interactive session (always EMPTY)
  lain -p "<prompt>"        Run one prompt and exit
  lain --resume <id>        Restore a saved session, then continue
  lain --sessions           List saved sessions and exit
  lain --doctor             Report what works on this machine, and exit
  lain --bot                Run the configured messaging gateway in the foreground

Options
  -p, --print <prompt>   one-shot prompt
      --resume <id>      explicitly restore a session (the only way state crosses
                         a session boundary — there is no automatic resume)
      --sessions         list saved session ids
      --doctor           what this installation can and cannot do, and why.
                         Touches no provider and creates no session — this is
                         the command an installer uses to verify itself.
      --cwd <dir>        working directory for the session
  -v, --version          print version
  -h, --help             this
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-p': case '--print': opts.print = argv[++i]; break;
      case '--resume': opts.resume = argv[++i]; break;
      case '--sessions': opts.sessions = true; break;
      case '--doctor': opts.doctor = true; break;
      case '--bot': opts.bot = true; break;
      case '--cwd': opts.cwd = argv[++i]; break;
      default:
        if (a.startsWith('-')) { opts.unknown = a; return opts; }
        opts._.push(a);
    }
  }
  // `lain -p Build a game` from a launcher that split the string
  if (opts.print !== undefined && opts._.length) {
    opts.print = [opts.print, ...opts._].join(' ');
    opts._ = [];
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.unknown) {
    process.stderr.write(`lain: unknown option ${opts.unknown} (try --help)\n`);
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE); return 0; }
  if (opts.version) { process.stdout.write(`lain ${pkg.version} (node ${process.version})\n`); return 0; }
  if (opts.bot) return require('./bot/service').foreground({ cwd: opts.cwd });

  // ---- THE POST-INSTALL VERIFICATION COMMAND ----------------------------
  //
  // A FLAG RATHER THAN ONLY `lain /harness doctor`, for one unglamorous reason:
  // an argument beginning with `/` is rewritten into a Windows path by MSYS and
  // Git Bash before node ever sees it, so the slash form needs quoting exactly
  // where an installer is least able to guarantee it. `--doctor` is safe in
  // cmd, PowerShell, bash, zsh and fish alike.
  //
  // It builds no session, reads no credential and contacts nothing. That is
  // what makes it usable as an installation check on a machine that has not
  // been configured yet — which is every machine, at the moment it is checked.
  if (opts.doctor) {
    const { Harness } = require('./harness');
    const h = new Harness({ workspace: opts.cwd || process.cwd(), persist: true });
    try {
      const rows = await h.doctor();
      process.stdout.write(require('./harnessreport').render(rows, Harness.summarise(rows)));
      process.stdout.write(require('./bot/service').describe(await require('./bot/service').control()) + '\n');
      return Harness.summarise(rows).ok ? 0 : 1;
    } finally {
      await h.shutdown();
    }
  }

  if (opts.sessions) {
    const { Session } = require('./session');
    const ids = Session.list(50);
    process.stdout.write(ids.length ? ids.join('\n') + '\n' : 'no saved sessions\n');
    return 0;
  }

  const { App } = require('./app');
  const app = new App({ resume: opts.resume, cwd: opts.cwd, interactive: opts.print === undefined });

  const oneShot = opts.print !== undefined ? opts.print : (opts._.length ? opts._.join(' ') : undefined);
  if (oneShot !== undefined) {
    if (!String(oneShot).trim()) { process.stderr.write('lain: empty prompt\n'); return 2; }
    return await app.once(String(oneShot));
  }
  return await app.start();
}

module.exports = { main, parseArgs, USAGE };
