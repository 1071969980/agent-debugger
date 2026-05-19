# Subprocess Debugging — Resolved Issues

All 7 issues identified during code review have been fixed and verified (14/14 E2E tests pass).

## 1. 资源泄漏 — `handleStartDebugging` 错误路径 ✅

`handleStartDebugging` 和 `handleSubprocessEvent` 现在用 `handedOff` + `finally` 模式确保连接在错误路径上被关闭。

## 2. 子进程事件处理逻辑重复 ✅

`session.ts` 的 `handleSubprocessEvents()` 委托给 `adapter.drainSubprocessEvents()`，消除了 ~30 行重复代码和 `as any` 强转。

## 3. 类型安全 — `as any` ✅

在 `AdapterConfig` 接口上添加了 `drainSubprocessEvents?` 可选方法和 `SubprocessDrainOpts` 类型。

## 4. 重复子进程风险 ✅

`registerSubprocess()` 基于 PID 做去重检查。

## 5. 暂停状态下子进程不会被发现 ✅

`bgExtraHandler` 在会话创建时绑定（构造函数 opts），在 bg loop 和 `waitForStop` 中均可调用。

## 6. 断点不会传播给子进程 ✅

`onBreakpointsChanged` 回调 + `broadcastBreakpoints()` 实现父→子断点同步。

## 7. `reverseRequestQueue` 无界增长 ✅

`disconnect()` finally 块中清空 `eventQueue` 和 `reverseRequestQueue`。

---

## 后续修复

代码审查还发现两个额外问题并已修复：

- **`waitForStop` 清除 `bgExtraHandler`** — `stopBgEventLoop()` 不再清除 handler（handler 是会话级别的）
- **`step`/`continue` 中冗余 bg loop** — 移除了 `startBgEventLoop()` 调用，`waitForStop` 直接轮询
