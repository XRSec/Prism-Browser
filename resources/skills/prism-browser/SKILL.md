---
name: prism-browser
description: >-
  Prism Fingerprint Browser automation via Prism MCP. Controls isolated vault profiles, task sessions, and structured page extraction. Manual-only; activate ONLY on /skill:prism-browser or explicit Prism profile intent.
compatibility: ">=1.0.0 (Antigravity, Pi Coding Agent, Claude Code, OpenAI Codex, Gemini CLI, Cursor, Windsurf)"
disable-model-invocation: true
metadata:
  version: "1.0.0"
  protocol: "AgentSkills/1.0"
  mcp-server: "prism"
  author: "Prism Browser Team"
---

# Prism Browser Automation Micro-Kernel

Orchestrate isolated Prism Browser profiles and pages via Prism MCP with zero host-browser contamination.

## Core Invariants
- **Zero Contamination**: NEVER modify default Chrome/Safari/Edge profiles, system hosts, or system proxies. Profile data stays isolated in the Prism Vault (`~/Library/Application Support/prism-browser/vault/` on macOS, `$XDG_CONFIG_HOME/prism-browser/vault/` or `~/.config/prism-browser/vault/` on Linux, `%APPDATA%\prism-browser\vault\` on Windows).
- **Safe Deletion**: NEVER run raw `rm` or `rm -rf` on vault or profile files; invoke `/opt/xrsec/.env/rmfile <target>` when present or use safe-delete tooling.
- **UUID Profile IDs**: Resolve `profileId` (UUID `id`) via `prism_list_profiles`; NEVER pass `serialNumber` to `prism_start_profile` or any tool. Only Local-AI-enabled profiles are visible.
- **Auto-Start Navigation**: `prism_open_page` auto-starts closed AI-enabled profiles; omit separate `prism_start_profile` calls.
- **Task Isolation (`taskSessionId`)**: Create `taskSessionId` via `prism_create_task_session({ profileId })` for concurrent tasks or multi-agent profile sharing, pass `taskSessionId` on page/DOM calls, and release via `prism_close_task_session`; call `prism_close_profile` only for full profile shutdown.
- **Opaque `ref_...` Handles**: `prism_read_page` and `prism_find` return transient, task-scoped `ref_...` handles (`^ref_[a-f\d]{32}$`). NEVER pass CSS or XPath selectors to `prism_get_text`, `prism_click_element`, or `prism_type_text`; re-read after navigation or DOM mutation.
- **No Raw HTML**: NEVER dump raw HTML into context. Extract via `prism_inspect_pages`, `prism_get_markdown`, `prism_read_page`, `prism_get_text`, `prism_get_table`, or `prism_get_list`; use `prism_take_screenshot` (or CUA fallback) only when accessibility state is obscured.
- **Schema First**: Inspect tool schemas before passing unfamiliar `prism_*` parameters (`durationMs`, `maxChars`, `ref`); never guess field names.

## Cross-Runtime Router
- **Antigravity**: Call `call_mcp_tool` on `ServerName: "Prism"` (or `"prism"` if listed lowercase in `<mcp_servers>`). Inspect schemas on demand in `~/.gemini/antigravity/mcp/Prism/` (or `.../mcp/prism/`) or via `tools/list`. Do NOT probe `~/.pi/agent/mcp.json`, `bot-prism.md`, or Paseo directories.
- **Pi / Claude Code / Cursor / Codex**: Call `mcp__prism__*` tools directly via native MCP binding or code mode.
- **CLI / Unbound Fallback**: Read `vault/runtime/mcp-connection.json` (`endpoint` + `Bearer <token>`) or spawn the MCP server command copied from Prism Settings -> Local AI (MCP).
- **Batch / Multi-Profile (`>3` profiles)**: Prefer `prism_inspect_pages` (`profileId`, `urls[1..10]`, `waitStableMs`, `maxCharsPerPage`, `closeProfileAfter`) to open, wait, and extract markdown in one MCP call. Across many profiles, fan out via subagents, workflows, or a direct script against `mcp-connection.json` instead of 100+ serial calls in one context.

## Lifecycle & Recovery
1. Check service and authorized profiles: `prism_health` -> `prism_list_profiles`.
2. Batch reading: `prism_inspect_pages`. Interactive flow: `prism_create_task_session` -> `prism_open_page` -> `prism_read_page`/`prism_find` -> interact -> `prism_close_task_session` (+ `prism_close_profile` when done).
3. `MCP_GLOBAL_DISABLED` / `PROFILE_NOT_ALLOWED` -> enable Local AI (MCP) globally and per-profile in Prism Settings.
4. `STALE_ELEMENT_REF` / `STALE_SNAPSHOT` -> re-run `prism_read_page` or `prism_find` in the same `taskSessionId`.
5. `NAVIGATION_TIMEOUT` / `PAGE_NOT_STABLE` -> SPAs often finish loading; verify via `prism_list_pages` or `prism_get_markdown`.
6. `TASK_SESSION_NOT_FOUND` -> create a fresh session via `prism_create_task_session({ profileId })`.
