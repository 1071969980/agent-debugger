# debugpy Exception Filter 名拼错：调查与修复报告

## 背景

用户报告 `--catch userUncaught` 在 FastAPI 路由处理器中不生效，而 VS Code 的 "User Uncaught Exceptions" 能正常捕获。

## 现象

- `--catch raised` 可以在 FastAPI 路由异常处暂停
- `--catch userUncaught` 不能暂停
- VS Code 等效功能正常工作

## 调查过程

1. **最初假设**：缺少 DAP capability（`supportsExceptionFilterOptions`），认为 debugpy 需要客户端声明支持该能力才会在 `setExceptionBreakpoints` 中处理 `userUncaught` filter。

2. **添加诊断日志**：在 `src/adapters/python.ts` 的 `initFlow` 和 `attachFlow` 中添加日志，记录 debugpy 的 `initialize` 响应体，直接观察适配器报告的能力和 filter 列表。

3. **发现 debugpy 报告的 `exceptionBreakpointFilters`**：

   | filter 名 | 描述 |
   |-----------|------|
   | `raised` | Raised Exceptions |
   | `uncaught` | Uncaught Exceptions |
   | `userUnhandled` | User Uncaught Exceptions |

   注意：debugpy 注册的 filter 名是 **`userUnhandled`**，不是 `userUncaught`。

4. **验证**：使用正确的 filter 名 `userUnhandled` 测试，成功在 FastAPI 路由异常处暂停。

5. **消融实验**：去掉 `supportsExceptionFilterOptions` capability 后，`userUnhandled` 仍然正常工作。这说明 capability 声明并非根因，问题纯粹是 filter 名拼写错误。

## 根因

**filter 名拼写错误**：代码和文档中使用 `userUncaught`，但 debugpy DAP 适配器实际注册的 filter 名是 `userUnhandled`。

DAP 的 `setExceptionBreakpoints` 请求对不认识的 filter 名不会报错，只是静默忽略，导致问题难以发现。

```
客户端发送:  setExceptionBreakpoints({ filters: ["userUncaught"] })
debugpy 行为: 在已注册的 filters 中查找 "userUncaught" → 未找到 → 静默忽略
结果: 异常断点不生效，无任何错误提示
```

## 修复

所有 `userUncaught` 替换为 `userUnhandled`，涉及三个文件：

- **`src/cli.ts`**（HELP 文本）— CLI 帮助信息中的 filter 列表
- **`README.md`**（filter 表）— 文档中的 Python filter 名称
- **`skills/agent-debugger/SKILL.md`**（filter 列表）— Skill 文档中的 exception filter 列表

## 经验教训

1. **不要假设 API 名称**：DAP filter 名是适配器定义的，应该通过 `initialize` 响应的 `exceptionBreakpointFilters` 字段获取，而不是猜测。debugpy 用的是 `userUnhandled`（Unhandled），VS Code UI 显示的是 "User Uncaught Exceptions"，两者措辞不同但语义相同，直接从 UI 文案反推 filter 名是不可靠的。

2. **静默失败是危险的**：DAP 对未知 filter 名不报错，这种"宽容"反而增加了调试难度。如果 `setExceptionBreakpoints` 对未知 filter 返回错误，这个问题在第一次使用时就能被发现。

3. **消融实验很重要**：同时修改多个假设（添加 capability + 修正 filter 名）时，必须逐个验证才能确定真正的根因。在本次调查中，capability 假设是一个红鲱鱼，只有去掉它单独测试才能确认 filter 名才是唯一的问题。

4. **debugpy 的 initialize 响应是最可靠的信息源**：`exceptionBreakpointFilters` 数组包含所有支持的 filter 及其描述，直接检查这个数组比查阅文档或猜测都要可靠。

## 建议

- **Filter 名校验**：可以考虑在 attach/init 流程中读取 `exceptionBreakpointFilters` 并在 CLI 层做 filter 名校验，当用户传入的 filter 不在支持列表中时立即报错，避免静默失败。

- **缓存与补全**：可以考虑在 initialize 响应中缓存支持的 filters，用于 tab 补全或错误提示，提升用户体验并防止类似的拼写错误。
