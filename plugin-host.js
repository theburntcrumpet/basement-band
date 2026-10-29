// Main-process side of plugin hosting: finds and scans plugins with the native helper
// (native/plugin-host), and relays messages between the renderer and the running helper.
const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn, execFile } = require('node:child_process');

const ROOT = __dirname;
const EXE = process.platform === 'win32' ? 'bb-plugin-host.exe' : 'bb-plugin-host';

// The helper: packaged next to the app's resources, or from a local CMake build while developing.
function helperPath() {
  if (process.env.BB_PLUGIN_HOST) return path.resolve(process.env.BB_PLUGIN_HOST);
  const base = app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(ROOT, 'native', 'plugin-host', 'build', 'bb-plugin-host_artefacts', 'Release');
  return path.join(base, EXE);
}

// Plugins that ship with the app (Dexed); see scripts/fetch-plugins.mjs.
const bundledDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'plugins') : path.join(ROOT, 'plugins'));
const cacheFile = () => path.join(app.getPath('userData'), 'plugins.json');

function run(args, timeout) {
  return new Promise(resolve => {
    execFile(helperPath(), args, { timeout, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout) => {
      try { resolve({ ok: !err, out: JSON.parse(String(stdout).trim().split('\n').pop()) }); } catch { resolve({ ok: false, out: null }); }
    });
  });
}

async function available() {
  try { await fs.access(helperPath()); return true; } catch { return false; }
}

async function stamp(file) {
  try { const s = await fs.stat(file); return `${s.size}:${s.mtimeMs}`; } catch { return ''; }
}

// Lists every plugin (scanning only files that are new or changed since last time). Each file is
// scanned in its own helper process, so a plugin that crashes or hangs is just skipped.
async function scanPlugins(folders = [], onProgress = () => {}) {
  if (!(await available())) return { available: false, plugins: [] };
  let cache = {};
  try { cache = JSON.parse(await fs.readFile(cacheFile(), 'utf8')); } catch { /* first scan */ }
  const found = await run(['--find', bundledDir(), ...folders], 60000);
  const files = found.out || [];
  const next = {};
  const bundled = bundledDir();
  for (let i = 0; i < files.length; i++) {
    const { format, file } = files[i];
    const key = `${format}|${file}`;
    const st = await stamp(file);
    if (cache[key] && cache[key].stamp === st) { next[key] = cache[key]; continue; }
    onProgress({ done: i, total: files.length, file: path.basename(file) });
    const r = await run(['--scan', format, file], 30000);
    next[key] = { stamp: st, plugins: r.ok && Array.isArray(r.out) ? r.out : [], failed: !r.ok };
  }
  await fs.mkdir(path.dirname(cacheFile()), { recursive: true });
  await fs.writeFile(cacheFile(), JSON.stringify(next));
  const plugins = Object.values(next).flatMap(e => e.plugins).map(p => ({ ...p, bundled: p.file.startsWith(bundled) }));
  return { available: true, plugins, failed: Object.entries(next).filter(([, e]) => e.failed).map(([k]) => k.split('|')[1]) };
}

// The long-running helper that renders audio for the song's plugin instruments.
class HostProcess {
  constructor(send, env = {}) {
    this.send = send;    // (message) => void, to the renderer
    this.env = env;
    this.proc = null;
  }

  start() {
    if (this.proc) return true;
    let proc;
    try {
      proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true, env: { ...process.env, ...this.env } });
    } catch {
      return false;
    }
    this.proc = proc;
    let pending = Buffer.alloc(0);
    proc.stdout.on('data', chunk => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 4) {
        const len = pending.readUInt32LE(0);
        if (pending.length < 4 + len) break;
        const type = String.fromCharCode(pending[4]);
        const body = pending.subarray(5, 4 + len);
        if (type === 'J') {
          try { this.send({ type: 'J', json: JSON.parse(body.toString('utf8')) }); } catch { /* ignore */ }
        } else if (type === 'A' || type === 'I' || type === 'E') {
          this.send({ type, data: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
        }
        pending = pending.subarray(4 + len);
      }
    });
    proc.on('error', () => {});
    proc.on('exit', code => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.send({ type: 'exit', code });
    });
    proc.stdin.on('error', () => {});
    return true;
  }

  write(type, payload) {
    if (!this.start()) return false;
    const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = type.charCodeAt(0);
    this.proc.stdin.write(Buffer.concat([head, body]));
    return true;
  }

  stop() {
    if (!this.proc) return;
    const p = this.proc;
    this.proc = null;
    p.stdin.end();
    setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 1500);
  }
}

module.exports = { scanPlugins, HostProcess, available, helperPath };
