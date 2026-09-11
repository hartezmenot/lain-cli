'use strict';
// Bounded, non-secret observations. A certificate never authorizes a message,
// replaces a transport receipt, or treats fixture success as live evidence.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PLATFORMS = ['telegram', 'discord', 'whatsapp'];
const CHECKS = ['authentication', 'identity', 'connection', 'heartbeat', 'inbound', 'outbound', 'typing', 'edit',
  'stop', 'background', 'approval', 'clarify', 'reconnect', 'dedupe', 'webhook', 'media', 'responseWindow'];
const MAX_AGE = 24 * 60 * 60 * 1000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
function accountFingerprint(platform, accountId, identity) { return hash([platform, String(accountId || 'default'), String(identity)]); }
function configurationFingerprint(platform, cfg) {
  return hash([platform, ...['enabled', 'accountId', 'botId', 'phoneNumberId', 'businessAccountId', 'apiVersion', 'port', 'tokenEnv',
    'appSecretEnv', 'verifyTokenEnv', 'allowUsers', 'allowChats', 'allowGuilds', 'allowChannels', 'ambient'].map(k => [k, cfg[k] ?? null])]);
}
function adapterVersion(platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('unsupported platform');
  return `${require('../../package.json').version}:${hash(fs.readFileSync(path.join(__dirname, platform + '.js'), 'utf8'))}`;
}
function file(dir, platform) {
  if (!PLATFORMS.includes(platform)) throw new Error('unsupported platform');
  return path.join(dir, 'bot', 'certification', platform + '.json');
}
function read(dir, platform, settings, identityFingerprint, now = Date.now()) {
  let value;
  try {
    const target = file(dir, platform);
    if (fs.statSync(target).size > 16384) return { state: 'invalid' };
    value = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (e) { return { state: e.code === 'ENOENT' ? 'absent' : 'invalid' }; }
  const at = Date.parse(value?.timestamp), checks = value?.checks;
  if (value?.schema !== 1 || value.platform !== platform || !Number.isFinite(at) || !/^[a-f0-9]{24}$/.test(value.accountFingerprint)
    || !checks || typeof checks !== 'object' || CHECKS.some(k => !['passed', 'not_verified', 'failed'].includes(checks[k]))
    || checks.authentication !== 'passed') return { state: 'invalid' };
  const current = at <= now + 60000 && now - at <= MAX_AGE && value.adapterVersion === adapterVersion(platform)
    && value.configurationFingerprint === configurationFingerprint(platform, settings)
    && identityFingerprint === value.accountFingerprint;
  // Only copy the bounded schema; a manually edited file cannot inject output.
  return { state: current ? 'current' : 'stale', timestamp: new Date(at).toISOString(),
    checks: Object.fromEntries(CHECKS.map(k => [k, checks[k]])) };
}
function record(dir, platform, settings, identityFingerprint, checks, now = Date.now()) {
  if (!/^[a-f0-9]{24}$/.test(identityFingerprint) || checks.authentication !== 'passed') throw new Error('authenticated identity required');
  const value = { schema: 1, platform, timestamp: new Date(now).toISOString(), adapterVersion: adapterVersion(platform),
    accountFingerprint: identityFingerprint, configurationFingerprint: configurationFingerprint(platform, settings),
    checks: Object.fromEntries(CHECKS.map(k => [k, ['passed', 'failed'].includes(checks[k]) ? checks[k] : 'not_verified'])) };
  const target = file(dir, platform), parent = path.dirname(target);
  // Resolve the existing bot directory before writing, so evidence cannot be
  // redirected into another project through a symlink or junction.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(dir);
  for (const part of [path.join(dir, 'bot'), parent]) {
    if (fs.existsSync(part)) {
      const relative = path.relative(root, fs.realpathSync(part));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('certification directory escapes config home');
    }
    fs.mkdirSync(part, { recursive: true, mode: 0o700 });
  }
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('certification file is a link');
  const temp = target + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, target); }
  finally { try { fs.unlinkSync(temp); } catch { /* already renamed */ } }
  return value;
}
module.exports = { PLATFORMS, CHECKS, MAX_AGE, accountFingerprint, configurationFingerprint, adapterVersion, read, record };
