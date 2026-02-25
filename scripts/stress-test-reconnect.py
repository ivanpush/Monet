#!/usr/bin/env python3
"""
stress-test-reconnect.py - Stress test for Monet PID-based session reconnection

Hammers the reconnection logic by repeatedly killing the extension host
and verifying sessions reconnect correctly.

A PASS is when:
  - processId exists in status file
  - is_pid_alive(processId) returns True

A FAIL is when:
  - processId is missing from status file
  - processId exists but process is dead

WARNING: This script will kill the Cursor extension host process multiple times!
All your terminals and extensions will restart each iteration.

Created: 2026-02-24
Updated: 2026-02-24
"""

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

# Colors
RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
CYAN = '\033[0;36m'
BOLD = '\033[1m'
DIM = '\033[2m'
NC = '\033[0m'

STATUS_DIR = Path.home() / '.monet' / 'status'
CURSOR_LOGS_DIR = Path.home() / 'Library' / 'Application Support' / 'Cursor' / 'logs'


class Logger:
    def __init__(self, log_path: Path):
        self.log_path = log_path
        self.log_file = open(log_path, 'a')

    def log(self, msg: str):
        timestamp = datetime.now().strftime('%H:%M:%S')
        line = f"[{timestamp}] {msg}"
        print(line)
        # Strip ANSI codes for file
        clean = line
        for code in [RED, GREEN, YELLOW, CYAN, BOLD, DIM, NC]:
            clean = clean.replace(code, '')
        self.log_file.write(clean + '\n')
        self.log_file.flush()

    def log_pass(self, msg: str):
        self.log(f"{GREEN}PASS{NC}: {msg}")

    def log_fail(self, msg: str):
        self.log(f"{RED}FAIL{NC}: {msg}")

    def log_warn(self, msg: str):
        self.log(f"{YELLOW}WARN{NC}: {msg}")

    def log_info(self, msg: str):
        self.log(f"{CYAN}INFO{NC}: {msg}")

    def close(self):
        self.log_file.close()


def is_pid_alive(pid: int) -> bool:
    """Check if a specific PID is running."""
    if pid is None:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def load_session_file(filepath: Path) -> dict | None:
    """Load and parse a session JSON file."""
    try:
        with open(filepath, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return None


def get_sessions() -> dict:
    """Get all sessions from status directory. Returns {session_id: data}"""
    sessions = {}
    if not STATUS_DIR.exists():
        return sessions

    for filepath in STATUS_DIR.glob('[a-f0-9]' * 8 + '.json'):
        data = load_session_file(filepath)
        if data:
            sessions[filepath.stem] = data
    return sessions


def get_extension_host_pids() -> list[int]:
    """Get all current extensionHost process PIDs."""
    try:
        result = subprocess.run(
            ['pgrep', '-f', 'extensionHost'],
            capture_output=True,
            text=True
        )
        if result.returncode == 0:
            return [int(pid) for pid in result.stdout.strip().split('\n') if pid]
        return []
    except Exception:
        return []


def kill_extension_host() -> bool:
    """Kill all Cursor extension host processes."""
    try:
        subprocess.run(['pkill', '-f', 'extensionHost'], capture_output=True)
        return True
    except Exception:
        return False


def wait_for_extension_hosts_to_die(max_wait: int = 30) -> bool:
    """Wait for ALL extensionHost processes to die."""
    for _ in range(max_wait):
        pids = get_extension_host_pids()
        if not pids:
            return True
        time.sleep(0.5)
    return False


def wait_for_extension_host_restart(max_wait: int = 60) -> bool:
    """Wait for extension host to restart (at least one process)."""
    for _ in range(max_wait):
        pids = get_extension_host_pids()
        if pids:
            return True
        time.sleep(0.5)
    return False


def find_latest_cursor_log() -> Optional[Path]:
    """Find the most recent Cursor log file."""
    if not CURSOR_LOGS_DIR.exists():
        return None

    # Look for exthost logs in date-based folders
    log_patterns = [
        str(CURSOR_LOGS_DIR / '*' / 'exthost*' / '*.log'),
        str(CURSOR_LOGS_DIR / '*' / 'window*' / '*.log'),
        str(CURSOR_LOGS_DIR / '*' / 'renderer*.log'),
    ]

    all_logs = []
    for pattern in log_patterns:
        all_logs.extend(glob.glob(pattern))

    if not all_logs:
        return None

    # Sort by modification time, newest first
    all_logs.sort(key=lambda x: os.path.getmtime(x), reverse=True)
    return Path(all_logs[0]) if all_logs else None


def check_reconnect_logs(since_time: float) -> tuple[bool, int]:
    """
    Check Cursor logs for "Monet: Reconnected session" messages since given time.
    Returns (found, count).
    """
    if not CURSOR_LOGS_DIR.exists():
        return False, 0

    # Find all log files modified after since_time
    log_patterns = [
        str(CURSOR_LOGS_DIR / '*' / 'exthost*' / '*.log'),
        str(CURSOR_LOGS_DIR / '*' / 'window*' / '*.log'),
    ]

    reconnect_count = 0
    pattern = re.compile(r'Monet:.*[Rr]econnect', re.IGNORECASE)

    for log_pattern in log_patterns:
        for log_file in glob.glob(log_pattern):
            try:
                # Only check files modified since we started
                if os.path.getmtime(log_file) < since_time:
                    continue

                with open(log_file, 'r', errors='ignore') as f:
                    content = f.read()
                    matches = pattern.findall(content)
                    reconnect_count += len(matches)
            except (IOError, OSError):
                continue

    return reconnect_count > 0, reconnect_count


def main():
    parser = argparse.ArgumentParser(
        description='Stress test Monet session reconnection',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s              # Run 100 iterations with standard timing
  %(prog)s 50           # Run 50 iterations
  %(prog)s --fast       # Run faster (5s wait instead of 8s, no inter-iteration pause)
  %(prog)s 200 --fast   # Run 200 fast iterations
        """
    )
    parser.add_argument('iterations', type=int, nargs='?', default=100,
                        help='Number of iterations (default: 100)')
    parser.add_argument('--fast', action='store_true',
                        help='Fast mode: 5s wait instead of 8s, no pause between iterations')
    parser.add_argument('--yes', '-y', action='store_true',
                        help='Skip confirmation prompt')
    args = parser.parse_args()

    iterations = args.iterations
    monet_wait = 5 if args.fast else 8
    inter_iteration_pause = 0 if args.fast else 1

    log_path = Path(f"/tmp/monet-stress-test-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log")
    logger = Logger(log_path)

    print()
    print("═══════════════════════════════════════════════════════════════")
    print("  MONET SESSION RECONNECTION STRESS TEST")
    print("═══════════════════════════════════════════════════════════════")
    print()
    print(f"  Iterations:          {iterations}")
    print(f"  Mode:                {'FAST' if args.fast else 'STANDARD'}")
    print(f"  Monet wait:          {monet_wait}s after extension host restarts")
    print(f"  Inter-iter pause:    {inter_iteration_pause}s")
    print(f"  Log file:            {log_path}")
    print()
    print(f"{RED}{BOLD}WARNING: This will kill the Cursor extension host {iterations} times!{NC}")
    print("All terminals and extensions will restart each iteration.")
    print()

    if not args.yes:
        confirm = input("Are you sure you want to continue? (yes/no): ")
        if confirm.lower() != 'yes':
            print("Aborted.")
            sys.exit(0)

    logger.log("")
    logger.log("═══════════════════════════════════════════════════════════════")
    logger.log(f"  STRESS TEST STARTED: {datetime.now()}")
    logger.log(f"  Mode: {'FAST' if args.fast else 'STANDARD'}")
    logger.log("═══════════════════════════════════════════════════════════════")

    # Pre-flight check
    logger.log("")
    logger.log("─────────────────────────────────────────────────────────────────")
    logger.log("PRE-FLIGHT CHECK")
    logger.log("─────────────────────────────────────────────────────────────────")

    if not STATUS_DIR.exists():
        logger.log_fail(f"Status directory does not exist: {STATUS_DIR}")
        sys.exit(1)

    initial_sessions = get_sessions()
    if not initial_sessions:
        logger.log_fail("No sessions found. Please create at least 1 Monet session first.")
        print()
        print("To create sessions:")
        print("  1. Open Cursor")
        print("  2. Use the paintcan button in terminal toolbar")
        print("  3. Select 'New Session'")
        print("  4. Repeat for different projects")
        sys.exit(1)

    logger.log(f"Found {len(initial_sessions)} session(s):")
    missing_pids = 0
    dead_pids = 0
    for sid, data in initial_sessions.items():
        pid = data.get('processId')
        if not pid:
            logger.log(f"  - {sid}: {RED}NO PID{NC}")
            missing_pids += 1
        elif not is_pid_alive(pid):
            logger.log(f"  - {sid}: PID {pid} {RED}(DEAD){NC}")
            dead_pids += 1
        else:
            logger.log(f"  - {sid}: PID {pid} {GREEN}(alive){NC}")

    if missing_pids > 0:
        logger.log_warn(f"{missing_pids} session(s) missing PIDs before test")
    if dead_pids > 0:
        logger.log_warn(f"{dead_pids} session(s) have dead PIDs before test")

    # Check logs directory
    if not CURSOR_LOGS_DIR.exists():
        logger.log_warn(f"Cursor logs directory not found: {CURSOR_LOGS_DIR}")
        logger.log_warn("Log verification will be skipped")

    logger.log("")
    logger.log("Starting stress test in 3 seconds...")
    time.sleep(3)

    # Main test loop
    total_pass = 0
    total_fail = 0
    reconnect_times = []
    session_failures: dict[str, int] = {}  # session_id -> failure count

    for i in range(1, iterations + 1):
        logger.log("")
        logger.log("═══════════════════════════════════════════════════════════════")
        logger.log(f"ITERATION {i} of {iterations}")
        logger.log("═══════════════════════════════════════════════════════════════")

        iteration_pass = True
        failures = []
        iteration_start = time.time()

        # Step 1: Record current sessions
        logger.log("Step 1: Recording current sessions...")
        before_sessions = get_sessions()

        for sid, data in before_sessions.items():
            pid = data.get('processId')
            alive_str = f"{GREEN}alive{NC}" if is_pid_alive(pid) else f"{RED}dead{NC}"
            logger.log(f"  - {sid}: PID {pid} ({alive_str})")

        # Step 2: Kill extension host
        logger.log("Step 2: Killing extension host...")
        kill_time = time.time()
        kill_extension_host()

        # Step 3: Wait for ALL extension hosts to die
        logger.log("Step 3: Waiting for extension host processes to die...")
        if not wait_for_extension_hosts_to_die(max_wait=30):
            logger.log_warn("Extension host processes did not all die within 15s")
        else:
            logger.log_info("All extension host processes terminated")

        # Step 4: Wait for extension host to restart
        logger.log("Step 4: Waiting for extension host to restart...")
        if not wait_for_extension_host_restart(max_wait=30):
            logger.log_warn("Extension host did not restart within 15s")
            failures.append("Extension host failed to restart")
            iteration_pass = False
        else:
            logger.log_info("Extension host restarted")

        # Step 5: Wait for Monet's reconnectSessions() to complete
        logger.log(f"Step 5: Waiting {monet_wait}s for Monet reconnectSessions()...")
        time.sleep(monet_wait)

        reconnect_time = time.time() - iteration_start
        reconnect_times.append(reconnect_time)

        # Step 6: Verify PIDs exist and are alive
        logger.log("Step 6: Verifying session PIDs...")
        after_sessions = get_sessions()

        for sid, data in after_sessions.items():
            pid = data.get('processId')

            if pid is None:
                logger.log(f"  {RED}FAIL{NC} {sid}: PID missing")
                failures.append(f"Session {sid}: PID missing")
                iteration_pass = False
                session_failures[sid] = session_failures.get(sid, 0) + 1
            elif not is_pid_alive(pid):
                logger.log(f"  {RED}FAIL{NC} {sid}: PID {pid} is dead")
                failures.append(f"Session {sid}: PID {pid} is dead")
                iteration_pass = False
                session_failures[sid] = session_failures.get(sid, 0) + 1
            else:
                logger.log(f"  {GREEN}PASS{NC} {sid}: PID {pid} alive")

        # Step 7: Check for lost sessions
        logger.log("Step 7: Checking for lost sessions...")
        for sid in before_sessions:
            if sid not in after_sessions:
                logger.log(f"  {RED}LOST{NC} {sid}: Status file disappeared")
                failures.append(f"Session {sid}: Status file disappeared")
                iteration_pass = False
                session_failures[sid] = session_failures.get(sid, 0) + 1

        # Step 8: Check logs for reconnection messages
        logger.log("Step 8: Checking Cursor logs for reconnection...")
        found_logs, log_count = check_reconnect_logs(kill_time)
        if found_logs:
            logger.log_info(f"Found {log_count} reconnection log message(s)")
        else:
            logger.log_warn("No 'Monet: Reconnected' messages found in logs")
            # Don't fail on this, just warn - logs might be delayed or in different format

        # Step 9: Verify status file structure
        logger.log("Step 9: Verifying status file structure...")
        for sid, data in after_sessions.items():
            required_fields = ['sessionId', 'project', 'status']
            missing_fields = [f for f in required_fields if f not in data or data[f] is None]
            if missing_fields:
                logger.log(f"  {RED}FAIL{NC} {sid}: Missing fields {missing_fields}")
                failures.append(f"Session {sid}: Missing fields {missing_fields}")
                iteration_pass = False
                session_failures[sid] = session_failures.get(sid, 0) + 1

        # Iteration summary
        logger.log("")
        logger.log(f"Reconnect time: {reconnect_time:.1f}s")
        if iteration_pass:
            logger.log_pass(f"Iteration {i} completed successfully")
            total_pass += 1
        else:
            logger.log_fail(f"Iteration {i} failed ({len(failures)} issue(s)):")
            for failure in failures:
                logger.log(f"  - {failure}")
            total_fail += 1

        # Brief pause between iterations
        if i < iterations and inter_iteration_pause > 0:
            time.sleep(inter_iteration_pause)

    # Final summary
    logger.log("")
    logger.log("═══════════════════════════════════════════════════════════════")
    logger.log("STRESS TEST COMPLETE")
    logger.log("═══════════════════════════════════════════════════════════════")
    logger.log("")

    # Results
    logger.log("Results:")
    logger.log(f"  Total iterations:      {iterations}")
    logger.log(f"  {GREEN}Passed{NC}:               {total_pass}")
    logger.log(f"  {RED}Failed{NC}:               {total_fail}")

    pass_rate = (total_pass / iterations) * 100 if iterations > 0 else 0
    logger.log(f"  Pass rate:             {pass_rate:.1f}%")
    logger.log("")

    # Timing stats
    if reconnect_times:
        avg_time = sum(reconnect_times) / len(reconnect_times)
        min_time = min(reconnect_times)
        max_time = max(reconnect_times)
        logger.log("Timing:")
        logger.log(f"  Average reconnect:     {avg_time:.1f}s")
        logger.log(f"  Min reconnect:         {min_time:.1f}s")
        logger.log(f"  Max reconnect:         {max_time:.1f}s")
        logger.log("")

    # Sessions that consistently failed
    if session_failures:
        logger.log("Sessions with failures:")
        for sid, count in sorted(session_failures.items(), key=lambda x: -x[1]):
            fail_rate = (count / iterations) * 100
            logger.log(f"  - {sid}: {count} failures ({fail_rate:.1f}%)")
        logger.log("")

    logger.log(f"Log file: {log_path}")
    logger.log("")

    logger.close()

    if total_fail > 0:
        print(f"{RED}{BOLD}STRESS TEST FAILED ({total_fail}/{iterations} iterations failed){NC}")
        sys.exit(1)
    else:
        print(f"{GREEN}{BOLD}STRESS TEST PASSED ({total_pass}/{iterations} iterations){NC}")
        sys.exit(0)


if __name__ == '__main__':
    main()
