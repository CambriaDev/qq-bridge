# 清理 DSH 会话里的思考内容（QQ 二代仿真）

> 工具：`scripts/strip-session-thinking.mjs`
> 回归：`npm run test:strip-thinking`
> 适用：`agentPreset = qq-chat-v2`（界面显示「QQ 聊天角色（二代仿真）」）的 DSH v4 session。

## 为什么会有这个工具

DSH 会把 assistant 的 reasoning 块、`replayState` 里对应的签名、以及 live SSE 的原始 `stream`
一起写进 `session.v4.jsonl.zstd`。QQ 二代仿真是长驻会话，跑几天后思考内容通常比对话本身大好几倍；
浏览器打开历史时也要把这些块重新建出来。

这个工具在 **DSH 停止时**离线重写会话文件，只删思考，不动对话：

- 删除 `assistant/message.message.content` 里 `type: "reasoning"` 的块；
- 删除 `message.source.replayState.blocks` 里对应的 reasoning 条目；
- 清空含 reasoning 的 `data.stream`（界面渲染用的是 `message.content`，原始流是 SSE 回放）。

**保留**：所有事件、`seq`、用户消息、助手可见文本、工具调用/结果、标题、用量、权限事件。
事件数不变，不删回合，不改时间线。

## 先看再清

```bash
cd ~/compose/qq-bgridge

# 只列出匹配的会话、思考块数量和清理后体积（只读，DSH 开着也能跑）
node scripts/strip-session-thinking.mjs --list

# 完整分析但不写文件
node scripts/strip-session-thinking.mjs --dry-run
```

默认只匹配 `qq-chat-v2`。也可以：

```bash
# 连一代 qq-chat 一起
node scripts/strip-session-thinking.mjs --preset qq-chat,qq-chat-v2

# 用显示名（会自动映射到 id）
node scripts/strip-session-thinking.mjs --preset "QQ 聊天角色（二代仿真）"

# 只处理某一个会话（显式点名会绕过预设过滤）
node scripts/strip-session-thinking.mjs --only session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# 所有预设（谨慎：会清理 standard 等其他会话）
node scripts/strip-session-thinking.mjs --all-presets
```

## 真正执行（推荐停机）

```bash
# 1. 停掉 dsh web
#    screen -r dsh 后 Ctrl+C，或按你的启动方式停

# 2. 清理所有 QQ 二代仿真会话
node scripts/strip-session-thinking.mjs

# 3. 重新启动 dsh web
```

### 一键停 / 清 / 起（维护脚本）

不想手动切换终端时，用 `scripts/restart-dsh-and-clean.mjs`：

```bash
# 只看目标进程/命令/端口，不做改动
npm run restart-dsh-and-clean -- --status

# 停 dsh web → 清理 qq-chat-v2 → 用相同命令/cwd/环境变量重启
npm run restart-dsh-and-clean -- --yes

# `--` 后面原样传给清理工具
npm run restart-dsh-and-clean -- --yes -- --dsh-validate
npm run restart-dsh-and-clean -- --yes -- --preset qq-chat,qq-chat-v2
npm run restart-dsh-and-clean -- --yes -- --list   # 演练停/起，只列不写
```

它按端口找到监听进程，记录命令行、cwd、环境变量，先 SIGTERM（超时再 SIGKILL），
再离线清理，最后用同样的配置 detached 重启并等 `http://127.0.0.1:3080` 恢复。

- **从独立终端运行**。脚本会检测自己是否在 dsh 进程树内；在本对话的 bash 工具里运行会被拒绝。
- 停 dsh web 会中断当前 Web 对话和 QQ bot 回合，挑没人聊天的时候。
- 清理失败也会尝试重启；重启失败会打印手动命令和日志路径。
- 日志：`<dsh-home>/logs/maintenance/restart-and-clean-<时间戳>.log`，被重启进程的输出在
  同目录 `dsh-restart-<时间戳>.log`。
- 重启是 detached 的，不依赖原来的 screen 窗口；旧 screen 会停在 shell，不要在那个窗口里
  再启动一个 3080 的实例。
- 可选 `--port`、`--dsh-home`、`--tool`、`--stop-timeout`、`--start-timeout`、`--keep-stopped`。
- 维护脚本按 **Linux** 实现（`/proc`、`lsof`/`ss`）；Windows 请继续用 `start.bat` / 手动停起。
- 如果重启后 Web 页面提示未授权，重启日志里通常有这次新进程打印的带 token 的 URL。

清理工具默认拒绝在 DSH Web 仍响应时写文件（探活 `http://127.0.0.1:3080`）。原因：

- 所有 session 的 agent 都常驻内存，热替换文件后已打开的界面仍显示旧内容；
- 当前回合/后续回合会继续追加新的思考内容；
- 正在追加时替换有丢事件的风险。

确实要热替换：

```bash
node scripts/strip-session-thinking.mjs --allow-live
```

文件会变干净，但必须重启 DSH 才彻底生效；脚本会在写前重新 `stat`，清理期间被追加过就跳过该会话。
`--allow-live` 不改变“新回合还会写思考”这一点。

## 安全设计

- **默认只写有思考的会话**：没有 reasoning 的文件不写、不备份，所以可重复运行。
- **备份**：默认写到 `~/.dsh/session-maintenance/backups/<时间戳>-<随机>/`，保留相对目录结构和
  `manifest.json`（sessionId / 原文件 / 备份路径 / 大小 / sha256）。
- **原子替换**：同目录临时文件 → `fsync` → `rename`，保留原文件权限。
- **复核回滚**：替换后重新解析，检查事件数、`seq`、无 reasoning；失败时自动用备份覆盖回去。
- **读稳定快照**：读取前后各 `stat` 一次，正在被追加就重试一次，仍不稳定则跳过。
- **不支持的会整体跳过**：如果 reasoning 结构出现在 `assistant/message` 之外（例如
  `assistant/attempt` 的 stream），该会话标记 `skipped`，绝不半清半留。

## 输出怎么读

```text
状态          会话                                              预设                事件    思考块              体积
cleaned     session-...                                        qq-chat-v2       2442     383   1.40 MB → 322.4 KB
clean       session-...                                        qq-chat-v2       2421       0   320.6 KB → 320.6 KB
```

- `cleaned`：已写回；`--list`/`--dry-run` 下显示 `would-clean`。
- `clean`：没有思考内容，未写。
- `skipped`：尾部不完整、读取期间被追加、含不支持的思考结构等，未写（`└` 行有原因）。
- `failed`：读取/校验/写入失败；退出码 1。

常用参数：

| 参数 | 作用 |
| --- | --- |
| `--list` / `--dry-run` | 只读，DSH 开着也能跑 |
| `--apply` | 默认模式（写文件） |
| `--allow-live` | DSH 在跑也写（不推荐） |
| `--dsh-home <dir>` | DSH 数据目录，默认 `$DSH_HOME` 或 `~/.dsh` |
| `--dsh-url <url>` | 探活地址，默认 `http://127.0.0.1:3080` |
| `--preset <id,name>` | 预设过滤，逗号分隔或重复 |
| `--all-presets` | 不过滤预设 |
| `--only <session-id>` | 只处理指定会话，可重复 |
| `--backup-dir <dir>` | 备份根目录 |
| `--no-backup` | 不备份（不建议；失败时无法自动回滚） |
| `--dsh-validate` | 额外用 DSH 的 `Session.fromRestore` 校验（自动找 npx 里的 `dsh-session`） |
| `--json` | stdout 只输出一个 JSON 对象 |
| `--fail-fast` | 第一个失败/跳过就停 |

## 回滚

```bash
# 用 manifest 找到备份，再按相对路径覆盖回去
jq -r '.entries[] | "\(.backup) -> \(.file)"' \
  ~/.dsh/session-maintenance/backups/<时间戳>/manifest.json

cp -a <backup> <file>
```

## 限制

- 清理只针对已有历史。之后的新回合仍会正常产生并写入新的思考内容；要再清就再跑一次。
- 被强行中断、尾部有不完整帧的会话会跳过。先让 DSH 打开一次该 session（持久化层会修复尾部），
  再重跑。
- 备份里仍然含思考内容；确认不需要回滚后可以删除 `backup/`。
- `--dsh-validate` 依赖本机 npx 缓存里的 `@deepseek-ai/dsh-session`；找不到时可用
  `DSH_SESSION_MODULE=/path/to/dsh-session/lib/index.js` 指定。
