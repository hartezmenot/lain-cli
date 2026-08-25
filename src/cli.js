'use strict';

const pkg = require('../package.json');

const USAGE = `LAIN v${pkg.version} — agentic coding CLI

Usage
  lain                      Start an interactive session (always EMPTY)
  lain -p "<prompt>"        Run one prompt and exit
  lain --resume <id>        Restore a saved session, then continue
  lain --sessions           List saved sessions and exit

Options
  -p, --print <prompt>   one-shot prompt
      --resume <id>      explicitly restore a session (the only way state crosses
                         a session boundary — there is no automatic resume)
      --sessions         list saved session ids
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
