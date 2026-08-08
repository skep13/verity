// Render the real renderer with a stubbed bridge and save screenshots, so the
// layout can be inspected without a display.
//   npx electron scripts/preview-ui.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    show: false,
    backgroundColor: '#0d0e11',
    webPreferences: {
      preload: path.join(__dirname, 'preview-ui-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Match the real window: a sandboxed preload cannot require anything.
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (...a) => {
    const d = a[0] && typeof a[0] === 'object' && 'message' in a[0] ? a[0] : { level: a[1], message: a[2] };
    console.log(`[renderer:${d.level}] ${d.message}`);
  });

  await win.loadFile(path.join(__dirname, '..', 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1800));

  // Empty state, as it looks on launch.
  fs.writeFileSync('/tmp/ui-empty.png', (await win.capturePage()).toPNG());

  // A short conversation, to check transcript density and the tool trace.
  await win.webContents.executeJavaScript(`
    (() => {
      document.getElementById('emptyState')?.remove();
      document.getElementById('messages').classList.remove('is-empty');
      const assistant = document.querySelector('.brand h1').textContent;
      const add = (role, text) => {
        const w = document.createElement('div'); w.className = 'msg ' + role;
        const l = document.createElement('div'); l.className = 'msg-role';
        l.textContent = role === 'user' ? 'You' : assistant;
        const b = document.createElement('div'); b.className = 'msg-body'; b.textContent = text;
        w.append(l, b); document.getElementById('messages').append(w);
      };
      add('user', 'What do you know about the Antikythera mechanism?');
      const t = document.createElement('div'); t.className = 'trace';
      t.innerHTML = '<span class="spark"></span><span class="trace-text">search Wikipedia for “Antikythera mechanism” — 5 results</span>';
      document.getElementById('messages').append(t);
      add('assistant', 'It is an ancient Greek geared device, recovered from a shipwreck off Antikythera in 1901, used to predict astronomical positions and eclipses decades ahead. It is generally dated to the second century BC.');
      const t2 = document.createElement('div'); t2.className = 'trace';
      t2.innerHTML = '<span class="spark"></span><span class="trace-text">save note “Antikythera mechanism” — created Verity/Antikythera mechanism.md</span>';
      document.getElementById('messages').append(t2);
      document.getElementById('stateLabel').textContent = 'Listening';
      document.getElementById('stateLabel').dataset.state = 'listening';
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));
  fs.writeFileSync('/tmp/ui-chat.png', (await win.capturePage()).toPNG());

  console.log('wrote /tmp/ui-empty.png and /tmp/ui-chat.png');
  app.quit();
});
