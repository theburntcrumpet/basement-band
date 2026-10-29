// Electron main process: window, app:// protocol for bundled files, and file-system IPC.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const plugins = require('./plugin-host.js');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
// Packaged builds keep the sample library in resources/assets (see package.json extraResources).
const ASSETS = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(ROOT, 'assets');
const TONE = path.join(ROOT, 'node_modules', 'tone', 'build', 'Tone.js');
const LAME = path.join(ROOT, 'node_modules', '@breezystack', 'lamejs', 'dist', 'lamejs.js');
const EXPORT_TYPES = { wav: 'WAV Audio', mp3: 'MP3 Audio', flac: 'FLAC Audio', mid: 'MIDI File' };
const AUDIO_EXT = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac', '.aif', '.aiff', '.webm', '.opus']);
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
const INSTRUMENT_EXT = new Set(['.sf2', '.sfz']);

// Test runs get their own settings so they never touch the user's library.
if (process.env.BB_SMOKE) {
  app.setPath('userData', path.join(require('node:os').tmpdir(), `basement-band-test-${process.pid}`));
  if (process.env.BB_TEST_SETTINGS) {
    require('node:fs').mkdirSync(app.getPath('userData'), { recursive: true });
    require('node:fs').writeFileSync(path.join(app.getPath('userData'), 'settings.json'), process.env.BB_TEST_SETTINGS);
  }
}

// Low-latency mode: Chromium's smallest audio buffer (128 frames). Must be set before the app starts,
// so it reads the saved setting synchronously; changing it takes effect after a restart.
const bootSettings = (() => {
  try { return JSON.parse(require('node:fs').readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch { return {}; }
})();
// Audio performance mode (Settings): 'low' latency, 'balanced' (default) or 'stable' for slower machines.
const bootAudioMode = bootSettings.audioMode || (bootSettings.lowLatency ? 'low' : 'balanced');
if (bootAudioMode === 'low') app.commandLine.appendSwitch('audio-buffer-size', '128');
if (bootAudioMode === 'stable') app.commandLine.appendSwitch('audio-buffer-size', '1024');
if (bootSettings.theme) nativeTheme.themeSource = bootSettings.theme;

// On Linux/PipeWire the graph's block size ("quantum", often 1024 frames = 21 ms) sits under every app.
// While monitoring in low-latency mode we ask for 128 frames, and restore the previous value afterwards.
const { execFile } = require('node:child_process');
let savedQuantum = null;
function pwMetadata(args) {
  return new Promise(resolve => execFile('pw-metadata', ['-n', 'settings', ...args], { timeout: 3000 }, (err, out) => resolve(err ? null : String(out))));
}
async function setLowLatencyQuantum(on) {
  if (process.platform !== 'linux') return false;
  if (on) {
    if (savedQuantum !== null) return true;
    const current = await pwMetadata([]);
    if (current === null) return false; // not PipeWire
    const m = /clock\.force-quantum' value:'(\d+)'/.exec(current);
    savedQuantum = m ? m[1] : '0';
    return (await pwMetadata(['0', 'clock.force-quantum', '128'])) !== null;
  }
  if (savedQuantum === null) return false;
  const restore = savedQuantum;
  savedQuantum = null;
  return (await pwMetadata(['0', 'clock.force-quantum', restore])) !== null;
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Files the renderer may read: anything under these roots (sample folders, opened files).
const readableRoots = new Set();

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function resolveAppUrl(url) {
  const { pathname } = new URL(url);
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === 'vendor/Tone.js') return TONE;
  if (rel === 'vendor/lamejs.js') return LAME;
  const [base, sub] = rel.startsWith('samples/') ? [path.join(ASSETS, 'samples'), rel.slice(8)] : [SRC, rel || 'index.html'];
  const file = path.resolve(base, sub);
  return inside(base, file) ? file : null;
}

// An instrument file may read its own folder; SFZ files often keep samples beside it ("../Samples").
function allowInstrument(file) {
  readableRoots.add(path.dirname(file));
  if (path.extname(file).toLowerCase() === '.sfz') readableRoots.add(path.dirname(path.dirname(file)));
}

function allowSettingsRoots(settings) {
  (settings.sampleFolders || []).forEach(d => readableRoots.add(d));
  for (const f of settings.irFiles || []) readableRoots.add(path.dirname(f.path || f));
  for (const e of settings.userInstruments || []) {
    if (e.kind === 'folder') readableRoots.add(e.path);
    else allowInstrument(e.path);
  }
}

async function loadSettings() {
  try { return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8')); } catch { return {}; }
}

async function saveSettings(settings) {
  await fs.mkdir(path.dirname(SETTINGS_FILE()), { recursive: true });
  await fs.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
}

async function scanAudio(dir, depth = 0, out = []) {
  if (depth > 6 || out.length > 5000) return out;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await scanAudio(full, depth + 1, out);
    else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

function registerIpc(win) {
  ipcMain.handle('settings:get', loadSettings);
  ipcMain.handle('settings:set', async (_e, s) => {
    // Only folders and files the user picked this session may be added to the library.
    const known = new Set([...readableRoots]);
    const current = await loadSettings();
    const before = new Set([...(current.sampleFolders || []), ...(current.userInstruments || []).map(e => e.path), ...(current.irFiles || []).map(f => f.path)]);
    const ok = p => before.has(p) || known.has(p) || known.has(path.dirname(p));
    s.sampleFolders = (s.sampleFolders || []).filter(ok);
    s.userInstruments = (s.userInstruments || []).filter(e => e && typeof e.path === 'string' && ok(e.path));
    s.pluginFolders = current.pluginFolders || [];
    s.irFiles = (s.irFiles || []).filter(f => f && typeof f.path === 'string' && (before.has(f.path) || known.has(path.dirname(f.path))));
    await saveSettings(s);
  });

  ipcMain.handle('project:save', async (_e, { data, filePath, saveAs }) => {
    let target = filePath;
    if (!target || saveAs) {
      const r = await dialog.showSaveDialog(win, {
        title: 'Save Song',
        defaultPath: target || 'My Song.bband',
        filters: [{ name: 'Basement Band Song', extensions: ['bband'] }],
      });
      if (r.canceled || !r.filePath) return null;
      target = r.filePath;
    }
    await fs.writeFile(target, data);
    return target;
  });

  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Open Song or MIDI File',
      filters: [{ name: 'Songs and MIDI files', extensions: ['bband', 'mid', 'midi'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const filePath = r.filePaths[0];
    // MIDI files are imported into the current song rather than opened as one.
    if (/\.midi?$/i.test(filePath)) {
      const buf = await fs.readFile(filePath);
      return { filePath, midi: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    }
    return { filePath, data: await fs.readFile(filePath, 'utf8') };
  });

  ipcMain.handle('export:save', async (_e, { bytes, name, ext = 'wav' }) => {
    const type = EXPORT_TYPES[ext] ? ext : 'wav';
    const r = await dialog.showSaveDialog(win, {
      title: 'Export Song',
      defaultPath: name || `My Song.${type}`,
      filters: [{ name: EXPORT_TYPES[type], extensions: [type] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fs.writeFile(r.filePath, Buffer.from(bytes));
    return r.filePath;
  });

  ipcMain.handle('audio:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import Audio',
      filters: [{ name: 'Audio', extensions: [...AUDIO_EXT].map(e => e.slice(1)) }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    r.filePaths.forEach(p => readableRoots.add(path.dirname(p)));
    return r.filePaths;
  });

  // Speaker-cabinet impulse responses for the amp.
  ipcMain.handle('ir:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Load Cabinet Impulse Response',
      filters: [{ name: 'Impulse responses', extensions: ['wav', 'aif', 'aiff', 'flac'] }],
      properties: ['openFile'],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    readableRoots.add(path.dirname(r.filePaths[0]));
    return r.filePaths[0];
  });

  ipcMain.handle('instrument:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Import SoundFont or SFZ',
      filters: [{ name: 'Instruments (SoundFont, SFZ)', extensions: ['sf2', 'sfz'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    r.filePaths.forEach(allowInstrument);
    return r.filePaths;
  });

  // Drag-and-drop gives the renderer a path; only instrument files are accepted this way.
  ipcMain.handle('instrument:allow', async (_e, file) => {
    if (typeof file !== 'string' || !INSTRUMENT_EXT.has(path.extname(file).toLowerCase())) return false;
    try {
      if (!(await fs.stat(file)).isFile()) return false;
    } catch {
      return false;
    }
    allowInstrument(path.resolve(file));
    return true;
  });

  ipcMain.handle('folder:pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add Sample Folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    readableRoots.add(r.filePaths[0]);
    return r.filePaths[0];
  });

  ipcMain.handle('folder:scan', async (_e, dir) => {
    const target = path.resolve(dir);
    if (![...readableRoots].some(root => target === root || inside(root, target))) return [];
    const files = await scanAudio(dir);
    return files.map(f => ({ path: f, name: path.basename(f), rel: path.relative(dir, f) }));
  });

  ipcMain.handle('file:read', async (_e, filePath) => {
    const target = path.resolve(filePath);
    const allowed = [...readableRoots].some(root => target === root || inside(root, target));
    if (!allowed) throw new Error('Access denied: ' + filePath);
    const buf = await fs.readFile(target);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('audio:low-latency', (_e, on) => setLowLatencyQuantum(!!on));
  ipcMain.handle('audio:boot-mode', () => bootAudioMode);
  ipcMain.handle('theme:set', (_e, theme) => { nativeTheme.themeSource = ['light', 'dark'].includes(theme) ? theme : 'system'; });
  // Restart to apply audio settings (restoring PipeWire first, as quitting does).
  ipcMain.handle('app:relaunch', async () => {
    await setLowLatencyQuantum(false);
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('shell:credits', () => shell.openPath(path.join(ASSETS, 'samples', 'CREDITS.md')));

  // ---- plugins (VST3, and LV2 on Linux, via the native helper)
  const send = m => { if (!win.isDestroyed()) win.webContents.send('plugin:msg', m); };
  pluginHost = new plugins.HostProcess(send);
  ipcMain.handle('plugins:scan', async () => {
    const s = await loadSettings();
    return plugins.scanPlugins(s.pluginFolders || [], p => send({ type: 'progress', ...p }));
  });
  ipcMain.handle('plugins:folder-pick', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add Plugin Folder', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const s = await loadSettings();
    s.pluginFolders = [...new Set([...(s.pluginFolders || []), r.filePaths[0]])];
    await saveSettings(s);
    return r.filePaths[0];
  });
  ipcMain.on('plugin:json', (_e, text) => { if (typeof text === 'string') pluginHost.write('J', text); });
  ipcMain.on('plugin:render', (_e, bytes) => { if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) pluginHost.write('R', bytes); });
}

let pluginHost = null;

async function createWindow() {
  allowSettingsRoots(await loadSettings());
  // Test-only: folders the automated checks may read without a picker dialog.
  if (process.env.BB_SMOKE && process.env.BB_TEST_ROOTS) process.env.BB_TEST_ROOTS.split(path.delimiter).forEach(d => readableRoots.add(d));

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#1b1c20',
    title: 'Basement Band',
    icon: path.join(ROOT, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  Menu.setApplicationMenu(null);
  registerIpc(win);
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['media', 'midi', 'midiSysex'].includes(permission));
  });
  if (process.env.BB_SMOKE) {
    win.webContents.on('console-message', e => console.log(`[renderer:${e.level}] ${e.message}`));
  }
  await win.loadURL('app://bb/index.html');
  if (process.env.BB_SMOKE) require(path.resolve(process.env.BB_SMOKE))(win, app);
}

app.whenReady().then(() => {
  protocol.handle('app', async request => {
    const file = resolveAppUrl(request.url);
    if (!file) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => pluginHost?.stop());

// Never leave the system's audio quantum changed after we exit.
app.on('will-quit', e => {
  if (savedQuantum === null) return;
  e.preventDefault();
  setLowLatencyQuantum(false).finally(() => app.exit(0));
});
