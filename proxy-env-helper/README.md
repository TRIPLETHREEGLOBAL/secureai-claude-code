# Claude Code proxy helper

**Recommended:** use *Set up Claude Code* in the SecureAI tray menu, or run
`secureai setup --platform claude`. That adds SecureAI's proxy to Claude Code's own
settings (`~/.claude/settings.json` → `env`), so every Claude Code session uses it.
`secureai setup --platform claude --undo` removes exactly those entries again.

These helpers do the same for **one terminal only**:

```bash
source ./set-proxy.sh          # bash / zsh
```

```powershell
. .\set-proxy.ps1              # PowerShell
```

The proxy URL includes Claude Code's own SecureAI credentials
(`http://claude:<token>@127.0.0.1:<port>`). They are derived from this computer's
SecureAI key, are only accepted on this computer, and let SecureAI show when Claude
Code is actually using the protected route.

## What this covers

- Claude Code (CLI and IDE extensions) started from a configured environment.
- **Not** Claude Desktop, which manages its own connection.
- `NO_PROXY` always keeps `localhost`, `127.0.0.1` and `::1` direct.

SecureAI never reads prompts, code or responses: the gateway forwards encrypted
connections without opening them.
