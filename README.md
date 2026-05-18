# agent-debugger

CLI debugger for AI agents. Set breakpoints, inspect variables, evaluate expressions, and step through code — in Python, JavaScript, Go, Rust, C, and C++.

Built on the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP), the same protocol that powers VS Code's debugger. One CLI, multiple language backends.

## Install

```bash
npm install -g agent-debugger
```

Requires Node.js >= 18.

## Quick Start

### Debug a script

```bash
# Start a debug session, paused at line 25
agent-debugger start app.py --break app.py:25

# Inspect variables at the breakpoint
agent-debugger vars

# Evaluate any expression in the current scope
agent-debugger eval "type(data['age'])"

# Continue to the next breakpoint
agent-debugger continue

# Done
agent-debugger close
```

### Debug a running server

Attach to any running Python process by PID — no restart, no code changes:

```bash
# Find your server's PID
ps aux | grep uvicorn

# Attach and set breakpoints (auto-installs debugpy if needed)
agent-debugger attach --pid 12345 --break routes.py:42

# Trigger a request, then wait for the breakpoint
agent-debugger continue

# Inspect state
agent-debugger vars
agent-debugger eval "request.body"
agent-debugger close          # detaches without killing the server
```

## Commands

| Command | Description |
|---------|-------------|
| `start <script> [options]` | Start a debug session |
| `attach --pid <PID> [options]` | Attach to a running process by PID |
| `attach [host:]port [options]` | Attach to an existing debug server |
| `vars` | List local variables in the current frame |
| `eval <expression>` | Evaluate an expression in the current scope |
| `step [into\|out]` | Step over, into a function, or out of a function |
| `continue` | Resume execution / wait for next breakpoint |
| `stack` | Show the call stack |
| `break add <file:line[:cond]>` | Add a breakpoint mid-session |
| `break list` | List all breakpoints |
| `break rm <file:line>` | Remove a breakpoint |
| `break clear` | Clear all breakpoints |
| `source [file] [line]` | Show source code around the current line |
| `status` | Show session state and current location |
| `close` | Close the current debug session |
| `list` | List all active debug sessions |
| `shutdown` | Shut down the daemon |

### Session Targeting

Multiple debug sessions can run concurrently. Use `--session <id>` to target a specific session:

```bash
# Start two sessions
agent-debugger start app.py --break app.py:10     # returns session_id "a1b2c3d4"
agent-debugger start worker.py --break worker.py:5 # returns session_id "e5f6g7h8"

# List all active sessions
agent-debugger list

# Target a specific session
agent-debugger --session a1b2c3d4 vars
agent-debugger --session e5f6g7h8 step

# Close one session
agent-debugger --session a1b2c3d4 close
```

When only one session exists, it is targeted automatically. When multiple sessions exist, `--session` is required.

### Start Options

```bash
agent-debugger start <script> [options]

Options:
  --break, -b <file:line[:condition]>   Set a breakpoint (repeatable)
  --catch [filter]                      Pause on exceptions (repeatable, default: uncaught)
  --runtime <path>                      Path to language runtime (e.g. python, node)
  --stop-on-entry                       Pause on the first line
  --args <...>                          Arguments to pass to the script
```

### Attach Options

```bash
agent-debugger attach --pid <PID> [options]
agent-debugger attach [host:]port [options]

Options:
  --pid <PID>                           Attach to a running process by PID
  --break, -b <file:line[:condition]>   Set a breakpoint (repeatable)
  --catch [filter]                      Pause on exceptions (repeatable, default: uncaught)
  --runtime <path>                      Path to language runtime (optional, auto-detected)
  --language <name>                     Language adapter (default: python)
```

### Attaching to a Running Server

#### By PID (recommended — zero setup)

Debug any running Python process without restarting it or changing any code:

```bash
# Attach to a running uvicorn/flask/django/etc.
agent-debugger attach --pid $(pgrep -f uvicorn) --break routes.py:42

# Trigger a request, wait for the breakpoint hit
agent-debugger continue
agent-debugger vars
agent-debugger eval "request.body"
agent-debugger close
```

Under the hood, this uses lldb (macOS) or gdb (Linux) to inject debugpy directly into the running process. If debugpy isn't installed in the target environment, it auto-installs via pip.

#### By port (manual setup)

If you prefer to start your server with debugpy explicitly:

```bash
# Start server with debugpy listening
python -m debugpy --listen 5678 -m uvicorn app:main

# Attach
agent-debugger attach 5678 --break routes.py:42
agent-debugger continue
```

Or embed debugpy in your code:
```python
import debugpy
debugpy.listen(5678)
```

### Breakpoints

Multiple breakpoints and conditional breakpoints are supported:

```bash
# Multiple breakpoints at startup
agent-debugger start app.py --break app.py:25 --break app.py:40

# Conditional breakpoint — only pause when the condition is true
agent-debugger start app.py --break "app.py:30:i == 50"

# Manage breakpoints mid-session
agent-debugger break add app.py:60                 # add
agent-debugger break add "app.py:42:len(items) > 10"  # conditional
agent-debugger break list                           # list all
agent-debugger break rm app.py:60                   # remove one
agent-debugger break clear                          # remove all
```

### Exception Breakpoints

Pause automatically when an exception is thrown:

```bash
agent-debugger start app.py --catch              # uncaught exceptions (default)
agent-debugger start app.py --catch raised        # all exceptions, including caught ones
agent-debugger start app.py --break app.py:25 --catch   # combine with breakpoints
agent-debugger attach --pid 12345 --catch         # works with attach too
```

When an exception triggers, the session transitions to `paused` and the output includes the exception type and message:

```
Status: paused (ZeroDivisionError: division by zero)
  app.py:42 in process_data
```

The debugger monitors for exceptions in the background. Use `status` to check the current state at any time — it will show `paused` automatically when an exception hits, even if you haven't called `continue`.

Filter names are language-specific:

| Language | Filters |
|----------|---------|
| Python | `raised`, `uncaught`, `userUnhandled` |
| JavaScript | `all`, `uncaught` |
| Go | `all`, `uncaught` |
| Rust | `panic` |

## Supported Languages

| Language | Extensions | Debug Adapter | Setup |
|----------|------------|---------------|-------|
| Python | `.py` | [debugpy](https://github.com/microsoft/debugpy) | `pip install debugpy` |
| JavaScript | `.js`, `.mjs`, `.cjs` | @vscode/js-debug | VS Code installed, or `JS_DEBUG_PATH` env var |
| TypeScript | `.ts`, `.mts`, `.tsx` | @vscode/js-debug | Same as JavaScript |
| Go | `.go` | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust | `.rs` | CodeLLDB | `CODELLDB_PATH` env var |
| C/C++ | `.c`, `.cpp`, `.cc` | CodeLLDB | Same as Rust |

### Language-specific setup

**Python** — install debugpy in the environment you want to debug:
```bash
pip install debugpy

# Use a specific Python interpreter
agent-debugger start app.py --break app.py:10 --runtime /path/to/venv/bin/python
```

**JavaScript/TypeScript** — requires VS Code's js-debug extension, which ships with any VS Code install. The adapter auto-detects it from `~/.vscode/extensions/`. To use a custom location:
```bash
export JS_DEBUG_PATH=/path/to/ms-vscode.js-debug-x.x.x
```

**Go** — install Delve:
```bash
go install github.com/go-delve/delve/cmd/dlv@latest
```

**Rust/C/C++** — set the path to the CodeLLDB adapter binary:
```bash
export CODELLDB_PATH=/path/to/codelldb/adapter/codelldb
```

## How It Works

**Launch mode** (`start`) — the daemon spawns the debug adapter:
```
CLI (stateless)  ──unix socket──▶  Daemon (session state)  ──TCP/DAP──▶  Debug Adapter
                                                                          (debugpy, dlv, etc.)
```

**Attach by PID** (`attach --pid`) — injects debugpy into a running process:
```
CLI  ──unix socket──▶  Daemon  ──lldb/gdb──▶  Target Process
                                               (injects debugpy.listen())
                         │
                         └──────────TCP/DAP──▶  debugpy adapter
                                                (spawned by debugpy.listen)
```

**Attach by port** (`attach port`) — connects to an existing debug server:
```
CLI  ──unix socket──▶  Daemon  ──TCP/DAP──▶  Your Server
                                              (with debugpy listening)
```

- **CLI** (`agent-debugger`): Stateless client. Parses arguments, sends JSON commands over a Unix socket, prints results.
- **Daemon**: Background process that manages the debug session. Spawns, injects, or connects to a debug adapter via DAP, and translates CLI commands into DAP requests.
- **Debug Adapter**: Language-specific process (debugpy, Delve, js-debug, CodeLLDB) that implements the Debug Adapter Protocol.

The daemon starts automatically on the first command. Multiple debug sessions can run concurrently. Use `agent-debugger shutdown` to stop the daemon.