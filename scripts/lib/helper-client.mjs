// A small client for the native helper's pipe protocol (see native/plugin-host/Source/Main.cpp),
// used by the check scripts.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultHelper = path.join(ROOT, 'native', 'plugin-host', 'build', 'bb-plugin-host_artefacts', 'Release',
  process.platform === 'win32' ? 'bb-plugin-host.exe' : 'bb-plugin-host');

export function connect(helper = defaultHelper, env = {}) {
  const proc = spawn(helper, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  const waiting = new Map();
  const listeners = { J: [], A: [], I: [] };
  let pending = Buffer.alloc(0);
  proc.stdout.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32LE(0);
      if (pending.length < 4 + len) break;
      const type = String.fromCharCode(pending[4]), body = Buffer.from(pending.subarray(5, 4 + len));
      if (type === 'J') {
        const j = JSON.parse(body);
        if (j.req != null && waiting.has(j.req)) { waiting.get(j.req)(j); waiting.delete(j.req); }
        listeners.J.forEach(f => f(j));
      } else listeners[type]?.forEach(f => f(body));
      pending = pending.subarray(4 + len);
    }
  });
  const write = (type, body) => {
    const head = Buffer.alloc(5);
    head.writeUInt32LE(body.length + 1, 0);
    head[4] = type.charCodeAt(0);
    proc.stdin.write(Buffer.concat([head, body]));
  };
  let req = 0;
  const call = (cmd, props = {}, ms = 30000) => {
    const id = ++req;
    const p = new Promise(resolve => waiting.set(id, resolve));
    write('J', Buffer.from(JSON.stringify({ cmd, req: id, ...props })));
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timed out: ' + cmd)), ms))]);
  };
  const close = () => { proc.stdin.end(); setTimeout(() => proc.kill(), 2000).unref(); };
  return { proc, call, write, on: (type, f) => listeners[type].push(f), close };
}
