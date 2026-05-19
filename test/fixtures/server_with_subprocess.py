"""
Test fixture: long-running server that forks subprocesses.

Used for attach mode testing. Runs in a loop and forks child processes
to handle "requests". Runs for ~30 seconds to give enough time to attach.
"""

import os
import time


def handle_request(req_id):
    """Child process: handles a single request."""
    data = req_id * 10  # line 16: breakpoint here
    result = data + 42
    print(f"Request {req_id}: result={result}")
    return result


def main():
    print(f"Server started (pid={os.getpid()})", flush=True)

    for i in range(100):
        pid = os.fork()
        if pid == 0:
            # Child: handle request and exit
            handle_request(i)
            os._exit(0)
        else:
            # Parent: wait for child, then loop
            os.waitpid(pid, 0)
            time.sleep(0.3)

    print("Server done")


if __name__ == "__main__":
    main()
