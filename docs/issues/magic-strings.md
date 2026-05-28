# Magic Strings 审计报告

> 来源：`continue`/`step` 非阻塞重构期间的代码审查

## 概述

项目在 `protocol.ts` 中用 Zod schema 定义了命令结构和类型约束（如 `SessionState` 类型、`BreakCommand` 的 `sub` enum），这很好。但运行时使用的字符串字面量大量散落在各文件中，未集中定义为常量。

## 已做得好的部分

| 类别 | 做法 | 位置 |
|------|------|------|
| Session State | `type SessionState = "idle" \| "starting" \| ...` | `session.ts:13` |
| Break Subcommand | `sub: z.enum(["add", "list", "rm", "clear"])` | `protocol.ts:55` |
| Command Action | 各 `z.literal("start")` 等 | `protocol.ts:17-77` |

## 需要改进的部分

### 1. ~~Stop Reason — 无集中定义~~ ✅ 已修复

**修复**: 在 `protocol.ts` 中定义 `STOP_REASON` 常量对象和 `isExceptionReason()` helper，`debug-controller.ts` 和 `session.ts` 全部使用常量引用。

### 2. Adapter/Language 名称 — 无集中定义 (中优先级)

散落在 `adapters/registry.ts` 和各 adapter 文件中，约 18 处。

| 字符串 | 使用位置 |
|--------|---------|
| `"python"` | adapters/python.ts (name 属性), registry.ts (getAdapter), session.ts (attach 默认值) |
| `"node"` | adapters/node.ts, registry.ts |
| `"go"` | adapters/go.ts, registry.ts |
| `"rust"` | adapters/rust.ts, registry.ts |

**修复方向**: 在 `adapters/base.ts` 定义：

```typescript
export const LANGUAGE = {
  PYTHON: "python",
  NODE: "node",
  GO: "go",
  RUST: "rust",
} as const;
```

### 3. DAP 请求方法名 — 仅 z.literal，运行时散落 (中优先级)

各 adapter 和 debug-controller 中通过 `client.request("methodName", ...)` 发送 DAP 请求，方法名全是裸字符串，约 49 处。

高频方法：

| 字符串 | 使用次数 | 文件 |
|--------|---------|------|
| `"initialize"` | 7 | 各 adapter 的 initFlow |
| `"setBreakpoints"` | 8 | 各 adapter + debug-controller |
| `"setExceptionBreakpoints"` | 7 | 各 adapter |
| `"configurationDone"` | 7 | 各 adapter |
| `"stackTrace"` | 3 | debug-controller |
| `"launch"` / `"attach"` | 各 4 | 各 adapter |
| `"continue"` | 1 | debug-controller |
| `"next"` / `"stepIn"` / `"stepOut"` | 各 1 | debug-controller |
| `"evaluate"` | 1 | debug-controller |
| `"scopes"` | 1 | debug-controller |
| `"variables"` | 1 | debug-controller |
| `"disconnect"` | 1 | dap-client |

**修复方向**: 在 `dap-client.ts` 或新建 `dap-protocol.ts` 定义常量：

```typescript
export const DAP = {
  INITIALIZE: "initialize",
  LAUNCH: "launch",
  ATTACH: "attach",
  SET_BREAKPOINTS: "setBreakpoints",
  // ...
} as const;
```

### 4. Scope 名称 — 无定义 (低优先级)

`debug-controller.ts` 中硬编码：

```typescript
if (scope.name !== "Locals" && scope.name !== "Local") continue;
```

不同 DAP adapter 返回的 scope 名称不一致（debugpy 用 `"Locals"`，其他可能用 `"Local"`），应集中定义。

### 5. CLI 命令名 — 散落在 HELP 文本和 switch/case 中 (低优先级)

`cli.ts` 的 switch/case 使用裸字符串 `"start"`, `"attach"`, `"continue"`, `"step"` 等。HELP 文本中也硬编码了所有命令名。改动命令名时需要同步多处。

**影响**: CLI 命令名变更频率极低，实际风险小。不急于修复。

## 修复优先级建议

1. **Stop Reason** — 影响正确性（判断逻辑不一致），且改动范围小（1 个文件内）
2. **Adapter 名称** — 改动范围小，4 个常量
3. **DAP 方法名** — 改动范围大（49 处），收益是减少拼写错误风险
4. **Scope 名称** — 2 处，最低优先级
