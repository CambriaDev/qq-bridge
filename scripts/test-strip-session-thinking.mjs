// 离线回归：用合成 session 验证 strip-session-thinking.mjs 的范围、清理、备份和幂等。
//
//   node scripts/test-strip-session-thinking.mjs
//
// 不读取真实 DSH 数据，不联网（--dsh-url 指向一个必然拒绝的端口）。

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { scanZstdFrames } from './strip-session-thinking.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, 'scripts', 'strip-session-thinking.mjs');
const DSH_URL = 'http://127.0.0.1:59999';
const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

function frame(text) {
  return zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUM);
}

function header(id, preset) {
  return {
    type: 'session',
    version: 4,
    id,
    createdAt: 1_800_000_000_000,
    cwd: '/tmp/synthetic',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: preset,
  };
}

function userEvent(seq) {
  return {
    type: 'user/message',
    seq,
    time: 1_800_000_000_000 + seq,
    data: {
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
      role: 'user',
      id: `user-${seq}`,
    },
    surfaceOp: 'append',
  };
}

function assistantEvent(seq, { reasoning = true } = {}) {
  const content = [
    ...(reasoning ? [{ type: 'reasoning', text: `thinking-${seq}` }] : []),
    { type: 'text', text: `reply-${seq}` },
  ];
  const replayBlocks = [
    ...(reasoning ? [{ type: 'reasoning', signature: `sig-${seq}` }] : []),
    { type: 'text' },
  ];
  const stream = [
    ...(reasoning
      ? [{ type: 'reasoning-chunks', time0: 1_800_000_000_000 + seq, index: 0, dt: [], texts: [`thinking-${seq}`] }]
      : []),
    { type: 'chunk', time: 1_800_000_000_000 + seq, chunk: { type: 'block-end', index: reasoning ? 1 : 0, block: { type: 'text', text: `reply-${seq}` } } },
  ];
  return {
    type: 'assistant/message',
    seq,
    time: 1_800_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content,
        source: {
          kind: 'model',
          provider: 'test-provider',
          model: 'test-model',
          replayState: {
            response: { kind: 'deepseek-messages', version: 1, model: 'test-model' },
            blocks: replayBlocks,
          },
        },
        id: `assistant-${seq}`,
      },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 },
      stream,
    },
    surfaceOp: 'append',
  };
}

function writeZstdSession(file, headerLine, events) {
  const parts = [frame(`${JSON.stringify(headerLine)}\n`)];
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  parts.push(frame(body));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}

function writePlainSession(file, headerLine, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${[JSON.stringify(headerLine), ...events.map((event) => JSON.stringify(event))].join('\n')}\n`);
}

function sha(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readSession(file) {
  const buffer = fs.readFileSync(file);
  if (!file.endsWith('.zstd')) return buffer.toString('utf8');
  const { frames, tornStart } = scanZstdFrames(buffer);
  assert.equal(tornStart, undefined);
  return frames.map(({ start, end }) => zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8')).join('');
}

function run(args) {
  const output = execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-strip-thinking-test-'));
try {
  const sessions = path.join(tmp, 'sessions', '--synthetic--');
  const qqFile = path.join(sessions, 'session-qq', 'session.v4.jsonl.zstd');
  const cleanFile = path.join(sessions, 'session-clean', 'session.v4.jsonl.zstd');
  const standardFile = path.join(sessions, 'session-standard', 'session.v4.jsonl.zstd');
  const plainFile = path.join(sessions, 'session-plain', 'session.v4.jsonl');

  writeZstdSession(qqFile, header('session-qq', 'qq-chat-v2'), [userEvent(0), assistantEvent(1)]);
  writeZstdSession(cleanFile, header('session-clean', 'qq-chat-v2'), [userEvent(0), assistantEvent(1, { reasoning: false })]);
  writeZstdSession(standardFile, header('session-standard', 'standard'), [userEvent(0), assistantEvent(1)]);
  writePlainSession(plainFile, header('session-plain', 'qq-chat-v2'), [userEvent(0), assistantEvent(1)]);

  const standardHash = sha(standardFile);
  const cleanHash = sha(cleanFile);

  // --list 只匹配 qq-chat-v2；standard 不出现。
  const listed = run(['--list', '--json', '--dsh-home', tmp, '--dsh-url', DSH_URL]);
  assert.equal(listed.mode, 'list');
  assert.equal(listed.sessions.length, 3);
  assert.equal(listed.sessions.some((row) => row.sessionId === 'session-standard'), false);
  assert.equal(listed.sessions.find((row) => row.sessionId === 'session-qq').status, 'would-clean');
  assert.equal(listed.sessions.find((row) => row.sessionId === 'session-clean').status, 'clean');
  assert.equal(listed.sessions.find((row) => row.sessionId === 'session-plain').status, 'would-clean');

  // --only 显式点名时绕过预设过滤。
  const onlyStandard = run(['--list', '--json', '--dsh-home', tmp, '--dsh-url', DSH_URL, '--only', 'session-standard']);
  assert.equal(onlyStandard.sessions.length, 1);
  assert.equal(onlyStandard.sessions[0].sessionId, 'session-standard');

  // --dry-run 不写文件。
  const beforeDryRun = {
    qq: sha(qqFile),
    plain: sha(plainFile),
    standard: sha(standardFile),
    clean: sha(cleanFile),
  };
  const dryRun = run(['--dry-run', '--json', '--dsh-home', tmp, '--dsh-url', DSH_URL]);
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.totals.wouldClean, 2);
  assert.deepEqual(
    { qq: sha(qqFile), plain: sha(plainFile), standard: sha(standardFile), clean: sha(cleanFile) },
    beforeDryRun,
  );

  // 真正执行（DSH 探活指向不可达端口，等同于停机）。
  const applied = run(['--apply', '--json', '--dsh-home', tmp, '--dsh-url', DSH_URL]);
  assert.equal(applied.ok, true);
  assert.equal(applied.totals.cleaned, 2);
  assert.equal(applied.totals.failed, 0);
  assert.ok(applied.backupRoot, 'backup root should exist');

  for (const file of [qqFile, plainFile]) {
    const content = readSession(file);
    assert.equal(content.includes('"type":"reasoning"'), false);
    assert.equal(content.includes('reasoning-chunks'), false);
    assert.equal(content.includes('reply-1'), true, `${file} should keep visible reply`);
    assert.equal(content.includes('thinking-1'), false);
  }

  // 非 QQ 预设、本来干净的会话保持字节不变。
  assert.equal(sha(standardFile), standardHash);
  assert.equal(sha(cleanFile), cleanHash);

  // 备份存在且可读。
  const manifestPath = path.join(applied.backupRoot, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.entries.length, 2);
  assert.ok(manifest.entries.every((entry) => fs.existsSync(entry.backup)));

  // 幂等：第二次不会再清理，也不会新建备份。
  const second = run(['--apply', '--json', '--dsh-home', tmp, '--dsh-url', DSH_URL]);
  assert.equal(second.ok, true);
  assert.equal(second.totals.cleaned, 0);
  assert.equal(second.totals.clean, 3);
  assert.equal(second.backupRoot, null);

  console.log('PASS: strip-session-thinking（范围/清理/备份/幂等）');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
