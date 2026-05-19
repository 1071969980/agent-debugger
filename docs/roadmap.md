# 多语言适配器优化路线图

> 基于 Python 适配器近期优化（2026-05）的差距分析，评估 Node.js / Go / Rust 的同类需求。

## 1 Python 近期优化一览

| # | 特性 | 提交 | 说明 |
|---|------|------|------|
| 1 | 子进程调试 | `0287688` | `os.fork()` / `multiprocessing` 自动发现、独立会话、断点同步 |
| 2 | 断点管理子命令 | `96eb1f9` | `break add/list/rm/clear` 完整生命周期 |
| 3 | 异常详情 | `9413365` | 暂停时自动获取异常类型、描述、堆栈 |
| 4 | 异常断点 + 后台监听 | `686a01e` | `--catch` 参数 + 后台事件循环 |
| 5 | 多会话管理 | `a568b89` | `--session` 路由、`list`/`shutdown` 命令 |

其中 2-5 由 `debug-controller.ts` / `session.ts` 统一实现，所有语言自动受益。**各语言真正需要单独适配的是第 1 项（子进程调试）以及 attach/inject 能力。**

## 2 特性覆盖矩阵

| 特性 | Python | Node.js | Go | Rust/C++ | 实现层级 |
|------|:------:|:-------:|:--:|:--------:|----------|
| Launch 启动 | OK | OK | OK | OK | adapter |
| Attach（端口） | OK | **缺失** | **缺失** | **缺失** | adapter |
| Attach（--pid 注入） | OK | **缺失** | **缺失** | **缺失** | adapter |
| 子进程调试 | OK | **缺失** | 不适用 | 待调研 | adapter |
| 断点自动同步到子进程 | OK | **缺失** | 不适用 | 待调研 | adapter |
| 异常断点 (--catch) | OK | OK | OK | OK | adapter（已定义 filters） |
| 异常详情获取 | OK | OK | OK | OK | 框架级 |
| 断点管理子命令 | OK | OK | OK | OK | 框架级 |
| 后台事件监听 | OK | OK | OK | OK | 框架级 |
| 多会话管理 | OK | OK | OK | OK | 框架级 |
| 自动安装依赖 | OK | **缺失** | **缺失** | **缺失** | adapter |
| 自定义 runtime 路径 | OK | **缺失** | **缺失** | 不适用 | adapter |

> "框架级" = 由 `DebugController`/`Session` 统一处理，无需各语言单独实现。

## 3 各语言任务清单

### 3.1 Node.js（优先级：高）

Node.js 在后端服务场景广泛，"无重启调试"是刚需，应优先对齐。

| 任务 | 说明 | 预估代码量 | 难度 |
|------|------|-----------|------|
| **attach 支持（端口）** | js-debug 支持 `attach` request，可连接到 `--inspect` 模式启动的 Node 进程。需实现 `attachFlow()` | ~150 行 | 中 |
| **--pid 注入** | Node 没有 Python C API 那样的注入机制。替代方案：(1) 通过 SIGUSR1 激活已启动进程的 inspector；(2) 引导用户使用 `--inspect-brk` 启动。需调研 `process._debugProcess()` 可行性 | ~200 行 | 大 |
| **子进程调试** | Node `child_process.fork()` / `cluster` 生成的子进程。js-debug 提供 `nodeFilter` 和多目标调试能力 | ~200 行 | 中-大 |
| **自动检测/安装 js-debug** | 当前仅从 VS Code 扩展目录查找。增加：npx 自动下载、全局 npm 包查找、`JS_DEBUG_PATH` 友好提示 | ~50 行 | 小 |
| **自定义 runtime 路径** | 支持指定 node 路径（不同版本 node） | ~20 行 | 小 |

**总计：~400-500 行**

#### 关键技术点

- `@vscode/js-debug` 的 attach 模式需指定 `processId`（数字 PID）或 `inspectUri`（WebSocket URL）
- SIGUSR1 方案：`process.kill(pid, 'SIGUSR1')` 可让已运行的 Node 进程开启 inspector，然后通过 WebSocket 连接
- 子进程调试需关注 `nodeFilter` 配置项，用于区分主进程和子进程

### 3.2 Go（优先级：中）

Go 服务端场景多，Delve 对 attach 支持良好，实现成本较低。Go 的并发模型是 goroutine（由 DAP threadId 覆盖），**不需要子进程调试**。

| 任务 | 说明 | 预估代码量 | 难度 |
|------|------|-----------|------|
| **attach 支持（PID）** | Delve 支持 `dlv attach <pid> --headless`，直接在适配器中实现 `attachFlow()` | ~120 行 | 中 |
| **attachFlow** | 复用现有 initFlow 模式，将 `launch` 改为 `attach`，指定 `processId` | ~80 行 | 小-中 |
| **自动安装 dlv** | 执行 `go install github.com/go-delve/delve/cmd/dlv@latest` | ~30 行 | 小 |

**总计：~200-250 行**

#### 关键技术点

- Delve DAP 模式的 attach：`dlv dap --listen 127.0.0.1:<port>`，然后发送 `attach` request（含 `processId`）
- 不需要原生调试器注入，Delve 自身处理 ptrace attach
- `dlv attach` 需要适当权限（Linux 上可能需要 `sudo` 或 `sysctl kernel.yama.ptrace_scope=0`）

### 3.2 Rust/C++（优先级：中-低）

| 任务 | 说明 | 预估代码量 | 难度 |
|------|------|-----------|------|
| **attach 支持（PID）** | CodeLLDB 支持 `--attach <pid>` 参数，实现 `attachFlow()` | ~120 行 | 中 |
| **attachFlow** | 与 Go 类似，发送 `attach` request 并设置 `processId` | ~80 行 | 小-中 |
| **自动检测 CodeLLDB** | 从 VS Code 扩展目录自动查找（类似 js-debug 现有模式） | ~50 行 | 小 |
| **子进程调试** | 需要 lldb 的 `follow-fork-mode` 等机制，CodeLLDB 有限支持。**需调研** | 待定 | 大 |

**总计：~250-300 行（不含子进程调试）**

#### 关键技术点

- CodeLLDB attach：`codelldb --port <port>`，然后发送 `attach` request（含 `pid`）
- 子进程调试涉及操作系统级 `PTRACE_O_TRACEFORK`/`PTRACE_O_TRACECLONE`，复杂度较高
- Rust 的 panic 已通过异常断点覆盖，goroutine 式的并发调试不适用

## 4 实施建议

### 阶段一：Attach 能力补齐

**目标**：所有语言支持 attach 到运行中的进程。

1. Node.js — `attachFlow()` 端口连接 + SIGUSR1 激活
2. Go — `attachFlow()` + `dlv attach`
3. Rust — `attachFlow()` + CodeLLDB attach
4. 更新 `base.ts` 将 `attachFlow` 从可选改为推荐
5. 更新 CLI `attach` 命令，根据语言自动路由

### 阶段二：--pid 注入

**目标**：所有语言支持 `--pid` 无代码侵入式调试。

1. Go — 直接委托给 Delve（最简单）
2. Rust — 通过 lldb/gdb attach（类似 Python 但无需注入解释器代码）
3. Node.js — SIGUSR1 + inspector WebSocket（需充分调研）

### 阶段三：自动安装 / 检测

**目标**：零配置开箱即用。

1. 各适配器增加 auto-install 逻辑
2. 友好错误提示，引导用户安装

### 阶段四：子进程调试（按需）

**目标**：Node.js 支持子进程调试。

1. 调研 js-debug 多目标调试能力
2. 实现类似 Python 的 `drainSubprocessEvents` + `SubprocessSession` 模式
3. Go 不需要此功能
4. Rust 视调研结果决定

## 5 代码架构参考

当前 Python 的子进程调试实现可作为模板：

```
base.ts               → 定义 SubprocessInfo, AttachFlowOpts, InjectResult 接口
python.ts             → 实现 inject(), attachFlow(), drainSubprocessEvents()
subprocess-session.ts → 子进程会话管理（通用，可直接复用）
debug-controller.ts   → 调试状态机（通用，可直接复用）
session.ts            → 父子会话编排（通用，可直接复用）
```

其他语言需要做的：
- 在各自的 adapter 中实现 `inject()` 和 `attachFlow()`
- 如需子进程支持，实现 `drainSubprocessEvents()`
- 其余基础设施（`SubprocessSession`、`DebugController`、`Session`）已通用化，无需改动
