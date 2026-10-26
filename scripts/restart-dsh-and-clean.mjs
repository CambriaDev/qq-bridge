#!/usr/bin/env node
// 一键维护：停止 dsh web → 离线清理 session 思考 → 重新启动 dsh web。
//
// 用途：清理工具要求在 DSH 停止时改 session 文件；这个脚本把「停、清、起」串起来，
// 并尽量保证清理失败也会把 Web 重新拉起来。
//
// 它会做什么：
//   1. 按端口找到正在监听的 dsh web 进程（默认 3080），确认是 `... dsh ... web`；
//   2. 记录它的命令行、cwd、环境变量，SIGTERM 优雅停止（超时再 SIGKILL）；
//   3. 调用 scripts/strip-session-thinking.mjs 做离线清理（默认 qq-chat-v2）；
//   4. 用完全相同的命令行/cwd/环境变量 detached 重启 dsh web，并等待端口恢复；
//   5. 把全过程写到 ~/.dsh/logs/maintenance/*.log，重启进程的 stdout/stderr 单独成文件。
//
// 注意：
//   * 停掉 dsh web 会中断所有 DSH 对话（包括当前 Web 对话）和 QQ bot 的回合；
//     请在没有聊天、可以中断的时候运行。
//   * 不要在本对话的 bash 工具里运行：脚本会检测到自己在 dsh 进程树里并拒绝。
//     请从独立的终端 / screen 窗口运行。
//   * 清理期间不要 Ctrl+C；脚本会在日志里先写下手动恢复命令，万一中断可照着启动。
//
// 用法：
//   node scripts/restart-dsh-and-clean.mjs --status          # 只看目标，不动
//   node scripts/restart-dsh-and-clean.mjs --yes             # 停 → 清 → 起
//   node scripts/restart-dsh-and-clean.mjs --yes -- --dsh-validate
//   node scripts/restart-dsh-and-clean.mjs --yes -- --preset qq-chat,qq-chat-v2
//   node scripts/restart-dsh-and-clean.mjs --yes -- --list  # 只列，不写 session
//
// 常用参数：--port <n> --dsh-home <dir> --tool <path> --keep-stopped
//          --stop-timeout <秒> --start-timeout <秒> --log-dir <dir> --yes
// 参数 `--` 之后的内容原样传给清理工具。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 3080;
const DEFAULT_TOOL = path.join(__dirname, 'strip-session-thinking.mjs');

function usage() {
  return `用法: node scripts/restart-dsh-and-clean.mjs [options] [-- <清理工具参数>]

停止 dsh web → 离线清理 session 思考 → 用相同命令/cwd/环境变量重新启动 dsh web。

选项:
  --port <n>             dsh web 监听端口（默认 3080）
  --dsh-home <dir>       DSH 数据目录（默认目标的 DSH_HOME，再退到 $DSH_HOME / ~/.dsh）
  --tool <path>          清理工具路径（默认 scripts/strip-session-thinking.mjs）
  --log-dir <dir>        日志目录（默认 <dsh-home>/logs/maintenance）
  --stop-timeout <秒>    等待 SIGTERM 退出的时间（默认 20）
  --start-timeout <秒>   等待端口恢复的时间（默认 60）
  --keep-stopped         清理完不重启（调试用；之后需手动启动）
  --yes, -y              不询问确认（脚本从终端运行时会显示目标并要求确认）
  --status               只打印目标进程/命令/端口，不做任何改动
  -h, --help             显示本帮助

示例:
  # 先确认目标
  node scripts/restart-dsh-and-clean.mjs --status

  # 停 → 清理全部 qq-chat-v2 → 重启
  node scripts/restart-dsh-and-clean.mjs --yes

  # 清理时额外校验，并只清一个会话
  node scripts/restart-dsh-and-clean.mjs --yes -- --dsh-validate --only session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

  # 只列会话、不写文件，但仍走一遍停/起（用于演练）
  node scripts/restart-dsh-and-clean.mjs --yes -- --list

安全:
  * 默认从独立终端运行；检测到脚本在目标 dsh 进程树内会拒绝执行。
  * 清理失败也会尝试重启 dsh web；重启失败会打印手动恢复命令和日志路径。
  * 清理工具自己的备份在 <dsh-home>/session-maintenance/backups/ 下。
  * 重启进程是 detached 的，不依赖原来的 screen 窗口；旧 screen 会话会留在 shell 提示符，
    不要在那个窗口里再启动一个 3080 的 dsh web（会端口冲突）。
  * 目前按 Linux 实现（/proc、lsof/ss）；Windows 请继续用 start.bat / 手动流程。
`;
}

function expandHome(value) {
  if (!value) return value;
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseArgs(argv) {
  const opts = {
    port: DEFAULT_PORT,
    dshHome: '',
    tool: DEFAULT_TOOL,
    logDir: '',
    stopTimeout: 20,
    startTimeout: 60,
    keepStopped: false,
    yes: false,
    status: false,
    cleanupArgs: [],
    help: false,
  };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      opts.cleanupArgs = argv.slice(i + 1);
      break;
    }
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} 需要参数`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--port': {
        const port = Number(value());
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port 必须是 1-65535');
        opts.port = port;
        break;
      }
      case '--dsh-home':
        opts.dshHome = value();
        break;
      case '--tool':
        opts.tool = value();
        break;
      case '--log-dir':
        opts.logDir = value();
        break;
      case '--stop-timeout': {
        const seconds = Number(value());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--stop-timeout 必须是正数');
        opts.stopTimeout = seconds;
        break;
      }
      case '--start-timeout': {
        const seconds = Number(value());
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--start-timeout 必须是正数');
        opts.startTimeout = seconds;
        break;
      }
      case '--keep-stopped':
        opts.keepStopped = true;
        break;
      case '--yes':
      case '-y':
        opts.yes = true;
        break;
      case '--status':
        opts.status = true;
        break;
      default:
        throw new Error(`未知参数: ${arg}（用 --help 查看用法）`);
    }
  }
  if (!opts.help) {
    opts.tool = path.resolve(expandHome(opts.tool));
    if (opts.dshHome) opts.dshHome = path.resolve(expandHome(opts.dshHome));
    if (opts.logDir) opts.logDir = path.resolve(expandHome(opts.logDir));
  }
  return opts;
}

// ── 进程发现与检查 ──────────────────────────────────────────────────────────

function pidsListeningOn(port) {
  const pids = new Set();
  try {
    const out = execFileSync('lsof', ['-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const token of out.split(/\s+/)) if (/^\d+$/.test(token)) pids.add(Number(token));
  } catch {}
  if (pids.size === 0) {
    try {
      const out = execFileSync('ss', ['-ltnp', `sport = :${port}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const match of out.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
    } catch {}
  }
  return [...pids];
}

function parseEnviron(buffer) {
  const env = {};
  for (const entry of buffer.toString('utf8').split('\0')) {
    if (!entry) continue;
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    env[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return env;
}

function inspectTarget(pid, port) {
  const proc = `/proc/${pid}`;
  if (!fs.existsSync(proc)) throw new Error(`进程 ${pid} 不存在`);
  const exe = fs.readlinkSync(`${proc}/exe`).replace(/ \(deleted\)$/, '');
  const argv = fs.readFileSync(`${proc}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  const cwd = fs.readlinkSync(`${proc}/cwd`);
  const env = parseEnviron(fs.readFileSync(`${proc}/environ`));
  if (!argv.includes('web')) throw new Error(`进程 ${pid} 不是 dsh web（命令行没有 web）: ${argv.join(' ')}`);
  if (!argv.some((arg) => /dsh/i.test(arg))) throw new Error(`进程 ${pid} 命令行里没有 dsh: ${argv.join(' ')}`);
  if (!path.isAbsolute(exe)) throw new Error(`无法解析进程 ${pid} 的可执行文件`);
  if (!/node/i.test(path.basename(exe))) throw new Error(`进程 ${pid} 不是 node 进程（${exe}），拒绝操作`);
  if (!fs.existsSync(cwd)) throw new Error(`进程 ${pid} 的 cwd 不存在: ${cwd}`);
  if (Object.keys(env).length === 0) throw new Error(`读不到进程 ${pid} 的环境变量（权限？）`);
  delete env.NODE_CHANNEL_FD;
  delete env.NODE_CHANNEL_SERIALIZATION_MODE;
  delete env.NODE_UNIQUE_ID;
  env.PWD = cwd;
  return {
    pid,
    port,
    exe,
    argv,
    cwd,
    env,
    restartArgv: [exe, ...argv.slice(1)],
    cmdline: argv.join(' '),
  };
}

function isPidAlive(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // 第三个字段是状态；Z 僵尸不算存活。
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z';
  } catch {
    return false;
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(400);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function isAncestor(ancestorPid, pid) {
  let current = pid;
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === ancestorPid) return true;
    if (current <= 1) return false;
    let status;
    try {
      status = fs.readFileSync(`/proc/${current}/status`, 'utf8');
    } catch {
      return false;
    }
    const match = /^PPid:\s+(\d+)/m.exec(status);
    if (!match) return false;
    const parent = Number(match[1]);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

// ── 停止 / 启动 ─────────────────────────────────────────────────────────────

async function stopDsh(target, opts) {
  logLine(opts, `发送 SIGTERM 给 pid ${target.pid} ...`);
  try {
    process.kill(target.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
    logLine(opts, '进程已不存在');
  }
  const deadline = Date.now() + opts.stopTimeout * 1000;
  while (Date.now() < deadline) {
    if (!isPidAlive(target.pid) && !(await isPortOpen(target.port))) return 'SIGTERM';
    await sleep(250);
  }
  logLine(opts, `SIGTERM 等待 ${opts.stopTimeout}s 未退出，发送 SIGKILL ...`);
  try {
    process.kill(target.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  const killDeadline = Date.now() + 5000;
  while (Date.now() < killDeadline) {
    if (!(await isPortOpen(target.port))) return 'SIGKILL';
    await sleep(200);
  }
  throw new Error(`端口 ${target.port} 仍被占用，停止失败`);
}

async function httpAlive(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(1000),
      redirect: 'manual',
    });
    try {
      await response.arrayBuffer();
    } catch {}
    return true;
  } catch {
    return false;
  }
}

function startDsh(target, opts, logDir, runStamp) {
  const restartLog = path.join(logDir, `dsh-restart-${runStamp}.log`);
  const fd = fs.openSync(restartLog, 'a');
  fs.writeSync(
    fd,
    `[${new Date().toISOString()}] maintenance restart\nargv=${JSON.stringify(target.restartArgv)}\ncwd=${target.cwd}\n\n`,
  );
  let child;
  try {
    child = spawn(target.restartArgv[0], target.restartArgv.slice(1), {
      cwd: target.cwd,
      env: target.env,
      detached: true,
      stdio: ['ignore', fd, fd],
    });
  } finally {
    fs.closeSync(fd);
  }
  child._maintenanceSpawnError = null;
  child.on('error', (error) => {
    child._maintenanceSpawnError = error;
  });
  if (!child.pid) {
    throw new Error(`spawn 失败：${target.restartArgv[0]}`);
  }
  child.unref();
  return { child, restartLog };
}

async function waitForHealth(target, opts, child, restartLog) {
  const deadline = Date.now() + opts.startTimeout * 1000;
  while (Date.now() < deadline) {
    if (child && child._maintenanceSpawnError) {
      throw new Error(`spawn 失败：${child._maintenanceSpawnError.message}`);
    }
    if (child && child.exitCode !== null) {
      throw new Error(`dsh web 启动后立即退出（code ${child.exitCode}）`);
    }
    if (await httpAlive(target.port)) return true;
    await sleep(300);
  }
  throw new Error(`等待 http://127.0.0.1:${target.port} 恢复超时`);
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

// ── 日志与清理 ──────────────────────────────────────────────────────────────

let LOG_FILE = '';
function logLine(opts, message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, `${line}\n`);
    } catch {}
  }
}

function printTarget(target, dshHome) {
  console.log(`目标 dsh web: pid ${target.pid}`);
  console.log(`  端口:     ${target.port}`);
  console.log(`  命令:     ${target.cmdline}`);
  console.log(`  工作目录: ${target.cwd}`);
  console.log(`  可执行:   ${target.exe}`);
  console.log(`  DSH home: ${dshHome}`);
}

async function confirmRun(target, dshHome, opts) {
  if (opts.yes) return true;
  if (!stdin.isTTY) {
    stderr.write('非交互终端：确认执行请加 --yes（或用 --status 只看目标）。\n');
    return false;
  }
  printTarget(target, dshHome);
  console.log('');
  console.log('将停止 dsh web，期间所有 DSH 对话和 QQ bot 回合都会中断；清理后自动重启。');
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question('继续？[y/N] ');
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function runCleanup(target, opts, dshHome) {
  const args = [
    opts.tool,
    '--dsh-home',
    dshHome,
    '--dsh-url',
    `http://127.0.0.1:${target.port}`,
    ...opts.cleanupArgs,
  ];
  logLine(opts, `执行清理：${process.execPath} ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) logLine(opts, result.stdout.trimEnd());
  if (result.stderr) logLine(opts, result.stderr.trimEnd());
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`清理工具退出码 ${result.status}`);
}

function restartCommandString(target) {
  const envPrefix = target.env.DSH_HOME ? `DSH_HOME=${JSON.stringify(target.env.DSH_HOME)} ` : '';
  const command = target.restartArgv.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');
  return `cd ${JSON.stringify(target.cwd)} && ${envPrefix}${command}`;
}

function manualRestartHint(target, restartLog) {
  console.error('');
  console.error('手动重启命令：');
  console.error(`  ${restartCommandString(target)}`);
  if (restartLog) console.error(`重启日志：${restartLog}`);
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  let target;
  const pids = pidsListeningOn(opts.port);
  if (pids.length === 0) {
    console.error(`没有找到监听 ${opts.port} 的 dsh web 进程。`);
    console.error('如果 dsh web 本来就没运行，请先手动启动；或者用 --port 指定正确端口。');
    return 2;
  }
  if (pids.length > 1) {
    console.error(`端口 ${opts.port} 有多个监听进程: ${pids.join(', ')}；拒绝自动选择。`);
    return 2;
  }
  try {
    target = inspectTarget(pids[0], opts.port);
  } catch (error) {
    console.error(`目标检查失败: ${error.message}`);
    return 2;
  }

  const explicitHome = Boolean(opts.dshHome);
  const dshHome = path.resolve(
    expandHome(
      opts.dshHome ||
        target.env.DSH_HOME ||
        process.env.DSH_HOME ||
        path.join(os.homedir(), '.dsh'),
    ),
  );
  // 显式指定 --dsh-home 时，重启也钉到同一个 home；否则沿用目标进程原有的环境。
  if (explicitHome) target.env.DSH_HOME = dshHome;
  if (opts.status) {
    printTarget(target, dshHome);
    console.log('--status：不做任何改动。');
    return 0;
  }

  const logDir = opts.logDir || path.join(dshHome, 'logs', 'maintenance');
  const runStamp = `${stamp()}-${process.pid}`;
  fs.mkdirSync(logDir, { recursive: true });
  LOG_FILE = path.join(logDir, `restart-and-clean-${runStamp}.log`);

  logLine(opts, `日志: ${LOG_FILE}`);
  printTarget(target, dshHome);
  logLine(opts, `目标: pid=${target.pid} port=${target.port} cmd=${target.cmdline} cwd=${target.cwd}`);
  logLine(opts, `清理工具: ${opts.tool}`);
  logLine(opts, `清理参数: ${opts.cleanupArgs.length ? opts.cleanupArgs.join(' ') : '(默认)'}`);

  if (!fs.existsSync(opts.tool)) {
    console.error(`清理工具不存在: ${opts.tool}`);
    return 2;
  }

  if (isAncestor(target.pid, process.pid)) {
    console.error('');
    console.error('检测到本脚本运行在目标 dsh web 的进程树内（很可能是在 DSH 对话的 bash 工具里）。');
    console.error('停掉 dsh web 会连本脚本一起结束，清理可能来不及执行。');
    console.error('请从独立的终端 / screen 窗口运行：');
    console.error(`  cd ${JSON.stringify(ROOT)} && node scripts/restart-dsh-and-clean.mjs --yes`);
    console.error('只用 --status 查看目标是安全的。');
    return 2;
  }

  if (!opts.yes && !stdin.isTTY) {
    console.error('非交互终端：确认执行请加 --yes（或用 --status 只看目标）。');
    return 2;
  }
  if (!(await confirmRun(target, dshHome, opts))) {
    logLine(opts, '已取消。');
    return 0;
  }

  let stopped = false;
  let restarted = false;
  let restartLog = '';
  let cleanupError;
  let restartError;

  const manualCommand = restartCommandString(target);
  logLine(opts, `手动恢复命令（若脚本中断）: ${manualCommand}`);

  try {
    logLine(opts, '停止 dsh web ...');
    const signal = await stopDsh(target, opts);
    stopped = true;
    logLine(opts, `已停止（${signal}）。`);
    logLine(opts, '开始离线清理 ...');
    try {
      runCleanup(target, opts, dshHome);
      logLine(opts, '清理完成。');
    } catch (error) {
      cleanupError = error;
      logLine(opts, `清理失败：${error.message}`);
    }
  } catch (error) {
    logLine(opts, `停止阶段失败：${error.message}`);
    // 端口若已经关闭，仍尝试重启；否则不要重复启动。
    stopped = !(await isPortOpen(target.port));
    if (!stopped) {
      logLine(opts, 'dsh web 仍在运行，未执行清理。');
      return 1;
    }
    cleanupError = new Error('停止阶段失败，未执行清理');
  }

  if (opts.keepStopped) {
    logLine(opts, '--keep-stopped：不重启 dsh web。');
    manualRestartHint(target, '');
    return cleanupError ? 1 : 0;
  }

  if (await isPortOpen(target.port)) {
    restartError = new Error(`清理期间端口 ${target.port} 被重新占用，放弃启动第二个实例`);
    logLine(opts, restartError.message);
  } else {
    try {
      logLine(opts, '重启 dsh web ...');
      const started = startDsh(target, opts, logDir, runStamp);
      restartLog = started.restartLog;
      logLine(opts, `已 spawn pid ${started.child.pid}，重启日志: ${restartLog}`);
      await waitForHealth(target, opts, started.child, restartLog);
      const listeners = pidsListeningOn(target.port);
      if (listeners.length > 0 && !listeners.includes(started.child.pid)) {
        throw new Error(`端口 ${target.port} 的监听者不是新进程（listener=${listeners.join(',')}, child=${started.child.pid}）`);
      }
      restarted = true;
      logLine(opts, `DSH Web 已恢复: http://127.0.0.1:${target.port}`);
    } catch (error) {
      restartError = error;
      logLine(opts, `重启失败：${error.message}`);
      if (restartLog) logLine(opts, `重启日志尾部:\n${tail(restartLog)}`);
      manualRestartHint(target, restartLog);
    }
  }

  logLine(opts, `结果：清理${cleanupError ? '失败' : '完成'}；Web ${restarted ? '已恢复' : '未恢复'}。`);
  return cleanupError || restartError ? 1 : 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
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
  pidsListeningOn,
  inspectTarget,
  isAncestor,
  isPortOpen,
  parseArgs,
  main,
};
