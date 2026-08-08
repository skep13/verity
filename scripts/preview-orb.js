// Throwaway: render the orb preview offscreen and save frames, so the animation
// can be inspected without a display. Run with: npx electron scripts/_capture.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 880,
    height: 260,
    show: false,
    backgroundColor: '#0a0b0d',
  });
  await win.loadFile(path.join(__dirname, 'orb-preview.html'));

  // Let the bars settle from zero before sampling.
  await new Promise((r) => setTimeout(r, 1800));

  for (let i = 0; i < 3; i++) {
    const image = await win.capturePage();
    fs.writeFileSync(`/tmp/orb-frame-${i}.png`, image.toPNG());
    await new Promise((r) => setTimeout(r, 420));
  }
  console.log('captured 3 frames');
  app.quit();
});
