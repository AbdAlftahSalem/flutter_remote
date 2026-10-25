/**
 * Real-process harness for the end-to-end suite: spawn a process, keep its
 * output, wait for a log line or an HTTP endpoint, and always clean up.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';

const running = new Set();

/** A free TCP port on 127.0.0.1, chosen by the OS. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Start a long-running process. Returns a handle with `.output` (stdout+stderr
 * so far), `.waitFor(regex)` and `.stop()`.
 */
export function startProcess(name, command, args, { env = {}, cwd } = {}) {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const handle = {
    name,
    child,
    output: '',
    exited: false,
    exitCode: null,
    waitFor(pattern, timeoutMs = 20000) {
      return waitUntil(() => pattern.test(handle.output), timeoutMs, () =>
        `${name}: timed out waiting for ${pattern}\n--- ${name} output ---\n${handle.output.slice(-4000)}`);
    },
    async stop() {
      if (handle.exited) return;
      const gone = new Promise((r) => child.once('exit', r));
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 3000);
      await gone;
      clearTimeout(t);
    },
  };
  const append = (d) => { handle.output += d.toString(); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.on('exit', (code) => { handle.exited = true; handle.exitCode = code; running.delete(handle); });
  running.add(handle);
  return handle;
}

/** Stop every process this file started (use in `after`). */
export async function stopAll() {
  await Promise.all([...running].map((h) => h.stop()));
}

/** Poll `check` until it returns truthy. */
export async function waitUntil(check, timeoutMs = 20000, describe = () => 'condition') {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(typeof describe === 'function' ? describe() : describe);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Plain HTTP request (no redirects followed). Resolves {status, headers, body}. */
export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error(`timeout: ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

/** Wait until an HTTP endpoint answers 200. */
export function waitForHttp(url, timeoutMs = 20000) {
  return waitUntil(async () => {
    try { return (await request(url)).status === 200; } catch { return false; }
  }, timeoutMs, `no 200 from ${url}`);
}
