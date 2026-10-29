const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const out = process.argv[2] || '/tmp/mock.png';
const palette = process.argv.includes('--palette');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000 });
  await win.loadFile(path.join(__dirname, '..', 'mockups', 'flutter-copy.html'), { query: { palette: palette ? '1' : '0' } });
  await new Promise((r) => setTimeout(r, 3500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('[mock] wrote', out);
  app.exit(0);
});
