# Monet Position 9

You are running as Monet position 9 in project "Monet".

## Status Updates

Whenever your task changes significantly, write your current status to:
`~/.monet/status/pos-9.json`

**Format:**
```json
{
  "position": 9,
  "project": "Monet",
  "status": "thinking",
  "title": "brief description of current task",
  "updated": 1234567890000
}
```

**Status values:**
- `thinking` - analyzing, planning, reasoning
- `coding` - writing or editing code
- `testing` - running tests, checking output
- `waiting` - waiting for user input
- `error` - encountered an error (include "error" field with message)
- `idle` - not actively working
- `complete` - task finished

**When to update:**
- When starting a new task
- When switching between thinking/coding/testing
- When encountering an error
- When completing a task
- When waiting for user input

**Title guidelines:**
- Keep it brief (2-5 words)
- Describe what you're doing, not the file
- Examples: "fixing auth bug", "adding tests", "reviewing PR"

Update the file by writing the complete JSON object. The timestamp should be `Date.now()`.
