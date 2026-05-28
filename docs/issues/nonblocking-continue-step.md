# 待修复问题清单

> 来源：`continue`/`step` 非阻塞重构 (multi-session 分支) 的代码审查

## Medium — bg event loop 与 waitForStop 竞争

**文件**: `src/debug-controller.ts:52-83` vs `src/debug-controller.ts:499-551`

**问题**: 非阻塞 `continue`/`step` 启动 bg event loop 监听 stopped 事件。之后用户调 `continue --wait`，进入 `waitForStop()` 也监听 stopped 事件。两者通过 `client.waitForEvent("stopped")` 竞争同一个 DAP 事件。

**机制**: `stopBgEventLoop()` (line 87) 只设 `bgLoopAbort = true`，不会取消 bg loop 中正在 await 的 `waitForEvent`。bg loop 可能先消费 stopped 事件，导致 `waitForStop` 等到下一个 1s 超时轮次才发现 state 已变 paused，产生最多 1s 延迟。

**虽然命令队列串行化避免了真正并发**，但时序上存在：
1. 非阻塞 continue → 启动 bg loop → 返回
2. 用户调 `continue --wait` → 命令队列等上条完成 → 进入 `waitForStop()`
3. 此时 bg loop 的 `waitForEvent("stopped", 1000)` 已经在 pending
4. `waitForStop` 也调 `waitForEvent("stopped", 1000)`
5. 哪个先注册的 listener 先拿到事件

**修复方向**: `wait=true` 时，在发 DAP continue/step 请求之前调用 `stopBgEventLoop()`，并让 bg loop 的 pending `waitForEvent` 能被中断。可以考虑给 `waitForEvent` 加 abort signal，或在 `stopBgEventLoop` 中注入一个 resolved 值。

---

## Medium — bgStopReason 导致 step/continue 死锁

**文件**: `src/debug-controller.ts:327-329`, `src/debug-controller.ts:348-349`

**问题**: bg event loop 捕获 stopped 事件后设置 `bgStopReason`。之后用户调 `step` 或 `continue`，代码检查到 `bgStopReason` 非空，直接返回错误：

```
"Paused by a background event. Run 'status' to inspect before stepping."
```

**只有 `getStatusAsync()` 会清除 `bgStopReason`** (line 403: `this.bgStopReason = null`)。如果用户不调 `status`，debugger 处于 paused 状态但拒绝所有 resume 命令。

**典型场景**:
- 用户用 `--catch` 启动，程序抛异常被 bg loop 捕获
- 用户直接调 `eval` 检查变量 — 正常工作（eval 不检查 bgStopReason）
- 用户调 `continue` — 被拒，要求先 `status`
- 用户调 `status` — 看到异常信息，bgStopReason 被清
- 用户再调 `continue` — 正常

**修复方向**:
- 方案 A: 在 `step`/`continue` 中自动清除 `bgStopReason`（去掉守卫）
- 方案 B: 保留守卫但改为 warning 而非 error，自动清除并继续执行
- 方案 C: 加 `--force` 标志绕过守卫

---

## Low — getStatusAsync 与 waitForStop 的 exception 获取逻辑不一致

**文件**: `src/debug-controller.ts:407` vs `src/debug-controller.ts:506`

**问题**: `getStatusAsync` 对 reason 为 `"breakpoint"` 或 `"step"` 时跳过 `fetchExceptionInfo()`。但 `waitForStop` 只跳过 `"breakpoint"`，不跳过 `"step"`。

**影响**: 无实际 bug — step 停止时没有 exception 可取，`fetchExceptionInfo` 返回 null。但逻辑不一致可能导致后续维护混乱。

**修复**: 统一两处逻辑，提取为 `isExceptionReason(reason)` helper。

---

## Low — step --wait into 参数顺序解析问题

**文件**: `src/cli.ts:549-551`

**问题**: `agent-debugger step --wait into` 会将 `into` 静默丢弃。当前解析：
```typescript
const wait = args.includes("--wait") || args.includes("-w");
const kind = ["over", "into", "out"].includes(args[1] || "") ? args[1] : "over";
```
`args[1]` 是 `"--wait"`，不在 `["over", "into", "out"]` 中，kind 默认 `"over"`。

**修复**: 先剥离 flags 再解析 positional args：
```typescript
const stepArgs = args.filter(a => a !== "--wait" && a !== "-w");
const kind = ["over", "into", "out"].includes(stepArgs[1] || "") ? stepArgs[1] : "over";
```

---

## Low — listBreakpoints 硬编码 verified: true

**文件**: `src/debug-controller.ts:458-466`

**问题**: `listBreakpoints()` 返回的每个断点都设 `verified: true`，不追踪 DAP adapter 返回的实际验证状态。`addBreakpoint` 的 `syncBreakpointsToFile` 返回了 `verified[]` 但只在添加时使用，未持久化。

**影响**: `break list` 可能显示 `verified` 但实际断点未生效。

**修复**: 在 breakpoints map 中存储 `verified` 字段，`syncBreakpointsToFile` 后更新。

---

## Low — clearBreakpoints 广播时数据可能过期

**文件**: `src/debug-controller.ts:484-494`

**问题**: `clearBreakpoints` 遍历文件列表，对每个文件调 `onBreakpointsChanged`。但循环中先 `this.breakpoints.set(file, [])` 再广播。广播回调 `broadcastBreakpoints` 读 `getCurrentBreakpoints()` 时，该文件可能已是空列表。最后 `this.breakpoints.clear()` 清空整个 map。

**影响**: 子进程可能收到不完整的断点同步数据。但最终状态正确（所有断点都被清除）。

**修复**: 先收集要广播的文件列表，再清空 map，最后统一广播空断点。
