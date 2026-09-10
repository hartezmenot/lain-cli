'use strict';
function register({ define }) {
  define('/bot', { surface: true, flashMs: 0, args: '[start|stop|restart|platforms]', desc: 'LAIN messaging connections', async run(app, { rest = '' } = {}) {
    const service = require('./bot/service'); const action = rest.trim();
    if (['start', 'restart'].includes(action) && !app.ui?.enabled) {
      app.render.write('Run lain --bot for a foreground messaging service, or /bot start inside the interactive CLI.\n'); return;
    }
    if (action === 'platforms') {
      for (const c of require('./bot/registry').createRegistry().list()) app.render.write(`  ${c.platform}: text${c.buttons ? ', prompts' : ''}${c.mediaOut ? ', files' : ''}\n`);
      return;
    }
    if (action === 'stop' || action === 'restart') {
      if (app._botService) { await app._botService.stop(); app._botService = null; }
      else {
        await service.control('stop');
        if (action === 'stop') { app.render.write('Bot stop requested.\n'); return; }
        const end = Date.now() + 30000;
        while (true) {
          const status = await service.control();
          // A live endpoint can report stopped while its resources are closing.
          // Restart only after the old OS socket is actually released.
          if (status.state === 'stopped' && !status.ok) break;
          if (Date.now() >= end) { app.render.write('Bot is still stopping; retry /bot restart after it stops.\n'); return; }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    if (action === 'start' || action === 'restart') {
      if (!app._botService || app._botService.stopped) {
        try { app._botService = await service.start({ cfg: app.cfg, cwd: app.session.cwd }); }
        catch { app.render.write('Bot could not start; check configuration or an existing service.\n'); return; }
      }
    } else if (action && action !== 'stop') { app.render.write('Use /bot [start|stop|restart|platforms].\n'); return; }
    app.render.write(service.describe(await service.control()) + '\n');
  } });
}
module.exports = { register };
