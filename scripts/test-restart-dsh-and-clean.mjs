// 离线回归：用一个假 dsh web 验证 restart-dsh-and-clean 的停 → 清 → 起。
//
//   node scripts/test-restart-dsh-and-clean.mjs
//
// 不碰真实的 3080 进程；用随机端口和临时目录，结束时杀掉假进程。

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidsListeningOn } from './restart-dsh-and-clean.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MAINTENANCE = path.join(__dirname, 'restart-dsh-and-clean.mjs');

function commandExists(name) {
  const result = spawnSync('which', [name], { stdio: 'ignore' });
  return result.status === 0;
}

if (!commandExists('lsof') && !commandExists('ss')) {
  console.log('SKIP: restart-dsh-and-clean 需要 lsof 或 ss');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function httpAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    await response.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPid(port, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      const pids = pidsListeningOn(port);
      if (pids.length === 1) return pids[0];
      await sleep(150);
    }
    throw new Error(`端口 ${port} 没有监听者`);
  })();
}

async function startFake(fakePath, port, cwd, dshHome) {
  const child = spawn(process.execPath, [fakePath, 'web', '--port', String(port)], {
    cwd,
    env: { ...process.env, DSH_HOME: dshHome },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pid = await waitForPid(port);
  return pid;
}

function killPort(port) {
  const pids = pidsListeningOn(port);
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-restart-test-'));
let port;
try {
  const fakeHome = path.join(tmp, 'fake-home');
  const fakeCwd = path.join(tmp, 'fake-cwd');
  const fakePath = path.join(tmp, 'fake-dsh.mjs');
  fs.mkdirSync(path.join(fakeHome, 'sessions'), { recursive: true });
  fs.mkdirSync(fakeCwd, { recursive: true });
  fs.writeFileSync(
    fakePath,
    `import http from 'node:http';
const args = process.argv.slice(2);
const i = args.indexOf('--port');
const port = i >= 0 ? Number(args[i + 1]) : 3999;
http.createServer((req, res) => { res.writeHead(200); res.end('fake dsh web\\n'); }).listen(port, '127.0.0.1', () => console.log('listening', port, process.pid));
`,
  );
  port = await freePort();

  const oldPid = await startFake(fakePath, port, fakeCwd, fakeHome);
  assert.equal(await httpAlive(port), true);

  // --status 不动进程。
  const status = execFileSync(
    process.execPath,
    [MAINTENANCE, '--port', String(port), '--dsh-home', fakeHome, '--status'],
    { encoding: 'utf8' },
  );
  assert.match(status, /--status：不做任何改动/);
  assert.deepEqual(pidsListeningOn(port), [oldPid]);

  // 非交互且没有 --yes 时拒绝，且不停止。
  const refused = spawnSync(
    process.execPath,
    [MAINTENANCE, '--port', String(port), '--dsh-home', fakeHome, '--', '--list'],
    { encoding: 'utf8' },
  );
  assert.equal(refused.status, 2);
  assert.deepEqual(pidsListeningOn(port), [oldPid]);

  // 停 → 清理（--list）→ 起。
  const applied = execFileSync(
    process.execPath,
    [MAINTENANCE, '--port', String(port), '--dsh-home', fakeHome, '--yes', '--', '--list'],
    { encoding: 'utf8' },
  );
  assert.match(applied, /DSH Web 已恢复/);
  const newPids = pidsListeningOn(port);
  assert.equal(newPids.length, 1);
  assert.notEqual(newPids[0], oldPid);
  assert.equal(await httpAlive(port), true);

  // 清理失败也必须把 Web 拉起来，并以非 0 退出。
  const failingTool = path.join(tmp, 'failing-tool.mjs');
  fs.writeFileSync(failingTool, `console.error('intentional failure'); process.exit(3);\n`);
  const failed = spawnSync(
    process.execPath,
    [
      MAINTENANCE,
      '--port',
      String(port),
      '--dsh-home',
      fakeHome,
      '--tool',
      failingTool,
      '--yes',
      '--',
      '--list',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /清理失败/);
  assert.match(failed.stdout, /Web 已恢复/);
  assert.equal(await httpAlive(port), true);

  console.log('PASS: restart-dsh-and-clean（status/拒绝/停清起/失败仍重启）');
} finally {
  if (port !== undefined) {
    killPort(port);
    for (let i = 0; i < 20; i += 1) {
      if (!(await portOpen(port))) break;
      await sleep(100);
    }
    killPort(port);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
