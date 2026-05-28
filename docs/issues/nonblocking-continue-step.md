# 待修复问题清单

> 来源：`continue`/`step` 非阻塞重构 (multi-session 分支) 的代码审查

## ~~Medium~~ ✅ 已修复 — bg event loop 与 waitForStop 竞争

**修复**: `continue`/`step` 在发 DAP 请求前先调 `stopBgEventLoop()`，让 bg loop 的 pending `waitForEvent` 自然超时退出，避免两者同时竞争同一个 stopped 事件。

---

## ~~Medium~~ ✅ 已修复 — bgStopReason 导致 step/continue 死锁

**修复**: 新增 `--force`/`-f` 标志（方案 C），可绕过 `bgStopReason` 守卫直接恢复执行。守卫错误消息更新为提示 `--force` 选项。

---

## ~~Low~~ ✅ 已修复 — step --wait into 参数顺序解析问题

**修复**: 改为先过滤 flags 再解析 positional args，`step --wait into` 现在正确解析为 kind=into, wait=true。

---

## Low — getStatusAsync 与 waitForStop 的 exception 获取逻辑不一致

**文件**: `src/debug-controller.ts:407` vs `src/debug-controller.ts:506`

**问题**: `getStatusAsync` 对 reason 为 `"breakpoint"` 或 `"step"` 时跳过 `fetchExceptionInfo()`。但 `waitForStop` 只跳过 `"breakpoint"`，不跳过 `"step"`。

**影响**: 无实际 bug — step 停止时没有 exception 可取，`fetchExceptionInfo` 返回 null。但逻辑不一致可能导致后续维护混乱。

**修复**: 统一两处逻辑，提取为 `isExceptionReason(reason)` helper。

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
