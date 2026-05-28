"""
Test fixture for verifying attach --port reconnect with fork subprocesses.
Runs indefinitely — kill with Ctrl+C or `kill <pid>`.
"""
import debugpy
import multiprocessing
import os
import time


def worker(name):
    """Child process: heartbeats forever."""
    i = 0
    while True:
        print(f"[{name}] pid={os.getpid()} tick {i}", flush=True)
        time.sleep(2)
        i += 1


def main():
    print(f"PARENT pid={os.getpid()}", flush=True)

    debugpy.listen(("127.0.0.1", 8787))
    print("debugpy listening on :8787", flush=True)

    # Fork 3 child processes
    ctx = multiprocessing.get_context("fork")
    children = []
    for i in range(3):
        p = ctx.Process(target=worker, args=(f"child-{i}",), daemon=True)
        p.start()
        children.append(p)
        print(f"Forked child-{i} pid={p.pid}", flush=True)

    # Keep parent alive forever
    i = 0
    while True:
        alive = sum(1 for c in children if c.is_alive())
        print(f"[parent] tick {i} alive={alive}/{len(children)}", flush=True)
        if alive == 0:
            print("[parent] all children dead, exiting", flush=True)
            break
        time.sleep(3)
        i += 1


if __name__ == "__main__":
    main()
