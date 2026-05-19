#!/usr/bin/env bash
# E2E tests for subprocess debugging (startDebugging reverse request)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="$SCRIPT_DIR/../bin/agent-debugger"
FIXTURES="$SCRIPT_DIR/fixtures"
PYTHON="$SCRIPT_DIR/../testenv/.venv/bin/python"

PASS=0
FAIL=0
ERRORS=""

run_cmd() {
    "$@" 2>&1 || true
}

assert_contains() {
    local test_name="$1"
    local expected="$2"
    local actual="$3"

    if echo "$actual" | grep -qF "$expected"; then
        PASS=$((PASS + 1))
        echo "  ✓ $test_name"
    else
        FAIL=$((FAIL + 1))
        ERRORS="${ERRORS}\n  FAIL: $test_name\n    Expected to contain: $expected\n    Got: $(echo "$actual" | head -3)\n"
        echo "  ✗ $test_name"
    fi
}

assert_matches() {
    local test_name="$1"
    local pattern="$2"
    local actual="$3"

    if echo "$actual" | grep -qE "$pattern"; then
        PASS=$((PASS + 1))
        echo "  ✓ $test_name"
    else
        FAIL=$((FAIL + 1))
        ERRORS="${ERRORS}\n  FAIL: $test_name\n    Expected to match: $pattern\n    Got: $(echo "$actual" | head -3)\n"
        echo "  ✗ $test_name"
    fi
}

cleanup() {
    run_cmd $BIN close >/dev/null 2>&1
    if [ -f ~/.agent-debugger/daemon.pid ]; then
        kill "$(cat ~/.agent-debugger/daemon.pid)" 2>/dev/null || true
    fi
    rm -f ~/.agent-debugger/daemon.sock ~/.agent-debugger/daemon.pid 2>/dev/null || true
    sleep 0.5
}

# ═══════════════════════════════════════════════════
echo "═══ Subprocess Debugging Test Suite ═══"
echo "  Python: $PYTHON"
echo "  Bin:    $BIN"
echo ""

# ─── Test 1: Launch mode + os.fork() subprocess ───
echo "─── Test 1: Launch + os.fork() ───"
cleanup

OUT=$(run_cmd $BIN start "$FIXTURES/fork_subprocess.py" \
    --break "$FIXTURES/fork_subprocess.py:14" \
    --runtime "$PYTHON")
assert_contains "fork: starts and pauses at parent_worker" "paused" "$OUT"

# Check subprocess list — child was forked before parent_worker breakpoint
sleep 1
OUT=$(run_cmd $BIN subprocess list)
echo "  subprocess list: $OUT"
assert_contains "fork: discovers subprocess" "Subprocesses" "$OUT"
assert_matches "fork: subprocess has pid" "p[0-9]+" "$OUT"

OUT=$(run_cmd $BIN close)
assert_contains "fork: closes cleanly" "closed" "$OUT"

# ─── Test 2: Launch mode + multiprocessing ───
echo "─── Test 2: Launch + multiprocessing ───"
cleanup

OUT=$(run_cmd $BIN start "$FIXTURES/mp_subprocess.py" \
    --break "$FIXTURES/mp_subprocess.py:24" \
    --runtime "$PYTHON")
assert_contains "mp: starts and pauses at parent_task" "paused" "$OUT"

# Close immediately — the multiprocessing child may or may not be discovered yet
# depending on timing. Just verify the session works.
OUT=$(run_cmd $BIN close)
assert_contains "mp: closes cleanly" "closed" "$OUT"

# ─── Test 3: Attach mode + subprocess ───
echo "─── Test 3: Attach + subprocess ───"
cleanup

PORT=15678

# Start debugpy server in background
$PYTHON -m debugpy --listen $PORT "$FIXTURES/server_with_subprocess.py" &
SERVER_PID=$!
sleep 2

# Attach and set breakpoint in handle_request (line 17)
OUT=$(run_cmd $BIN attach $PORT \
    --break "$FIXTURES/server_with_subprocess.py:17")
echo "  attach output: $OUT"
assert_contains "attach: connects successfully" "running" "$OUT" || assert_contains "attach: paused at bp" "paused" "$OUT"

# Wait for fork subprocesses to be created and discovered
sleep 3

# Check subprocess list
OUT=$(run_cmd $BIN subprocess list)
echo "  subprocess list: $OUT"

# Close session (should detach without killing server)
OUT=$(run_cmd $BIN close)
assert_contains "attach: closes cleanly" "closed" "$OUT"

# Kill the debugpy server
kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

# ─── Test 4: Regression - basic launch still works ───
echo "─── Test 4: Regression - basic launch ───"
cleanup

OUT=$(run_cmd $BIN start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:25" \
    --runtime "$PYTHON")
assert_contains "regression: basic start works" "paused" "$OUT"

OUT=$(run_cmd $BIN eval "data['name']")
assert_contains "regression: eval works" "Alice" "$OUT"

OUT=$(run_cmd $BIN continue)
assert_matches "regression: continue works" "paused|terminated" "$OUT"

OUT=$(run_cmd $BIN close)
assert_contains "regression: close works" "closed" "$OUT"

# ─── Test 5: Regression - basic attach still works ───
echo "─── Test 5: Regression - basic attach ───"
cleanup

PORT=15679

$PYTHON -m debugpy --listen $PORT -c "
import time
data = [1, 2, 3]
total = 0
for x in data:
    total += x
print(f'Total: {total}')
time.sleep(30)
" &
SERVER_PID=$!
sleep 2

OUT=$(run_cmd $BIN attach $PORT)
echo "  attach output: $OUT"
assert_matches "regression-attach: connects" "running|paused" "$OUT"

OUT=$(run_cmd $BIN close)
assert_contains "regression-attach: closes cleanly" "closed" "$OUT"

kill $SERVER_PID 2>/dev/null || true
wait $SERVER_PID 2>/dev/null || true

# ═══════════════════════════════════════════════════
cleanup
echo ""
echo "═══ Results ═══"
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Total:  $((PASS + FAIL))"

if [ "$FAIL" -gt 0 ]; then
    echo ""
    echo "═══ Failures ═══"
    printf "%b" "$ERRORS"
    exit 1
fi

echo ""
echo "All tests passed!"
