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

## ~~Low~~ ✅ 已修复 — listBreakpoints 硬编码 verified: true

**修复**: breakpoints map 增加 `verified` 字段，`syncBreakpointsToFile` 同步后更新实际验证状态。

---

## ~~Low~~ ✅ 已修复 — clearBreakpoints 广播时数据可能过期

**修复**: 先对每个文件同步空断点到 DAP，再 `clear()` map，最后统一广播 `onBreakpointsChanged`。
