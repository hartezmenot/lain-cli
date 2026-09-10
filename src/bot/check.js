'use strict';
const config = require('../config');
const doctor = require('./doctor');
const evidence = require('./certification');
const { Http } = require('./http');
async function authenticate(platform, settings, { env = process.env, rpc = require('../supervisor').callIfRunning,
  makeHttp = options => new Http(options) } = {}) {
  if (platform === 'telegram') {
    const result = await rpc({ op: 'remote_gateway_check' }, { timeoutMs: 25000 });
    if (!result?.authenticated || !result.botId) return { ok: false, authFailed: result?.authFailed === true,
      restartRequired: /unknown op/i.test(String(result?.error || '')) };
    return { ok: true, identity: String(result.botId), identityMatch: result.identityMatch !== false };
  }
  const token = env[settings.tokenEnv || `LAIN_${platform.toUpperCase()}_TOKEN`];
  if (!token) return { ok: false, unconfigured: true };
  require('../redact').register(token);
  const client = makeHttp(platform === 'discord'
    ? { base: 'https://discord.com/api/v10', authorization: `Bot ${token}` }
    : { base: `https://graph.facebook.com/${settings.apiVersion}`, authorization: `Bearer ${token}` });
  try {
    const me = await client.request(platform === 'discord' ? '/users/@me' : `/${encodeURIComponent(settings.phoneNumberId)}?fields=id`);
    if (!/^\d+$/.test(String(me?.id || '')) || (platform === 'discord' && me.bot !== true)) return { ok: false };
    const expected = platform === 'discord' ? settings.botId : settings.phoneNumberId;
    return { ok: true, identity: String(me.id), identityMatch: !expected || String(expected) === String(me.id) };
  } catch (error) { return { ok: false, authFailed: error?.authFailed === true || [401, 403].includes(error?.status) }; }
}
async function run(platform, { live = false, record = false, cfg = config.load(), dir = config.configDir(), env = process.env,
  now = Date.now(), inspect = doctor.inspect, auth = authenticate, control, rpc, makeHttp } = {}) {
  if (!evidence.PLATFORMS.includes(platform)) return { code: 2, text: 'Use --bot-check telegram|discord|whatsapp [--live] [--record].' };
  if (record && !live) return { code: 2, text: '--record requires --bot-check <platform> --live; local observations are never live certificates.' };
  const report = await inspect({ cfg, dir, env, now, control, rpc });
  const row = report.platforms.find(p => p.platform === platform), settings = cfg.bot?.platforms?.[platform] || {};
  if (!live) return { code: row.configured ? 0 : 1, text: doctor.render(report, platform)
    + '\n  Local observation only. Use --live for external authentication; --record saves the resulting evidence.' };
  const checks = Object.fromEntries(evidence.CHECKS.map(k => [k, 'not_verified']));
  let verified = { ok: false, unconfigured: true };
  if (row.configured) {
    try { verified = await auth(platform, settings, { env, rpc, makeHttp }); }
    catch { verified = { ok: false }; }
  }
  if (!verified.ok) return { code: 1, text: `Bot check: ${platform}  ${verified.unconfigured ? 'UNCONFIGURED' : verified.authFailed ? 'AUTH FAILED' : 'CONFIGURED · authentication unavailable'}\n`
    + (verified.restartRequired || row.restartRequired ? '  Running supervisor is older than the gateway protocol; restart only after its existing work can stop.\n' : '')
    + '  NOT LIVE VERIFIED. No certificate was written.' };
  checks.authentication = 'passed';
  const fingerprint = evidence.accountFingerprint(platform, settings.accountId, verified.identity);
  const identityMatch = verified.identityMatch !== false && (!row.accountFingerprint || row.accountFingerprint === fingerprint);
  checks.identity = identityMatch ? 'passed' : 'failed';
  const current = row.currentFingerprint === fingerprint && identityMatch;
  if (current && row.diagnostics.connected === true) checks.connection = 'passed';
  if (current && row.diagnostics.heartbeatHealthy === true) checks.heartbeat = 'passed';
  // Aggregate traffic proves only these observations. It cannot prove that an
  // approval, stop or reconnect round trip completed correctly.
  if (current && row.diagnostics.inboundAccepted > 0) checks.inbound = 'passed';
  if (current && row.diagnostics.deliveryAcknowledged > 0) checks.outbound = 'passed';
  const state = !identityMatch ? 'CONFIGURED · IDENTITY MISMATCH'
    : checks.connection === 'passed' ? (checks.inbound === 'passed' && checks.outbound === 'passed' ? 'DELIVERY VERIFIED' : 'CONNECTED') : 'CONFIGURED';
  const lines = [`Bot check: ${platform}  ${state}`, `  LIVE VERIFIED checks: ${evidence.CHECKS.filter(k => checks[k] === 'passed').join(', ')}`,
    `  NOT LIVE VERIFIED checks: ${evidence.CHECKS.filter(k => checks[k] !== 'passed').join(', ')}`];
  if (platform === 'whatsapp') lines.push(`  WhatsApp local adapter: ${row.diagnostics.localListener ? 'ready' : 'not listening'}`, '  Public webhook: not verified; complete the HTTPS operator checklist.');
  lines.push('  Full platform certification remains incomplete; use the live checklist in docs/BOT.md.');
  if (record) {
    if (!identityMatch) lines.push('  Certificate not written: account/profile identity mismatch.');
    else {
      try { evidence.record(dir, platform, settings, fingerprint, checks, now); lines.push('  Non-secret evidence saved (24-hour freshness; bound to this adapter, configuration and account).'); }
      catch { return { code: 1, checks, text: lines.concat('  Evidence could not be saved; check config-home permissions.').join('\n') }; }
    }
  }
  return { code: identityMatch ? 0 : 1, checks, text: lines.join('\n') };
}
async function main(platform, options = {}) {
  if (options.live) process.stdout.write('LIVE external requests: authenticate the configured bot/account. Existing gateway state is observed; no messages are sent and no service is started or restarted.\n');
  try { const result = await run(platform, options); process.stdout.write(result.text + '\n'); return result.code; }
  catch { process.stderr.write('Bot check unavailable; inspect configuration and the existing service. No credentials are printed.\n'); return 1; }
}
module.exports = { authenticate, run, main };
