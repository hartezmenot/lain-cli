'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const evidence = require('./certification');
const { accountFingerprint } = evidence;
function present(env, name) { return typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && Boolean(env[name]); }
function access(target) {
  let probe = target;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try { fs.accessSync(probe, fs.constants.R_OK | fs.constants.W_OK); return fs.existsSync(target) ? 'accessible' : 'parent accessible; not created'; }
  catch { return 'not accessible'; }
}
function transport(dir) {
  const file = path.join(dir, 'bot', 'transport.json');
  try {
    if (fs.statSync(file).size > 32 * 1024 * 1024) return { state: 'invalid' };
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !value.sessions || !value.inbox || !value.deliveries) return { state: 'invalid' };
    return { state: 'healthy', accounts: value.accounts || {} };
  } catch (e) { return { state: e.code === 'ENOENT' ? 'not created' : 'invalid' }; }
}
async function inspect({ cfg = config.load(), dir = config.configDir(), env = process.env, now = Date.now(),
  control = require('./service').control, rpc = require('../supervisor').callIfRunning } = {}) {
  const [result, telegram] = await Promise.allSettled([
    control('status', dir), rpc({ op: 'remote_gateway_status' }, { timeoutMs: 1500 }),
  ]);
  const status = result.status === 'fulfilled' ? result.value : {}, tg = telegram.status === 'fulfilled' ? telegram.value : {};
  const store = transport(dir);
  const rows = evidence.PLATFORMS.map(platform => {
    const settings = cfg.bot?.platforms?.[platform] || {}, account = settings.accountId || 'default';
    const current = (status?.platforms || []).find(p => p.platform === platform && p.accountId === account);
    const diagnostics = current?.diagnostics || {};
    const expected = platform === 'telegram' ? (tg?.botId || store.accounts?.[`${platform}:${account}`] || settings.botId)
      : (store.accounts?.[`${platform}:${account}`] || (platform === 'whatsapp' ? settings.phoneNumberId : settings.botId));
    const fingerprint = expected ? accountFingerprint(platform, account, expected) : current?.accountFingerprint;
    const token = platform === 'telegram' ? Boolean(tg?.configured || present(env, settings.tokenEnv || 'LAIN_TELEGRAM_TOKEN'))
      : present(env, settings.tokenEnv || `LAIN_${platform.toUpperCase()}_TOKEN`);
    const credentials = platform !== 'whatsapp' ? token : token
      && present(env, settings.appSecretEnv || 'LAIN_WHATSAPP_APP_SECRET') && present(env, settings.verifyTokenEnv || 'LAIN_WHATSAPP_VERIFY_TOKEN');
    const configured = Boolean(settings.enabled && credentials && (platform !== 'whatsapp'
      || (/^\d{5,30}$/.test(String(settings.phoneNumberId || '')) && /^v\d{2}\.0$/.test(settings.apiVersion || ''))));
    const connected = current?.state === 'listening' && (platform !== 'discord' || diagnostics.activeSession === true);
    const row = { platform, enabled: settings.enabled === true, configured, tokenPresent: token,
      state: !configured ? 'UNCONFIGURED' : (connected && platform !== 'whatsapp' ? 'CONNECTED' : 'CONFIGURED'),
      checks: [], accountFingerprint: fingerprint, diagnostics,
      certification: evidence.read(dir, platform, settings, fingerprint, now) };
    row.checks.push(['enabled', row.enabled ? 'yes' : 'no'], ['credential', token ? 'present' : 'missing']);
    if (platform === 'telegram') {
      const protocol = tg?.ok && tg.gatewayProtocol >= 1;
      const older = !tg?.ok && /unknown op/i.test(String(tg?.error || ''));
      row.restartRequired = older;
      row.checks.push(['supervisor mailbox protocol', protocol ? 'supported' : older ? 'older supervisor; restart required after its work can stop' : 'unavailable; supervisor is not reachable'],
        ['gateway mode', protocol ? (tg.gatewayEnabled ? 'latched' : 'not latched; /bot start attaches') : 'unknown'],
        ['gateway lease', protocol ? (tg.gatewayOwned ? 'attached' : 'not attached') : 'unknown'],
        ['mailbox', protocol ? (tg.mailboxHealthy ? 'healthy' : 'unhealthy') : 'unknown']);
      const identityMatches = !settings.botId || String(settings.botId) === String(tg?.botId || '');
      const bound = store.accounts?.[`${platform}:${account}`];
      row.checks.push(['identity', tg?.botId ? (identityMatches && (!bound || bound === tg.botId) ? 'matches configured profile' : 'MISMATCH; use the intended bot/profile') : 'not observed']);
    } else if (platform === 'discord') {
      row.checks.push(['intents', diagnostics.intents === 37377 ? 'required intents requested; portal approval requires live connection' : 'guilds, guild messages, DMs, message content required'],
        ['gateway', diagnostics.gatewayReachable ? 'reachable' : 'not observed'],
        ['session', diagnostics.activeSession ? 'active' : 'not observed'],
        ['heartbeat', diagnostics.heartbeatHealthy === true ? 'healthy' : diagnostics.heartbeatHealthy === false ? 'not healthy' : 'not observed']);
    } else {
      row.checks.push(['app secret', present(env, settings.appSecretEnv || 'LAIN_WHATSAPP_APP_SECRET') ? 'present' : 'missing'],
        ['webhook verify token', present(env, settings.verifyTokenEnv || 'LAIN_WHATSAPP_VERIFY_TOKEN') ? 'present' : 'missing'],
        ['Graph version', /^v\d{2}\.0$/.test(settings.apiVersion || '') ? 'configured; support requires live check' : 'invalid or missing'],
        ['phone/account identity', /^\d{5,30}$/.test(String(settings.phoneNumberId || '')) ? 'configured; live match not verified' : 'invalid or missing'],
        ['local adapter', diagnostics.localListener === true || current?.state === 'listening' ? 'ready' : 'not listening'],
        ['public webhook', 'not verified; HTTPS forwarding requires an external probe']);
    }
    return row;
  });
  return { state: status?.ok ? status.state : 'stopped or unavailable', platforms: rows,
    shared: [['control socket', status?.ok ? 'healthy; one service owns the configured endpoint' : 'not observed; no service was started'],
      ['session store access', access(path.join(dir, 'sessions'))], ['receipt store', store.state],
      ['receipt store access', access(path.join(dir, 'bot'))]],
    // Transport observations are sanitized above; raw RPCs and private routing
    // records never leave this function.
  };
}
function render(report, onlyPlatform) {
  const lines = ['Bot doctor (read-only)'];
  for (const row of report.platforms.filter(p => !onlyPlatform || p.platform === onlyPlatform)) {
    lines.push(`  ${row.platform[0].toUpperCase() + row.platform.slice(1)}  ${row.state}`);
    for (const [name, value] of row.checks) lines.push(`    ${name}: ${value}`);
    const cert = row.certification;
    lines.push(`    live certification: ${cert.state === 'current' ? 'recorded live checks at ' + cert.timestamp : 'NOT LIVE VERIFIED' + (cert.state === 'stale' ? ' (previous evidence is stale or identity cannot be matched)' : cert.state === 'invalid' ? ' (invalid evidence record)' : '')}`);
    if (cert.state === 'current') lines.push(`    LIVE VERIFIED checks: ${evidence.CHECKS.filter(k => cert.checks[k] === 'passed').join(', ')}`);
  }
  for (const [name, value] of report.shared) lines.push(`  ${name}: ${value}`);
  lines.push('  Filesystem access is an observation, not a write test. No state was created.');
  return lines.join('\n');
}
module.exports = { inspect, render, present, access, transport };
