# OpenCode Dynamic Task Plugin

OpenCode plugin that provides `dynamic_task`, `task_continue`, `task_result`, `task_list`, `task_status`, and `task_interrupt` tools for dynamic subagent execution with async background mode and automatic parent notifications.

## Features

- **dynamic_task** — Spawn any registered subagent with a prompt, optionally in background mode
- **task_continue** — Send follow-up messages to running child sessions
- **task_result** — Inspect latest known child session status/output without sending a new prompt
- **task_list** — List all tracked background tasks with status, timing, and completion data
- **task_status** — Get detailed status for a single tracked task (lifecycle, timing, dependencies)
- **task_interrupt** — Abort running child sessions
- Async/fire-and-forget mode (`await_response: false`) with automatic parent notifications
- Configurable timeout per request with `model` override and `depends_on` dependency tracking
- Automatic agent discovery and caching
- Child session tracking with `parentID`
- Opt-in debug logging for troubleshooting
- Lifecycle policy layer: agent validation, recursive delegation prevention, depth limits
- Dual-map state (active + retained) with validated transition matrix
- Configurable timeout behavior: interrupt (abort), notify (alert only), notify_untrack
- Question API integration (auto-answer, reject, event handling for child questions)

## Installation

1. Add the plugin to your OpenCode profile's `plugin` array:
   ```jsonc
   "plugin": [
     "file:///path/to/dynamic-task-plugin/src/index.ts"
   ]
   ```
2. Run `npm install` in the plugin directory
3. Restart OpenCode

## Usage

### Spawn a task (blocking — waits for response)

```
dynamic_task(description="Analyze codebase", subagent_type="explore", prompt="Find all TODO comments in src/")
```

### Spawn with model override

```
dynamic_task(description="Review PR", subagent_type="reviewer", prompt="Review this code for bugs", model="opencode-go/mimo-v2.5")
```

### Spawn with dependencies

```
dynamic_task(description="Integration tests", subagent_type="qa-engineer", prompt="Run integration tests", depends_on=["ses_task1", "ses_task2"])
```

### Spawn a background task (non-blocking)

```
dynamic_task(description="Background analysis", subagent_type="general", prompt="Summarize the architecture", await_response=false)
```

When `await_response: false`, the plugin:
1. Creates a child session with the specified subagent
2. Wraps the prompt with explicit background-task instructions
3. Returns immediately with the child session ID
4. Sends an automated `[dynamic-task-notify]` message to the parent when the child completes
5. Tracks the child with a configurable timeout (default 120s)

### Check task result

```
task_result(session_id="ses_xxx")
```

Returns the latest known status, message count, and assistant output. Use this to poll for progress on background tasks.

### Continue a session

```
task_continue(session_id="ses_xxx", prompt="Now also check the tests")
```

### Interrupt a session

```
task_interrupt(session_id="ses_xxx")
```

## Background Task Notifications

When a background task completes, the parent session receives a `[dynamic-task-notify]` message. Notification types:

| Type | Trigger |
|------|---------|
| `completed successfully` | Child session finished with output |
| `ended with an error` | Child session ended in error state |
| `did not report completion before timeout` | Timeout elapsed without completion event |
| `completed after an earlier timeout` | Child completed after timeout notification was already sent |

Each child session triggers **exactly one** notification. Duplicate notifications are prevented by a completion guard.

## Configuration

| Env Variable | Description | Default |
|-------------|-------------|---------|
| `DYNAMIC_TASK_CACHE_TTL` | Agent list cache duration (ms) | `300000` (5 min) |
| `DYNAMIC_TASK_TIMEOUT` | Default wait timeout (ms) | `120000` (2 min) |
| `DYNAMIC_TASK_MAX_CONCURRENT` | Max concurrent background tasks per parent session | `4` |
| `DYNAMIC_TASK_DEBUG` | Enable debug logging (`1` = on) | `0` |
| `DYNAMIC_TASK_DEBUG_BLOCKLIST` | Comma-separated field names to exclude from debug logs (max 4) | `prompt,fullPrompt` |

## Debug Logging

Set `DYNAMIC_TASK_DEBUG=1` to write per-session logs under `.dynamic-task-logs/`.

Each log file is named:
```
parent-<parentSessionId>__child-<childSessionId>.log
```

The log contains event metadata only (event type/name, normalized status, timeout/completion decisions). It does not store full prompts. Field blocklisting is configurable via `DYNAMIC_TASK_DEBUG_BLOCKLIST`.

## Architecture

```
src/
├── index.ts                      # Plugin entry point, tool handlers, event router
├── debug-logger.ts               # Opt-in file-based debug logging
├── plugin-entry.ts               # Clean ESM re-export for OpenCode plugin loader
└── shared/
    ├── config.ts                 # DynamicTaskConfig normalization, 4-layer precedence, TimerProvider
    ├── task-policy.ts            # Pure policy functions: agent validation, lineage/depth checks
    ├── task-state.ts             # TaskStore (active + retained), validated transition matrix
    ├── session-lifecycle.ts      # Status normalization, event parsing, terminal detection
    ├── task-formatting.ts        # Notification formatting, background prompt wrapper
    └── question-handling.ts      # Question API integration (auto-answer, reject, event handling)
```

## Question Integration

When `await_response=false` is used, child sessions may ask questions via the OpenCode Question API. The plugin automatically:

1. Detects `question.created` events from background child sessions
2. Looks up the child session via an internal `questionIdToSessionId` map
3. Attempts to auto-answer with the first available option (if provided)
4. Falls back to rejecting with guidance: "use `task_continue` for follow-up"
5. Tracks `pendingQuestionId` on the background task state for cleanup

Both `replyToQuestion()` and `rejectQuestion()` are idempotent — they silently succeed if the question is already resolved (409 Conflict). All errors are caught and logged, never thrown.

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Type check
npm run lint

# Build (produces dist/)
npm run build

# Watch mode
npm run watch

# Debug mode (writes log files)
DYNAMIC_TASK_DEBUG=1 npm test
```

## Verification

```bash
npm run lint      # TypeScript type check
npm test          # Full test suite (130 tests, sequential)
```

Expected: lint passes, all 130 tests pass.

## License

MIT
