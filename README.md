# OpenCode Dynamic Task Plugin

OpenCode plugin that provides `task()`, `task_continue()`, and `task_interrupt()` tools for dynamic subagent execution.

## Features

- **dynamic_task** — Spawn any registered subagent with a prompt
- **task_continue** — Send follow-up messages to running child sessions
- **task_interrupt** — Abort running child sessions
- Configurable timeout per request (`timeout_ms` argument or `DYNAMIC_TASK_TIMEOUT` env)
- Async/fire-and-forget mode (`await_response: false`)
- Automatic agent discovery and caching
- Child session tracking with `parentID`

## Installation

1. Ensure the plugin file is at `~/.config/opencode/plugins/dynamic-task.ts` (auto-scanned by OpenCode)
2. Restart OpenCode

## Usage

```
dynamic_task(description="Analyze codebase", subagent_type="explore", prompt="Find all TODO comments in src/")
```

Fire-and-forget (doesn't block):
```
dynamic_task(description="Background task", subagent_type="general", prompt="...", await_response=false)
```

Continue a session:
```
task_continue(session_id="ses_xxx", prompt="Now also check the tests")
```

Interrupt:
```
task_interrupt(session_id="ses_xxx")
```

## Configuration

| Env Variable | Description | Default |
|-------------|-------------|---------|
| `DYNAMIC_TASK_CACHE_TTL` | Agent list cache duration (ms) | `300000` (5 min) |
| `DYNAMIC_TASK_TIMEOUT` | Default wait timeout (ms) | `120000` (2 min) |

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build
npm run build
```

## License

MIT
