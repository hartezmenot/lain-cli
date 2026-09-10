'use strict';
const { Registry } = require('./contract');
function createRegistry() {
  const registry = new Registry();
  const telegram = require('./telegram'), discord = require('./discord');
  registry.register(telegram.caps, (cfg, deps) => new telegram.Telegram(cfg, deps));
  registry.register(discord.caps, (cfg, deps) => new discord.Discord(cfg, deps));
  const whatsapp = require('./whatsapp');
  registry.register(whatsapp.caps, (cfg, deps) => new whatsapp.WhatsApp(cfg, deps));
  return registry;
}
module.exports = { createRegistry };
