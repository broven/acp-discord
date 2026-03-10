# acp-discord Design

> Discord Bot that wraps ACP (Agent Client Protocol) to let users interact with coding agents in Discord channels.

## Architecture

```
Discord User
  ↕ @mention / /ask / message in bound channel
Discord.js Client (Gateway + REST)
  ↕
acp-discord daemon
  ├── SessionManager  — Channel↔Session mapping, Agent process lifecycle
  ├── ChannelRouter   — Channel → Agent profile routing
  ├── MessageBridge   — Discord message ↔ ACP prompt, streaming reply aggregation
  └── PermissionUI    — Permission request → Discord buttons → ACP response
  ↕ JSON-RPC 2.0 over stdio (one subprocess per channel session)
Agent subprocess (claude-agent-acp / codex-acp / ...)
```

## Key Decisions

| Decision | Choice |
|----------|--------|
| Session model | Channel = Session, single-user scenario |
| Permission handling | Pass through Agent's permission options (allow_once/always, reject_once/always) |
| Output display | Summary mode: tool call status icons, no content details |
| Agent process model | One process per session, 10 min idle timeout |
| Config format | TOML at `~/.acp-discord/config.toml` |
| Trigger method | @mention + `/ask`, configurable per channel |
| Agent routing | Each channel binds to a different agent profile |
| Init wizard | Detect installed agents → use ACP agent to interactively guide setup |
| Streaming display | 500ms debounce message edits, Stop button during execution |

## Configuration

`~/.acp-discord/config.toml`:

```toml
[discord]
token = "your-bot-token-here"

# Define multiple agent profiles
[agents.default]
command = "npx"
args = ["@zed-industries/claude-agent-acp"]
cwd = "/home/user/project-a"
idle_timeout = 600

[agents.codex]
command = "npx"
args = ["@openai/codex-acp"]
cwd = "/home/user/project-b"
idle_timeout = 600

# Bind channels to agent profiles
# Unconfigured channels are ignored
[channels.1234567890]
agent = "codex"
cwd = "/home/user/project-c"  # override agent default cwd

[channels.9876543210]
agent = "default"
```

## CLI Commands

```bash
# Interactive setup wizard (ACP agent-driven)
npx acp-discord init

# Daemon management
npx acp-discord daemon start
npx acp-discord daemon stop
npx acp-discord daemon status

# Auto-start on boot (systemd / launchd)
npx acp-discord daemon enable
npx acp-discord daemon disable
```

### `init` Flow

1. Detect installed ACP-compatible agents: `claude-code` → `codex` → `opencode` → `pi`
2. Spawn detected agent via ACP
3. Agent interactively guides user through configuration:
   - Discord Bot token
   - Working directory
   - Channel bindings
4. Agent writes `~/.acp-discord/config.toml`

### `daemon enable`

- Linux → generates `~/.config/systemd/user/acp-discord.service`, runs `systemctl --user enable`
- macOS → generates `~/Library/LaunchAgents/com.acp-discord.plist`

## Project Structure

```
src/
├── cli/
│   ├── index.ts          # CLI entry, commander parses commands
│   ├── init.ts           # Init wizard (detect agent → spawn ACP session)
│   └── daemon.ts         # daemon start/stop/status/enable/disable
├── daemon/
│   ├── index.ts          # Daemon entry, starts Discord client
│   ├── config.ts         # Parse ~/.acp-discord/config.toml
│   ├── channel-router.ts # channel → agent profile routing
│   ├── session-manager.ts# channel → ACP session/process lifecycle
│   ├── acp-client.ts     # ACP Client interface implementation
│   ├── message-bridge.ts # Discord message ↔ ACP prompt conversion
│   └── permission-ui.ts  # Permission button send & collect
├── shared/
│   ├── detect-agents.ts  # Detect installed ACP agents
│   └── types.ts          # Shared type definitions
└── index.ts              # Package bin entry
```

## Data Flow

### Main Conversation Flow

1. User sends @mention or `/ask` in a configured channel
2. `ChannelRouter` looks up agent profile for this channel
3. `SessionManager.getOrCreate(channelId)`:
   - If no active session: spawn Agent process → `initialize` → `session/new`
   - If existing session: reuse, reset idle timer
4. `session/prompt` with user message as `ContentBlock[]`
5. Agent streams `session/update` notifications:
   - `tool_call` / `tool_call_update` → `MessageBridge` updates tool summary message (single message, edited in place)
   - `agent_message_chunk` → `MessageBridge` aggregates with 500ms debounce, edits reply message
   - `request_permission` → `PermissionUI` sends Embed with buttons
6. Stop button present on messages during execution
7. `session/prompt` returns → remove Stop button, finalize messages

### Permission Flow

1. Agent sends `request_permission` with options
2. `PermissionUI` sends Embed with buttons matching Agent's options (Allow / Always Allow / Reject / etc.)
3. User clicks button → respond to ACP with `{ outcome: "selected", optionId }`
4. Timeout (14 min) → respond `{ outcome: "cancelled" }`, disable buttons

### Stop Flow

1. User clicks Stop button during Agent execution
2. Send ACP `session/cancel` notification
3. Respond `{ outcome: "cancelled" }` to all pending permission requests
4. Wait for Agent to return `stopReason: "cancelled"`
5. Edit message: remove Stop button, append "Stopped"
6. User's next message starts a new `session/prompt` turn

### Idle Timeout Flow

1. 10 minutes no activity on a channel session
2. Kill Agent subprocess, remove from sessions Map
3. Next user message → spawn fresh process, use `session/load` to restore if supported, otherwise `session/new`

## Discord Display Design

### Tool Call Summary (single message, edited in place)

```
⏳ Reading src/auth/login.ts
⏳ Reading src/middleware/rateLimit.ts
[⏹ Stop]
```

Updates to:

```
✅ Read src/auth/login.ts
✅ Read src/middleware/rateLimit.ts
🔄 Writing src/auth/login.ts
[⏹ Stop]
```

### Permission Request (separate Embed message)

```
┌──────────────────────────────────────┐
│ ✏️ Write src/auth/login.ts            │
│                                      │
│ [✅ Allow] [✅ Always] [❌ Reject]    │
└──────────────────────────────────────┘
```

### Final Reply (separate message)

```
已经给 login 函数加上了 rate limiting，使用了
sliding window 算法，每个 IP 每分钟最多 5 次
登录尝试。修改了 `src/auth/login.ts`。
```

## Error Handling

| Scenario | Handling |
|----------|----------|
| Agent process crash | Clean up session, notify in channel "Agent process exited, will restart on next message" |
| Reply > 2000 chars | Split into multiple messages, don't break code blocks |
| Permission button timeout | Respond `cancelled` to ACP, disable buttons |
| Message during active prompt | Queue it, reply "Agent is working, your message is queued" |
| Daemon unexpected exit | PID file at `~/.acp-discord/daemon.pid`, `daemon start` checks and cleans stale PID |

## Tech Stack

| Component | Choice |
|-----------|--------|
| Runtime | Node.js 18+ |
| Language | TypeScript 5.x |
| Discord library | discord.js v14 |
| ACP SDK | @agentclientprotocol/sdk |
| Config parsing | smol-toml |
| CLI framework | commander |
| Build | tsup |
| Process daemon | Native child_process detach + PID file |
