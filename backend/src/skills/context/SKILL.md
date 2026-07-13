---
name: context
description: Use this skill when the user wants important information preserved for later use across the current workspace or future agent sessions. Activate it for saving architectural decisions, configuration values, environment details, port numbers, project state, important notes, or any persistent working context the agent may need to recall later.
---

# Context

This skill provides persistent workspace memory for storing important project or session context.

## Available Tools

- `context_save` — Persist key-value notes for later reference.

## Instructions

Use `context_save` to persist:

- Architectural decisions
- Environment configuration details
- Port assignments
- Project state or progress checkpoints
- Important implementation notes
- Reusable workspace context needed across sessions

Prefer this skill when information should survive agent restarts instead of remaining only in transient conversation context.
