---
name: prism-inbox
description: Automated mailbox and session inspection for a target Prism Browser profile
---

Inspect the specified Prism Browser profile's mailbox or web session with zero default-profile contamination.

1. Ensure Prism Browser MCP is ready (`prism_health`).
2. Discover and verify the target profile (`prism_list_profiles`).
3. Open target mailbox in the isolated profile context (`prism_open_page`).
4. Read recent messages using compact page extraction (`prism_get_markdown`).
5. Extract key status without dumping raw DOM trees into context.
