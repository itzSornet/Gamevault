const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const out = process.argv[2] || '/tmp/lab.png';
const variant = process.argv[3] || 'frost';
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900, backgroundColor: '#05060a' });
  await win.loadFile(path.join(__dirname, '..', 'glass-lab', 'index.html'), { query: { variant, hover: process.argv.includes('--hover') ? '1' : '0' } });
  await new Promise((r) => setTimeout(r, 2500));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  console.log('[lab] wrote', out);
  app.exit(0);
});
