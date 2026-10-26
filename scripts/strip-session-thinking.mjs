#!/usr/bin/env node
// 批量删除 DSH 会话里的“思考内容”（assistant reasoning）。
//
// 背景：DSH 会把 assistant 的 reasoning 块、`replayState` 里的对应签名、以及 live SSE 的
// 原始 `stream` 一起写进 v4 JSONL。QQ 二代仿真 session 跑得久，思考内容往往比对话本身大
// 好几倍。这个工具在 **DSH 停止时**离线重写会话文件，只删思考：
//
//   * `assistant/message.message.content` 里 `type: "reasoning"` 的块
//   * `message.source.replayState.blocks` 里对应的 reasoning 条目
//   * 含 reasoning 的原始 `data.stream`（界面渲染用的是 `message.content`）
//
// 所有事件、seq、用户消息、助手可见文本、工具调用/结果、标题、用量都原样保留；事件数不变。
// 默认只处理 `agentPreset = qq-chat-v2` 的会话，即「QQ 聊天角色（二代仿真）」。
//
// 安全策略：
//   * 默认拒绝在 DSH Web 还在响应时写文件（agent 常驻内存，热替换不会刷新界面，
//     而且新回合仍会继续写思考）；确实要热替换得显式 `--allow-live`。
//   * 写前重新 stat 源文件，清理期间被追加过就放弃该会话。
//   * 先备份、后原子替换；替换后重新解析复核，失败自动用备份回滚。
//   * 默认不碰没有思考的会话（幂等）。
//
// 用法：
//   node scripts/strip-session-thinking.mjs --list
//   node scripts/strip-session-thinking.mjs --dry-run
//   node scripts/strip-session-thinking.mjs                  # 停机后真正执行
//   node scripts/strip-session-thinking.mjs --preset qq-chat,qq-chat-v2
//   node scripts/strip-session-thinking.mjs --only session-xxxxxxxx-...
//   node scripts/strip-session-thinking.mjs --help

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528
const CHECKSUM_OPTIONS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const DEFAULT_PRESETS = ['qq-chat-v2'];
const PRESET_ALIASES = new Map([
  ['QQ 聊天角色（二代仿真）', 'qq-chat-v2'],
  ['QQ 聊天角色(二代仿真)', 'qq-chat-v2'],
  ['QQ 聊天角色', 'qq-chat'],
]);

class SessionSkip extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SessionSkip';
    this.reason = reason;
  }
}

// ── 参数与帮助 ──────────────────────────────────────────────────────────────

function usage() {
  return `用法: node scripts/strip-session-thinking.mjs [options]

批量删除 DSH 会话中的思考内容（reasoning），默认只处理 agentPreset=qq-chat-v2
（“QQ 聊天角色（二代仿真）”）的会话。保留事件、seq、用户/助手文本、工具调用与结果。

模式:
  --list                 只列出匹配的 session 和思考块数量，不写文件
  --dry-run              完整分析并显示清理后体积，不写文件
  --apply                执行清理（默认；DSH 停止时才允许写）

安全与范围:
  --allow-live           DSH 仍在运行时也写文件（不推荐，见下方说明）
  --dsh-home <dir>       DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh）
  --dsh-url <url>        DSH Web 探活地址（默认 http://127.0.0.1:3080）
  --preset <id|name>     预设过滤，逗号分隔或重复；默认 qq-chat-v2
                         支持 “QQ 聊天角色（二代仿真）” 这类显示名
  --all-presets          不按预设过滤（所有 DSH session）
  --only <session-id>    只处理指定 session（可重复或逗号分隔）
  --backup-dir <dir>     备份根目录（默认 <dsh-home>/session-maintenance/backups）
  --no-backup            不备份（不建议）
  --dsh-validate         额外用 DSH 的 Session.fromRestore 校验清理结果
  --json                 机读输出（stdout 只有一个 JSON 对象）
  --fail-fast            遇到第一个失败/跳过就停止
  -h, --help             显示本帮助

示例:
  # 先看会清哪些、能省多少（DSH 开着也能跑，只读）
  node scripts/strip-session-thinking.mjs --list
  node scripts/strip-session-thinking.mjs --dry-run

  # 停机窗口：停掉 dsh web 后，清理所有二代仿真会话
  node scripts/strip-session-thinking.mjs

  # 连一代 qq-chat 一起清；或只清某个会话
  node scripts/strip-session-thinking.mjs --preset qq-chat,qq-chat-v2
  node scripts/strip-session-thinking.mjs --only session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

  # 热替换（不推荐）：文件会变干净，但界面/内存要等 DSH 重启才刷新
  node scripts/strip-session-thinking.mjs --allow-live

注意:
  * DSH 运行中所有 session 的 agent 都在内存里，热替换后已打开的界面仍显示旧内容，
    新回合也会继续写入新的思考内容；要彻底生效请停掉 dsh web 再跑。
  * 备份文件仍含思考内容；确认不需要回滚后可自行删除。
  * 被强行中断、尾部不完整的会话会跳过（先让 DSH 打开一次完成修复，再重跑）。
`;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function parseList(value) {
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizePreset(value) {
  const trimmed = String(value).trim();
  return PRESET_ALIASES.get(trimmed) ?? trimmed;
}

function parseArgs(argv) {
  const opts = {
    mode: 'apply',
    dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
    dshUrl: 'http://127.0.0.1:3080',
    presets: [],
    allPresets: false,
    only: new Set(),
    backupDir: '',
    noBackup: false,
    allowLive: false,
    dshValidate: false,
    json: false,
    failFast: false,
    help: false,
  };
  let modeSet = false;

  const modeFlag = { list: '--list', 'dry-run': '--dry-run', apply: '--apply' };
  const setMode = (mode, flag) => {
    if (modeSet && opts.mode !== mode) throw new Error(`${flag} 不能和 ${modeFlag[opts.mode]} 同时使用`);
    opts.mode = mode;
    modeSet = true;
  };
  const valueOf = (index, flag) => {
    const value = argv[index];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} 需要参数`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--list':
        setMode('list', '--list');
        break;
      case '--dry-run':
        setMode('dry-run', '--dry-run');
        break;
      case '--apply':
        setMode('apply', '--apply');
        break;
      case '--allow-live':
        opts.allowLive = true;
        break;
      case '--dsh-home':
        opts.dshHome = valueOf(i += 1, '--dsh-home');
        break;
      case '--dsh-url':
        opts.dshUrl = valueOf(i += 1, '--dsh-url');
        break;
      case '--preset':
        opts.presets.push(...parseList(valueOf(i += 1, '--preset')));
        break;
      case '--all-presets':
        opts.allPresets = true;
        break;
      case '--only':
        for (const id of parseList(valueOf(i += 1, '--only'))) opts.only.add(id);
        break;
      case '--backup-dir':
        opts.backupDir = valueOf(i += 1, '--backup-dir');
        break;
      case '--no-backup':
        opts.noBackup = true;
        break;
      case '--dsh-validate':
        opts.dshValidate = true;
        break;
      case '--json':
        opts.json = true;
        break;
      case '--fail-fast':
        opts.failFast = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }

  if (opts.help) return opts;
  if (!opts.allPresets) {
    if (opts.presets.length === 0) opts.presets = [...DEFAULT_PRESETS];
    opts.presets = [...new Set(opts.presets.map(normalizePreset).filter(Boolean))];
    if (opts.presets.length === 0) throw new Error('--preset 不能为空');
  }
  opts.dshHome = path.resolve(expandHome(opts.dshHome));
  if (opts.backupDir) opts.backupDir = path.resolve(expandHome(opts.backupDir));
  if (!/^https?:\/\//i.test(opts.dshUrl)) opts.dshUrl = `http://${opts.dshUrl}`;
  return opts;
}

// ── Zstandard 帧容器 ────────────────────────────────────────────────────────

/** 扫描 concatenated zstd 帧；返回完整帧区间，以及尾部不完整帧的起点。 */
function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new SessionSkip('corrupt', `zstd 帧头损坏（byte ${offset}）`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new SessionSkip('corrupt', `zstd 帧头保留位异常（byte ${offset - 1}）`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new SessionSkip('corrupt', `zstd 块类型异常（byte ${offset - 3}）`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

function decodeZstdFrame(buffer) {
  try {
    return zlib.zstdDecompressSync(buffer);
  } catch (error) {
    throw new SessionSkip('corrupt', `zstd 帧解压失败: ${error.message}`);
  }
}

function compressZstdFrame(plain) {
  return zlib.zstdCompressSync(Buffer.from(plain, 'utf8'), CHECKSUM_OPTIONS);
}

// ── 会话文件读取 ────────────────────────────────────────────────────────────

function parseHeaderLine(line, file) {
  let header;
  try {
    header = JSON.parse(line);
  } catch (error) {
    throw new SessionSkip('unreadable', `${file}: header 不是合法 JSON`);
  }
  if (header?.type !== 'session' || header.version !== 4 || typeof header.id !== 'string') {
    throw new SessionSkip('unreadable', `${file}: 不是 v4 session header`);
  }
  return header;
}

function parseEventLine(line, file, index) {
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new SessionSkip('unreadable', `${file}: 第 ${index} 行不是合法 JSON`);
  }
}

/** 读取一个 session.v4.jsonl[.zstd]，保留帧边界以便只重压缩被改动的帧。 */
function loadSessionLog(file) {
  let statBefore;
  let buffer;
  let stat;
  // 正在被 DSH 追加时，readFileSync 可能读到半个帧；重试一次拿稳定快照。
  for (let attempt = 0; attempt < 2; attempt += 1) {
    statBefore = fs.statSync(file);
    buffer = fs.readFileSync(file);
    stat = fs.statSync(file);
    if (fingerprint(statBefore) === fingerprint(stat)) break;
    buffer = undefined;
  }
  if (buffer === undefined) {
    throw new SessionSkip('changed', `${file}: 读取期间文件一直被写入，已跳过`);
  }
  if (!stat.isFile()) throw new SessionSkip('unreadable', `${file}: 不是普通文件`);
  if (buffer.length === 0) throw new SessionSkip('unreadable', `${file}: 空文件`);
  const zstd = file.endsWith('.zstd');

  if (!zstd) {
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) throw new SessionSkip('unreadable', `${file}: 空文件`);
    const header = parseHeaderLine(lines[0], file);
    const events = lines.slice(1).map((line, index) => parseEventLine(line, file, index + 2));
    return {
      file,
      stat,
      zstd: false,
      header,
      headerFrame: null,
      groups: [{ index: 0, events, original: null, changed: false }],
      allEvents: events,
      buffer,
    };
  }

  const { frames, tornStart } = scanZstdFrames(buffer);
  if (frames.length === 0) {
    throw new SessionSkip(
      tornStart !== undefined ? 'torn-tail' : 'unreadable',
      `${file}: 没有完整 zstd 帧`,
    );
  }
  const tornTail = tornStart !== undefined;
  const frameBuffers = frames.map(({ start, end }) => buffer.subarray(start, end));
  const decoded = frameBuffers.map((frame) => decodeZstdFrame(frame).toString('utf8'));
  const headerText = decoded[0];
  if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) {
    throw new SessionSkip('unreadable', `${file}: 第一帧不是独立的一行 header`);
  }
  const header = parseHeaderLine(headerText.slice(0, -1), file);
  const groups = [];
  const allEvents = [];
  for (let index = 1; index < decoded.length; index += 1) {
    const text = decoded[index];
    if (!text.endsWith('\n')) throw new SessionSkip('unreadable', `${file}: 第 ${index + 1} 帧没有以换行结束`);
    const lines = text.slice(0, -1).split('\n');
    const events = lines.map((line, lineIndex) => parseEventLine(line, file, allEvents.length + lineIndex + 2));
    groups.push({ index: index - 1, events, original: frameBuffers[index], changed: false });
    allEvents.push(...events);
  }
  return {
    file,
    stat,
    zstd: true,
    header,
    headerFrame: frameBuffers[0],
    groups,
    allEvents,
    buffer,
    tornTail,
  };
}

// ── 思考内容识别与删除 ──────────────────────────────────────────────────────

/** 在任意值里找 reasoning 结构；只匹配真正的块/流类型，不匹配普通文本。 */
function findReasoning(value, where = '') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findReasoning(value[index], `${where}[${index}]`);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  if (value.type === 'reasoning' || value.type === 'reasoning-chunks' || value.blockType === 'reasoning') {
    return where || '(root)';
  }
  for (const [key, child] of Object.entries(value)) {
    const found = findReasoning(child, where ? `${where}.${key}` : key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function addReasoningChars(stats, block) {
  if (typeof block?.text === 'string') stats.reasoningChars += block.text.length;
}

function cleanAssistantMessage(event, stats) {
  const data = event.data;
  const message = data?.message;
  if (!message || !Array.isArray(message.content)) {
    throw new SessionSkip('unsupported', `assistant/message seq ${event.seq} 没有 content 数组`);
  }

  let changed = false;
  if (message.content.some((block) => block?.type === 'reasoning')) {
    const kept = [];
    for (const block of message.content) {
      if (block?.type === 'reasoning') {
        stats.reasoningBlocks += 1;
        addReasoningChars(stats, block);
        continue;
      }
      kept.push(block);
    }
    message.content = kept;
    changed = true;
  }

  const replay = message.source?.replayState;
  if (replay !== undefined) {
    if (!replay || !Array.isArray(replay.blocks)) {
      throw new SessionSkip('unsupported', `assistant/message seq ${event.seq} 的 replayState 形状不认识`);
    }
    if (replay.blocks.some((block) => block?.type === 'reasoning')) {
      const kept = replay.blocks.filter((block) => block?.type !== 'reasoning');
      stats.replayBlocks += replay.blocks.length - kept.length;
      replay.blocks = kept;
      changed = true;
    }
    if (replay.blocks.length !== message.content.length) {
      throw new SessionSkip(
        'unsupported',
        `assistant/message seq ${event.seq} 的 content/replayState 块数不一致`,
      );
    }
  }

  if (!Array.isArray(data.stream)) {
    throw new SessionSkip('unsupported', `assistant/message seq ${event.seq} 没有 stream 数组`);
  }
  if (data.stream.length > 0) {
    const streamReasoning = findReasoning(data.stream, 'stream');
    // 内容里删过 reasoning 时整段 stream 直接丢弃（它本来也主要装思考）；
    // 内容没动但 stream 自己带 reasoning 时同样要清，否则等于没清干净。
    if (changed || streamReasoning !== undefined) {
      stats.streamsCleared += 1;
      stats.streamItems += data.stream.length;
      data.stream = [];
      changed = true;
    }
  }
  return changed;
}

function cleanEvent(event, stats) {
  if (event?.type === 'assistant/message') return cleanAssistantMessage(event, stats);
  const found = findReasoning(event.data, 'data');
  if (found !== undefined) {
    throw new SessionSkip('unsupported', `${event?.type ?? '?'} seq ${event?.seq ?? '?'} 含未支持的思考结构（${found}）`);
  }
  return false;
}

function validateEvents(events, file) {
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event?.seq !== index) {
      throw new SessionSkip('unsupported', `${file}: 事件 seq 不连续（第 ${index} 条是 ${event?.seq}）`);
    }
    const found = findReasoning(event.data, 'data');
    if (found !== undefined) {
      throw new SessionSkip('unsupported', `${file}: seq ${event.seq} 仍含思考结构（${found}）`);
    }
    if (event.type === 'assistant/message') {
      const data = event.data;
      const message = data?.message;
      if (!message || !Array.isArray(message.content)) {
        throw new SessionSkip('unsupported', `${file}: seq ${event.seq} 没有 content 数组`);
      }
      if (!Array.isArray(data.stream)) {
        throw new SessionSkip('unsupported', `${file}: seq ${event.seq} 没有 stream 数组`);
      }
      const replay = message.source?.replayState;
      if (replay !== undefined && (!replay || !Array.isArray(replay.blocks) || replay.blocks.length !== message.content.length)) {
        throw new SessionSkip('unsupported', `${file}: seq ${event.seq} 的 replayState 与 content 不一致`);
      }
    }
  }
}

function analyzeSession(loaded) {
  const stats = {
    events: loaded.allEvents.length,
    assistantMessages: 0,
    reasoningBlocks: 0,
    replayBlocks: 0,
    reasoningChars: 0,
    streamsCleared: 0,
    streamItems: 0,
    framesRewritten: 0,
  };
  for (const group of loaded.groups) {
    let changed = false;
    for (const event of group.events) {
      if (event?.type === 'assistant/message') stats.assistantMessages += 1;
      if (cleanEvent(event, stats)) changed = true;
    }
    group.changed = changed;
    if (changed) stats.framesRewritten += 1;
  }
  validateEvents(loaded.allEvents, loaded.file);
  stats.changed = stats.framesRewritten > 0;
  return stats;
}

function buildCleanedBuffer(loaded) {
  if (!loaded.zstd) {
    // header 的原文必须原样保留，避免重新序列化改变字段顺序/可选字段；从原 buffer 取第一行。
    const firstLine = loaded.buffer.toString('utf8').split('\n', 1)[0];
    const body = loaded.allEvents.map((event) => JSON.stringify(event)).join('\n');
    return Buffer.from(body ? `${firstLine}\n${body}\n` : `${firstLine}\n`, 'utf8');
  }
  // 重新分批压缩（而不是沿用原始 append 批次）：原始文件往往一步一个很小的帧，
  // 每帧独立压缩会让大量重复的唤醒提示/tool 结果失去跨帧压缩率；按 100 条一批
  // 重压能把 667 这种会话从 ~858 KB 压到 ~330 KB。DSH 读取只看“完整帧 + 行边界”，
  // 不要求帧等于写入批次。
  const BODY_BATCH = 100;
  const parts = [loaded.headerFrame];
  for (let offset = 0; offset < loaded.allEvents.length; offset += BODY_BATCH) {
    const batch = loaded.allEvents.slice(offset, offset + BODY_BATCH);
    parts.push(compressZstdFrame(`${batch.map((event) => JSON.stringify(event)).join('\n')}\n`));
  }
  return Buffer.concat(parts);
}

// ── 校验、备份与写入 ────────────────────────────────────────────────────────

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fingerprint(stat) {
  return `${stat.size}:${stat.mtimeMs}:${stat.ino}`;
}

function bytesLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // 目录 fsync 不是所有平台都支持；写文件本身已经 sync。
  }
}

function writeAtomic(file, bytes, mode) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
    fsyncDir(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw error;
  }
}

async function findDshSessionModule() {
  if (process.env.DSH_SESSION_MODULE) {
    const explicit = path.resolve(expandHome(process.env.DSH_SESSION_MODULE));
    if (!fs.existsSync(explicit)) throw new Error(`DSH_SESSION_MODULE 不存在: ${explicit}`);
    return explicit;
  }
  const npxRoot = path.join(os.homedir(), '.npm', '_npx');
  let dirs = [];
  try {
    dirs = fs.readdirSync(npxRoot);
  } catch {
    return undefined;
  }
  const candidates = [];
  for (const dir of dirs) {
    const candidate = path.join(npxRoot, dir, 'node_modules', '@deepseek-ai', 'dsh-session', 'lib', 'index.js');
    try {
      candidates.push({ path: candidate, mtime: fs.statSync(candidate).mtimeMs });
    } catch {}
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path;
}

async function loadDshSession() {
  const modulePath = await findDshSessionModule();
  if (!modulePath) throw new Error('找不到 @deepseek-ai/dsh-session；可用 DSH_SESSION_MODULE 指定');
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.Session?.fromRestore !== 'function') throw new Error(`无法从 ${modulePath} 加载 Session.fromRestore`);
  return mod.Session;
}

function validateWithDsh(Session, header, events) {
  const inherited = header.isSeeded ? Number(header.inheritedEventCount ?? 0) : 0;
  Session.fromRestore(header.id, structuredClone(events), structuredClone(header), inherited, 'detached', []);
}

function reasoningSummary(stats) {
  return {
    reasoningBlocks: stats.reasoningBlocks,
    replayBlocks: stats.replayBlocks,
    reasoningChars: stats.reasoningChars,
    streamsCleared: stats.streamsCleared,
    streamItems: stats.streamItems,
    framesRewritten: stats.framesRewritten,
  };
}

// ── 单会话处理 ──────────────────────────────────────────────────────────────

function presetMatched(header, opts) {
  // --only 是显式点名，优先于预设过滤（否则想清一个 standard 会话还得额外加 --all-presets）。
  if (opts.only.size > 0 && opts.only.has(header.id)) return true;
  if (opts.allPresets) return true;
  return typeof header.agentPreset === 'string' && opts.presets.includes(header.agentPreset);
}

function processSession(loaded, opts, context) {
  const { header } = loaded;
  const base = {
    sessionId: header.id,
    preset: header.agentPreset ?? null,
    cwd: header.cwd ?? null,
    path: loaded.file,
    bytesBefore: loaded.buffer.length,
  };

  if (loaded.tornTail) {
    throw new SessionSkip('torn-tail', `${loaded.file}: 尾部有不完整帧（先让 DSH 打开一次修复）`);
  }

  const stats = analyzeSession(loaded);
  base.events = stats.events;
  base.assistantMessages = stats.assistantMessages;
  if (!stats.changed) {
    return {
      ...base,
      status: 'clean',
      reason: 'no-reasoning',
      ...reasoningSummary(stats),
      bytesAfter: loaded.buffer.length,
    };
  }

  if (opts.mode !== 'apply') {
    const output = buildCleanedBuffer(loaded);
    return {
      ...base,
      status: 'would-clean',
      ...reasoningSummary(stats),
      bytesAfter: output.length,
    };
  }

  // 源文件在分析期间被 DSH 追加过就放弃这个会话。
  const beforeFingerprint = fingerprint(loaded.stat);
  const current = fs.statSync(loaded.file);
  if (fingerprint(current) !== beforeFingerprint) {
    throw new SessionSkip('changed', `${loaded.file}: 清理期间源文件被写入，已放弃`);
  }

  const output = buildCleanedBuffer(loaded);
  if (opts.dshValidate) validateWithDsh(context.Session, header, loaded.allEvents);

  let backupPath = null;
  let manifestEntry = null;
  if (!opts.noBackup) {
    const relative = path.relative(context.sessionsRoot, loaded.file);
    backupPath = path.join(context.backupRoot, relative);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(loaded.file, backupPath);
    fs.chmodSync(backupPath, loaded.stat.mode & 0o777);
    const bytes = loaded.buffer.length;
    const digest = sha256(loaded.buffer);
    const backupDigest = sha256(fs.readFileSync(backupPath));
    if (backupDigest !== digest) {
      throw new SessionSkip('backup', `${loaded.file}: 备份校验失败（sha256 不一致），已放弃写入`);
    }
    manifestEntry = {
      sessionId: header.id,
      file: loaded.file,
      relative,
      backup: backupPath,
      bytes,
      sha256: digest,
    };
  }

  const afterBackup = fs.statSync(loaded.file);
  if (fingerprint(afterBackup) !== beforeFingerprint) {
    throw new SessionSkip('changed', `${loaded.file}: 备份期间源文件被写入，已放弃（备份保留）`);
  }

  writeAtomic(loaded.file, output, loaded.stat.mode & 0o777);

  // 换完重新解析复核，失败就用备份回滚。
  try {
    const check = loadSessionLog(loaded.file);
    if (check.allEvents.length !== loaded.allEvents.length) {
      throw new Error(`事件数从 ${loaded.allEvents.length} 变成 ${check.allEvents.length}`);
    }
    validateEvents(check.allEvents, loaded.file);
    if (opts.dshValidate) validateWithDsh(context.Session, check.header, check.allEvents);
  } catch (error) {
    if (backupPath && fs.existsSync(backupPath)) {
      writeAtomic(loaded.file, fs.readFileSync(backupPath), loaded.stat.mode & 0o777);
      throw new SessionSkip('post-check-rolled-back', `${loaded.file}: 复核失败，已回滚（${error.message}）`);
    }
    throw new SessionSkip('post-check', `${loaded.file}: 复核失败（${error.message}），且没有备份`);
  }

  return {
    ...base,
    status: 'cleaned',
    ...reasoningSummary(stats),
    bytesAfter: output.length,
    backup: backupPath,
    manifestEntry,
  };
}

// ── DSH 探活与文件发现 ──────────────────────────────────────────────────────

async function probeDsh(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(1500),
    });
    try {
      await response.arrayBuffer();
    } catch {}
    return { up: true, status: response.status };
  } catch (error) {
    const code = error?.cause?.code ?? error?.code;
    return { up: false, code: code ?? error?.name ?? 'unknown', error: error?.message ?? String(error) };
  }
}

function findSessionLogs(sessionsRoot) {
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && (entry.name === 'session.v4.jsonl.zstd' || entry.name === 'session.v4.jsonl')) {
        files.push(full);
      }
    }
  };
  walk(sessionsRoot, 0);
  return files.sort();
}

// ── 输出 ────────────────────────────────────────────────────────────────────

function statusLabel(status) {
  return status.padEnd(12);
}

function printTable(results, totals, opts, dsh, backupRoot) {
  const header = `${statusLabel('状态')}${'会话'.padEnd(48)}${'预设'.padEnd(14)}${'事件'.padStart(6)}${'思考块'.padStart(7)}${'体积'.padStart(22)}`;
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const result of results) {
    const size = result.bytesAfter === undefined
      ? bytesLabel(result.bytesBefore)
      : `${bytesLabel(result.bytesBefore)} → ${bytesLabel(result.bytesAfter)}`;
    const think = result.status === 'clean' ? '0' : String(result.reasoningBlocks ?? 0);
    console.log(
      `${statusLabel(result.status)}${String(result.sessionId).padEnd(48)}${String(result.preset ?? '-').padEnd(14)}${String(result.events ?? '-').padStart(6)}${think.padStart(7)}${size.padStart(22)}`,
    );
    if (result.reason && !['no-reasoning'].includes(result.reason)) {
      console.log(`  └ ${result.reason}`);
    }
  }
  console.log('');
  const modeNote = opts.mode === 'apply' ? '' : opts.mode === 'dry-run' ? '（dry-run：未写文件）' : '（--list：只读）';
  const changedLabel = opts.mode === 'apply'
    ? `${totals.cleaned} 个已清理`
    : `${totals.wouldClean} 个待清理`;
  console.log(
    `合计：${totals.matched} 个匹配；${changedLabel}，${totals.clean} 个本来就干净${totals.skipped + totals.failed > 0 ? `，${totals.skipped} 个跳过，${totals.failed} 个失败` : ''}${modeNote}`,
  );
  if (totals.reasoningBlocks > 0 || totals.streamsCleared > 0) {
    console.log(
      `移除思考：${totals.reasoningBlocks} 个块、${totals.reasoningChars} 字符；清空 ${totals.streamsCleared} 段原始 stream`,
    );
  }
  if (totals.bytesBefore > 0) {
    const saved = totals.bytesBefore - totals.bytesAfter;
    console.log(`体积：${bytesLabel(totals.bytesBefore)} → ${bytesLabel(totals.bytesAfter)}（省 ${bytesLabel(Math.max(0, saved))}）`);
  }
  if (backupRoot) console.log(`备份：${backupRoot}`);
  if (!dsh.up) console.log('DSH Web 探活：未响应（按停机状态处理）');
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (typeof zlib.zstdDecompressSync !== 'function' || typeof zlib.zstdCompressSync !== 'function') {
    console.error(`当前 Node ${process.version} 没有 zstd API；请用 Node 24（或带 zstd 的 Node 22）运行。`);
    return 2;
  }

  const sessionsRoot = path.join(opts.dshHome, 'sessions');
  if (!fs.existsSync(sessionsRoot)) {
    console.error(`找不到 sessions 目录: ${sessionsRoot}`);
    return 2;
  }

  const dsh = await probeDsh(opts.dshUrl);
  const writeMode = opts.mode === 'apply';
  if (writeMode && dsh.up && !opts.allowLive) {
    console.error(`DSH Web 仍在响应（${opts.dshUrl}，HTTP ${dsh.status ?? '?'}）。`);
    console.error('请先停掉 `dsh web` 再执行；确实要热替换请显式加 --allow-live。');
    console.error('只想预览可以先跑 --list 或 --dry-run（只读，不受此限制）。');
    return 2;
  }
  if (writeMode && dsh.up && opts.allowLive) {
    console.error('警告：DSH 仍在运行（--allow-live）。已打开的界面/内存不会刷新，新回合还会继续写思考；');
    console.error('      文件写完后需重启 DSH 才彻底生效。');
  }
  if (writeMode && !dsh.up && dsh.code && !['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'TimeoutError'].includes(dsh.code)) {
    console.error(`提示：无法确认 DSH 是否停止（${opts.dshUrl}: ${dsh.code}）。按停机状态继续。`);
  }

  const Session = opts.dshValidate ? await loadDshSession() : undefined;
  const backupRoot = opts.noBackup
    ? null
    : path.join(
        opts.backupDir || path.join(opts.dshHome, 'session-maintenance', 'backups'),
        `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}`,
      );
  const context = { sessionsRoot, backupRoot, Session };
  const files = findSessionLogs(sessionsRoot);
  const results = [];
  const totals = {
    matched: 0,
    cleaned: 0,
    wouldClean: 0,
    clean: 0,
    skipped: 0,
    failed: 0,
    reasoningBlocks: 0,
    replayBlocks: 0,
    reasoningChars: 0,
    streamsCleared: 0,
    streamItems: 0,
    framesRewritten: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  const manifest = [];
  const notFoundOnly = new Set(opts.only);
  let stop = false;

  for (const file of files) {
    if (stop) break;
    let loaded;
    try {
      loaded = loadSessionLog(file);
    } catch (error) {
      const isSkip = error instanceof SessionSkip;
      // 读不出 header 的文件无法判断预设；仍然报告，避免“以为全清了”。
      const result = {
        sessionId: path.basename(path.dirname(file)),
        preset: null,
        cwd: null,
        path: file,
        status: isSkip ? 'skipped' : 'failed',
        reason: isSkip ? `${error.reason}: ${error.message}` : error.message,
        bytesBefore: fs.existsSync(file) ? fs.statSync(file).size : 0,
      };
      results.push(result);
      totals.skipped += isSkip ? 1 : 0;
      totals.failed += isSkip ? 0 : 1;
      if (opts.failFast) stop = true;
      continue;
    }

    if (!presetMatched(loaded.header, opts)) continue;
    if (opts.only.size > 0) {
      notFoundOnly.delete(loaded.header.id);
      if (!opts.only.has(loaded.header.id)) continue;
    }
    totals.matched += 1;

    try {
      const result = processSession(loaded, opts, context);
      results.push(result);
      if (result.status === 'cleaned' || result.status === 'would-clean') {
        if (result.status === 'cleaned') totals.cleaned += 1;
        if (result.status === 'would-clean') totals.wouldClean += 1;
        totals.reasoningBlocks += result.reasoningBlocks ?? 0;
        totals.replayBlocks += result.replayBlocks ?? 0;
        totals.reasoningChars += result.reasoningChars ?? 0;
        totals.streamsCleared += result.streamsCleared ?? 0;
        totals.streamItems += result.streamItems ?? 0;
        totals.framesRewritten += result.framesRewritten ?? 0;
        totals.bytesBefore += result.bytesBefore;
        totals.bytesAfter += result.bytesAfter ?? result.bytesBefore;
        if (result.manifestEntry) manifest.push(result.manifestEntry);
      } else if (result.status === 'clean') {
        totals.clean += 1;
      }
    } catch (error) {
      const isSkip = error instanceof SessionSkip;
      const result = {
        sessionId: loaded.header.id,
        preset: loaded.header.agentPreset ?? null,
        cwd: loaded.header.cwd ?? null,
        path: file,
        status: isSkip ? 'skipped' : 'failed',
        reason: isSkip ? `${error.reason}: ${error.message}` : error.message,
        bytesBefore: loaded.buffer.length,
        events: loaded.allEvents.length,
      };
      results.push(result);
      totals.skipped += isSkip ? 1 : 0;
      totals.failed += isSkip ? 0 : 1;
      if (opts.failFast) stop = true;
    }
  }

  const missingOnly = [...notFoundOnly];
  for (const id of missingOnly) {
    console.error(`警告：--only 指定的 session 未找到: ${id}`);
  }

  if (backupRoot && manifest.length > 0) {
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.writeFileSync(
      path.join(backupRoot, 'manifest.json'),
      `${JSON.stringify({ createdAt: new Date().toISOString(), dshHome: opts.dshHome, entries: manifest }, null, 2)}\n`,
    );
  }

  const ok = totals.failed === 0 && missingOnly.length === 0;
  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          ok,
          mode: opts.mode,
          dshHome: opts.dshHome,
          presets: opts.allPresets ? null : opts.presets,
          dsh: { url: opts.dshUrl, ...dsh },
          sessions: results,
          totals,
          missingOnly,
          backupRoot: manifest.length > 0 ? backupRoot : null,
        },
        null,
        2,
      ),
    );
  } else {
    printTable(results, totals, opts, dsh, manifest.length > 0 ? backupRoot : null);
  }
  return ok ? 0 : 1;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
}

export {
  scanZstdFrames,
  loadSessionLog,
  analyzeSession,
  buildCleanedBuffer,
  findReasoning,
  parseArgs,
  main,
};
