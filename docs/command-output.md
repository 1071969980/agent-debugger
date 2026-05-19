# Command Output Reference

Every `agent-debugger` command's exact output format, traced from daemon through CLI formatting.

## `start <script>`

Hit breakpoint:
```
Session ID: a1b2c3d4
Status: paused (breakpoint)
  /path/to/app.py:25 in process_data
  Breakpoint: /path/to/app.py:25 (verified)
```

Hit exception (`--catch`):
```
Session ID: a1b2c3d4
Status: paused (exception: ValueError)
Exception: ValueError: invalid literal for int() with base 10: 'abc'
  File "/path/to/app.py", line 42, in process_data
    x = int(data['age'])
  /path/to/app.py:42 in process_data
  Breakpoint: /path/to/app.py:25 (verified)
```

Program terminates immediately:
```
Session ID: a1b2c3d4
Status: terminated (exit code: 0)
```

Error:
```
Error: Unsupported file type: /path/to/app.xyz. Supported: .py, .js, .ts, .go, .rs, .c, .cpp
Error: Failed to start debug adapter: ...
Error: Session already active. Run 'agent-debugger close' first.
```

## `attach`

Attach by PID:
```
Session ID: e5f6g7h8
Attached. Program is running.
  Breakpoint: /path/to/routes.py:42 (verified)
  Background monitoring active. Check state with 'agent-debugger status'.
```

Attach by port:
```
Session ID: e5f6g7h8
Attached. Program is running.
  Breakpoint: /path/to/routes.py:42 (verified)
  Background monitoring active. Check state with 'agent-debugger status'.
```

Error:
```
Error: PID 12345 already has an active session (a1b2c3d4)
Error: Failed to inject into PID 12345: ...
Error: Failed to connect to 127.0.0.1:5678: ...
Error: Attach not supported for go
Error: PID injection not supported for javascript
```

## `vars`

With variables:
```
  at /path/to/app.py:25 in process_data
  data = {'name': 'Alice', 'age': '35'} (dict)
  total = 55 (int)
  items = [1, 2, 3] (list)
```

No locals:
```
  (no local variables)
```

Error:
```
Error: Not paused
Error: No frame available
Error: No active debug session
```

## `eval <expression>`

Success:
```
  35 (int)
```

Without type info:
```
  {'name': 'Alice'}
```

Evaluation error:
```
Error: name 'undefined_var' is not defined
```

Error:
```
Error: Not paused
Error: No expression provided
```

## `step [into|out]`

Paused at next line:
```
Status: paused (breakpoint)
  /path/to/app.py:26 in process_data
```

Paused by exception during step:
```
Status: paused (exception: ValueError)
Exception: ValueError: invalid literal for int()
  File "/path/to/app.py", line 42, in process_data
    x = int(data['age'])
  /path/to/app.py:42 in process_data
```

Program terminated during step:
```
Status: terminated (exit code: 0)
```

Error:
```
Error: Not paused
Error: No thread
Error: Paused by a background event. Run 'status' to inspect before stepping.
```

## `continue`

Resumes execution and blocks until the next stop (breakpoint, exception, or termination).

Paused at next breakpoint:
```
Status: paused (breakpoint)
  /path/to/app.py:40 in handle_result
```

Paused by exception:
```
Status: paused (exception: ZeroDivisionError)
Exception: ZeroDivisionError: division by zero
  File "/path/to/app.py", line 55, in calculate
    result = x / y
  /path/to/app.py:55 in calculate
```

Program terminated:
```
Status: terminated (exit code: 1)
```

Waiting for hit (already running):
```
Status: paused (breakpoint)
  /path/to/app.py:40 in handle_result
```

Error:
```
Error: Not paused
Error: No thread
Error: Paused by a background event. Run 'status' to inspect before continuing.
```

## `stack`

```
  → process_data at /path/to/app.py:25
    main at /path/to/app.py:10
    <module> at /path/to/app.py:50
```

Empty:
```
  (empty stack)
```

## `break add <file:line[:cond]>`

Verified:
```
  Breakpoint: /path/to/app.py:60 (verified)
```

With condition:
```
  Breakpoint: /path/to/app.py:42 (verified)  condition: i == 50
```

Pending:
```
  Breakpoint: /path/to/app.py:999 (pending)
```

Error:
```
Error: Breakpoint already exists at /path/to/app.py:25
Error: Failed to set breakpoint
```

## `break list`

With breakpoints:
```
  Breakpoints (3):
    /path/to/app.py:25 (verified)
    /path/to/app.py:40 (verified)  condition: len(items) > 10
    /path/to/utils.py:10 (verified)
```

None:
```
  No breakpoints.
```

## `break rm <file:line>`

```
  Removed breakpoint: /path/to/app.py:60
```

Error:
```
Error: No breakpoints in /path/to/app.py
Error: No breakpoint at /path/to/app.py:999
```

## `break clear`

```
  Cleared 3 breakpoint(s).
```

## `source [file] [line]`

```
      1 │ import json
      2 │
      3 │ def process_data(data):
  →   4 │     total = 0
      5 │     for item in data:
      6 │         total += item['value']
      7 │     return total
      8 │
      9 │ result = process_data([{'value': 10}])
```

## `status`

Paused at breakpoint:
```
State: paused
  /path/to/app.py:25 in process_data
```

Paused by background event (exception):
```
Status: paused (ValueError: invalid literal for int() with base 10: 'abc')
Exception: ValueError: invalid literal for int() with base 10: 'abc'
  File "/path/to/app.py", line 42, in process_data
    x = int(data['age'])
  /path/to/app.py:42 in process_data
```

Running:
```
State: running
```

Terminated:
```
State: terminated
```

## `close`

```
Session closed.
```

## `list`

With sessions:
```
  a1b2c3d4  state: paused  script: /path/to/app.py
  e5f6g7h8  state: running  script: /path/to/worker.py
```

With subprocesses:
```
  a1b2c3d4  state: paused  script: /path/to/app.py  (2 subprocesses)
    a1b2c3d4/p100  state: running
    a1b2c3d4/p101  state: paused
```

None:
```
  No active sessions.
```

## `subprocess list`

With subprocesses:
```
  Subprocesses (2):
    p100  state: running
    p101  state: paused
```

None:
```
  No subprocesses.
```

## `shutdown`

```
Daemon shut down.
```
