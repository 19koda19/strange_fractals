const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');

const isDevelopment = process.argv.includes('--dev');

function send(command) {
  const window = BrowserWindow.getFocusedWindow();
  window?.webContents.send('noema:command', command);
}

function createMenu() {
  const modifier = process.platform === 'darwin' ? 'Cmd' : 'Ctrl';
  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: 'NOEMA',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'Instrument',
      submenu: [
        { label: 'New seed', accelerator: `${modifier}+N`, click: () => send('new-seed') },
        { label: 'Copy living link', accelerator: `${modifier}+Shift+C`, click: () => send('copy-link') },
        { label: 'Export still', accelerator: `${modifier}+Shift+S`, click: () => send('export') },
        { type: 'separator' },
        { label: 'Pause / breathe', accelerator: 'Esc', click: () => send('pause') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Return to eclipse', accelerator: `${modifier}+0`, click: () => send('reset-view') },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload', visible: isDevelopment },
        { role: 'toggleDevTools', visible: isDevelopment },
      ],
    },
    {
      role: 'help',
      submenu: [{ label: 'Reveal choreography', accelerator: 'F1', click: () => send('help') }],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: '#05030a',
    autoHideMenuBar: true,
    show: false,
    title: 'NOEMA',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());

  if (isDevelopment) {
    window.loadURL('http://127.0.0.1:5173');
  } else {
    window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  createMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
