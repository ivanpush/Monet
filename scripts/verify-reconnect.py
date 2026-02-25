#!/usr/bin/env python3
"""
verify-reconnect.py - Single snapshot verification of Monet session reconnection

Lists all status files with their processId and projectPath
Lists all running terminal PIDs from ps
Shows which sessions have a matching live PID and which are orphaned
Exits with code 1 if any active session is missing a PID

Created: 2026-02-24
"""

import json
import os
import subprocess
import sys
from pathlib import Path

# Colors
RED = '\033[0;31m'
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
CYAN = '\033[0;36m'
NC = '\033[0m'  # No Color

STATUS_DIR = Path.home() / '.monet' / 'status'


def get_running_pids() -> set:
    """Get PIDs of all running processes."""
    try:
        result = subprocess.run(
            ['ps', '-eo', 'pid'],
            capture_output=True,
            text=True
        )
        pids = set()
        for line in result.stdout.strip().split('\n')[1:]:  # Skip header
            line = line.strip()
            if line.isdigit():
                pids.add(int(line))
        return pids
    except Exception:
        return set()


def is_pid_alive(pid: int) -> bool:
    """Check if a specific PID is running."""
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


def main():
    print()
    print("═══════════════════════════════════════════════════════════════")
    print("  MONET SESSION RECONNECTION VERIFICATION")
    print("═══════════════════════════════════════════════════════════════")
    print()

    # Check if status directory exists
    if not STATUS_DIR.exists():
        print(f"{RED}ERROR: Status directory does not exist: {STATUS_DIR}{NC}")
        sys.exit(1)

    # Get all 8-char hex session files
    session_files = sorted(STATUS_DIR.glob('[a-f0-9]' * 8 + '.json'))

    if not session_files:
        print(f"{YELLOW}No session files found in {STATUS_DIR}{NC}")
        print()
        sys.exit(0)

    print(f"{CYAN}Found {len(session_files)} session file(s){NC}")
    print()

    # Get running PIDs
    running_pids = get_running_pids()

    print("─────────────────────────────────────────────────────────────────")
    print("SESSION STATUS FILES:")
    print("─────────────────────────────────────────────────────────────────")
    print(f"{'SESSION_ID':<12} {'PID':<10} {'STATUS':<8} {'TITLE':<20} {'PROJECT':<20} PROJECT_PATH")
    print("─────────────────────────────────────────────────────────────────")

    orphaned_count = 0
    missing_pid_count = 0
    total_count = 0

    for filepath in session_files:
        session_id = filepath.stem
        data = load_session_file(filepath)

        if data is None:
            print(f"{session_id:<12} {'ERROR':<10} {'--':<8} {'Could not parse file':<20}")
            continue

        total_count += 1

        process_id = data.get('processId')
        project = data.get('project', 'unknown') or 'unknown'
        project_path = data.get('projectPath', '') or ''
        status = data.get('status', 'unknown') or 'unknown'
        title = data.get('title', '') or ''

        # Truncate long paths for display
        display_path = project_path
        if len(project_path) > 40:
            display_path = '...' + project_path[-37:]

        # Determine PID status
        if process_id is None:
            pid_status = f"{RED}NO PID{NC}"
            pid_display = "null"
            missing_pid_count += 1
        elif is_pid_alive(process_id):
            pid_status = f"{GREEN}LIVE{NC}"
            pid_display = str(process_id)
        else:
            pid_status = f"{YELLOW}DEAD{NC}"
            pid_display = str(process_id)
            orphaned_count += 1

        # Truncate long titles for display
        display_title = title[:17] + '...' if len(title) > 20 else title

        print(f"{session_id:<12} {pid_display:<10} {status:<8} {display_title:<20} {project:<20} {display_path}")
        print(f"             └─ PID Status: {pid_status}")

    print()
    print("─────────────────────────────────────────────────────────────────")
    print("SUMMARY:")
    print("─────────────────────────────────────────────────────────────────")
    print(f"  Total sessions:     {total_count}")

    if missing_pid_count > 0:
        print(f"  Missing PID:        {missing_pid_count} {RED}(FAIL){NC}")
    else:
        print(f"  Missing PID:        0")

    if orphaned_count > 0:
        print(f"  Orphaned (dead):    {orphaned_count} {YELLOW}(stale){NC}")
    else:
        print(f"  Orphaned (dead):    0")

    live_count = total_count - missing_pid_count - orphaned_count
    print(f"  Live:               {live_count}")
    print()

    # Exit with error if any active session is missing a PID
    if missing_pid_count > 0:
        print(f"{RED}FAIL: {missing_pid_count} session(s) missing processId{NC}")
        sys.exit(1)
    else:
        print(f"{GREEN}PASS: All sessions have processId{NC}")
        sys.exit(0)


if __name__ == '__main__':
    main()
