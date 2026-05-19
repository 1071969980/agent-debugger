"""
Test fixture: os.fork() subprocess debugging.

Parent process computes a sum, forks a child that computes a product.
Both have breakpoints set in their respective worker functions.
"""

import os
import time


def parent_worker(data):
    """Parent computes sum of values."""
    total = 0
    for item in data:
        total += item["value"]  # line 14: breakpoint here
    return total


def child_worker(data):
    """Child computes product of values."""
    product = 1
    for item in data:
        product *= item["value"]  # line 22: breakpoint here
    return product


def main():
    data = [
        {"name": "alpha", "value": 2},
        {"name": "beta", "value": 3},
        {"name": "gamma", "value": 5},
    ]

    pid = os.fork()

    if pid == 0:
        # Child process
        result = child_worker(data)
        print(f"Child product: {result}")
        os._exit(0)
    else:
        # Parent process
        result = parent_worker(data)
        print(f"Parent sum: {result}")
        os.waitpid(pid, 0)


if __name__ == "__main__":
    main()
