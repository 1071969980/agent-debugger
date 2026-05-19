"""
Test fixture: multiprocessing.Process subprocess debugging.

Spawns a child process via multiprocessing that processes a list.
Both parent and child have debuggable functions.
"""

import multiprocessing
import time


def child_task(items):
    """Child process: filters and counts items."""
    valid = [x for x in items if x > 0]  # line 14: breakpoint here
    count = len(valid)
    total = sum(valid)
    print(f"Child: {count} valid items, sum={total}")
    return total


def parent_task(items):
    """Parent process: processes the same list."""
    result = [x * 2 for x in items]  # line 24: breakpoint here
    print(f"Parent: doubled={result}")
    return result


def main():
    items = [-1, 5, -3, 8, 2, -7, 4]

    # Parent work
    parent_result = parent_task(items)

    # Spawn child process (use fork start method for debugpy subprocess detection)
    ctx = multiprocessing.get_context("fork")
    p = ctx.Process(target=child_task, args=(items,))
    p.start()
    p.join()


if __name__ == "__main__":
    main()
