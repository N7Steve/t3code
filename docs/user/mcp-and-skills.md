# MCP servers and skills

**Settings → MCP & skills** manages the MCP servers and skills your agent CLIs load
on their own, in one list. It edits each CLI's config files on the selected
environment's machine, so a remote environment's list is that machine's, not
yours. This is separate from [Outside agents](./outside-agents.md), which lets
other apps reach T3 Code.

## MCP servers and connectors

Each server shows a button per CLI. Turn one on to write the server into that
CLI's config, or off to take it out. **Add server** takes a command with its
arguments and environment variables; **Add connector** takes a remote URL with
headers. Connectors are the same entries, listed on their own tab.

| CLI         | File T3 Code edits                                    | Notes                   |
| ----------- | ----------------------------------------------------- | ----------------------- |
| Claude Code | `~/.claude.json`, or `.claude.json` in its config dir | User-scope `mcpServers` |
| Codex       | `config.toml` in `CODEX_HOME` (`~/.codex`)            | No SSE servers          |
| Cursor      | `~/.cursor/mcp.json`                                  |                         |
| OpenCode    | `~/.config/opencode/opencode.json` (or `.jsonc`)      |                         |

A Claude or Codex instance with its own home directory gets its own button.
Other providers are not managed here yet.

Before changing a file, T3 Code saves a copy beside it named
`<file>.t3-backup-<time>` and keeps the five most recent. Only the edited server
changes; other settings, comments, and servers stay as they were. A file that
cannot be parsed is left alone and marked in **Config files**.

A server turned off in every CLI stays in the list so you can turn it back on.
Use the trash button to remove it everywhere.

When enabled CLIs have different definitions for the same server, choose
**Sync CLIs** and select the configuration to copy. T3 Code updates the other
enabled CLIs and backs up their files. The source must use a transport supported
by all enabled CLIs.

### Missing files

A server whose command, working directory, or a path in its arguments or
environment no longer exists is marked **Missing files**. This often happens
after an update replaces an install folder named by version or hash. **Repair
MCP** shows each missing path per CLI and, when a sibling folder of the same
kind holds every missing file, the path it would use instead (the newest one).
Nothing changes until you confirm, and only those paths are rewritten.

Commands that are not on the environment's `PATH`, and paths with no matching
sibling, are shown but not repaired: reinstall the tool or edit the server. An
app that registers its own servers, such as the Codex app, may write its entry
again the next time it runs.

## Skills

The **Skills** tab lists folders with a `SKILL.md` in each CLI's skills folder,
such as `~/.claude/skills` or `~/.codex/skills`. Turning a skill on for another
CLI copies its folder there; turning it off deletes that copy. When you turn
off the last copy, T3 Code keeps one in its own data folder so you can turn it
back on. **Delete** removes the skill from every CLI and cannot be undone.

## Custom Codex plugins

Open **Plugins → Import ZIP** to upload a Codex plugin to the selected
environment. The ZIP can be up to 8 MB and must contain
`.codex-plugin/plugin.json` at its root or inside a single enclosing folder.
Then turn it on for each Codex profile where you want to use it. Start a new
Codex session to load the plugin and complete any app connection it requires.
Turning it off uninstalls it from that profile and keeps the uploaded copy in
T3 Code. **Delete** removes both the installations and the uploaded copy.
