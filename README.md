# acp-discord

Discord bot that connects coding agents (Claude Code, Codex, etc.) to Discord channels via the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/).

Send a message in Discord, get AI coding assistance back — with tool call visualization, permission prompts, and real-time streaming.

## Features

- **Slash commands & mentions** — `/ask <message>`, `/clear`, or `@bot message`
- **Real-time streaming** — agent responses stream into Discord with smart message splitting
- **File diffs** — see unified diffs in Discord when the agent modifies files
- **Tool call visualization** — see what the agent is doing (⏳ pending → 🔄 running → ✅ done / ❌ failed), with a ⏹️ stop button to cancel
- **Permission UI** — Discord buttons for approving/denying agent actions, with file diffs shown inline for review before approval
- **Discord channel management** — agents can create/delete/modify Discord channels via MCP tools, with user confirmation for all mutating operations
- **Scheduled tasks** — agents can create once/cron/interval tasks that fire in isolated sessions, with configurable Discord notifications
- **Auto-reply mode** — optionally respond to all messages in a channel, not just mentions
- **Multi-agent support** — different channels can use different agents
- **Daemon mode** — runs in background with auto-start (systemd/launchd)
- **Self-update** — `acp-discord update` to update in-place, auto-restarts the daemon
- **Interactive setup** — guided `init` wizard for first-time configuration

## Prerequisites

- Node.js >= 18
- A Discord bot token ([create one here](https://discord.com/developers/applications))
- **An ACP-compatible coding agent installed and working** — the `init` wizard uses an agent to help generate your config. For example, install [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and verify it runs with `claude --version`.

## Quick Start

```bash
# Run the setup wizard (interactive, agent-driven)
npx acp-discord init

# Start the daemon
npx acp-discord daemon start
```

## Configuration

Config lives at `~/.acp-discord/config.toml`:

```toml
[discord]
token = "your-discord-bot-token"

[agents.claude]
command = "claude-code"
args = ["--acp"]
cwd = "/path/to/your/project"
idle_timeout = 600  # seconds before idle session is terminated (default: 600)
discord_tools = true  # enable Discord channel management MCP tools (default: false)
scheduled_tasks = true  # enable scheduled task MCP tools (default: false)

[channels.1234567890123456]
agent = "claude"
cwd = "/override/path"   # optional, per-channel working directory override
auto_reply = true         # optional, respond to all messages (default: false, mention-only)
```

### Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot → copy the token
3. Enable **Message Content Intent** under Bot settings
4. Invite the bot to your server with `bot` + `applications.commands` scopes
5. Copy the channel ID(s) you want the bot to respond in (right-click channel → Copy Channel ID)

## Usage

### CLI Commands

```bash
# Interactive setup wizard
acp-discord init

# Daemon management
acp-discord daemon start    # Start in background
acp-discord daemon run      # Run in foreground (for service managers)
acp-discord daemon stop     # Graceful shutdown
acp-discord daemon status   # Check if running

# Auto-start on boot
acp-discord daemon enable   # Setup systemd (Linux) / launchd (macOS)
acp-discord daemon disable  # Remove auto-start

# Self-update
acp-discord update          # Update to latest version, auto-restarts daemon
```

### Discord Commands

| Command | Description |
|---------|-------------|
| `/ask <message>` | Send a prompt to the coding agent |
| `/clear` | Clear the current session and start fresh |
| `@bot <message>` | Mention the bot to send a prompt |

If a prompt is sent while the agent is already working, it gets queued and processed after the current task completes.

### Channel Management

When `discord_tools = true` is set on an agent, the bot injects an MCP server that gives the agent these tools:

| Tool | Description | Requires Approval |
|------|-------------|:-----------------:|
| `list_channels` | List all text channels in the server | No |
| `create_channel` | Create a new text channel | Yes |
| `delete_channel` | Delete a channel | Yes |
| `update_channel` | Update channel name/topic | Yes |
| `send_message` | Send a message to a channel | No |

All mutating operations (create, delete, update) require user approval via Discord buttons before executing. Newly created channels are automatically registered so the bot responds to messages there.

### Scheduled Tasks

When `scheduled_tasks = true` is set on an agent, the bot injects an MCP server that gives the agent tools to create and manage scheduled tasks. Each task fires by spawning an isolated, ephemeral agent session.

| Tool | Description | Requires Approval |
|------|-------------|:-----------------:|
| `list_scheduled_tasks` | List all scheduled tasks for this channel | No |
| `create_scheduled_task` | Create a new scheduled task | Yes |
| `update_scheduled_task` | Update an existing task | Yes |
| `delete_scheduled_task` | Delete a task | Yes |
| `get_task_logs` | Get execution history | No |

**Schedule types:**
- `once` — fire at a specific ISO datetime, then auto-complete
- `cron` — recurring via cron expression (e.g. `*/5 * * * *`)
- `interval` — recurring every N seconds, anchored to last run to prevent drift

**Notification modes** (per task, default `on_error`):
- `always` — post agent output to Discord after every run
- `on_error` — only post if execution fails
- `never` — silent, log only

Tasks are scoped to the channel that created them. Task data is persisted at `~/.acp-discord/scheduled-tasks.json` and execution history at `~/.acp-discord/task-run-logs.json`.

### Development

```bash
pnpm dev          # Run with tsx (auto-reload)
pnpm test         # Run tests
pnpm test:watch   # Watch mode
```

## Architecture

```
Discord User
    ↓  slash command / mention
Discord Bot (discord.js)
    ↓  channel routing           ↑ IPC (Unix socket)
Session Manager                MCP Servers (discord-channels, scheduled-tasks)
    ↓  spawn agent subprocess      ↑ MCP tools (stdio)
ACP Client (JSON-RPC over stdio)
    ↓  prompt / permissions / tool calls
Agent (claude-code, codex, etc.)
    ↑
Discord messages, embeds, buttons

TaskScheduler (15s poll loop)
    ↓  fires due tasks
Ephemeral ACP Session (isolated, destroyed after)
    ↓  conditionally posts to Discord (based on notify setting)
```

## License

MIT
