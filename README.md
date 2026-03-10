# acp-discord

Discord bot that connects coding agents (Claude Code, Codex, etc.) to Discord channels via the [Agent Client Protocol (ACP)](https://agentclientprotocol.org/).

Send a message in Discord, get AI coding assistance back — with tool call visualization, permission prompts, and real-time streaming.

## Features

- **Slash commands & mentions** — `/ask <message>` or `@bot message`
- **Real-time streaming** — agent responses stream into Discord with smart message splitting
- **Tool call visualization** — see what the agent is doing with emoji status indicators
- **Permission UI** — Discord buttons for approving/denying agent actions
- **Multi-agent support** — different channels can use different agents
- **Daemon mode** — runs in background with auto-start (systemd/launchd)
- **Interactive setup** — guided `init` wizard for first-time configuration

## Prerequisites

- Node.js >= 18
- pnpm
- A Discord bot token ([create one here](https://discord.com/developers/applications))
- An ACP-compatible agent (e.g. `claude-code --acp`)

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run the setup wizard
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
idle_timeout = 600  # seconds, optional

[channels.1234567890123456]
agent = "claude"
cwd = "/override/path"  # optional, per-channel override
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
```

### Discord Commands

| Command | Description |
|---------|-------------|
| `/ask <message>` | Send a prompt to the coding agent |
| `@bot <message>` | Mention the bot to send a prompt |

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
    ↓  channel routing
Session Manager (per-channel sessions)
    ↓  spawn agent subprocess
ACP Client (JSON-RPC over stdio)
    ↓  prompt / permissions / tool calls
Agent (claude-code, codex, etc.)
    ↑
Discord messages, embeds, buttons
```

## License

MIT
