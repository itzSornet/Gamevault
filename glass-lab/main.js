const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1440, height: 900,
    backgroundColor: '#05060a',
    title: 'GameVault — Glass Lab',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.loadFile('index.html');
});
