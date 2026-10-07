---
name: waypoint
description: "Publish plans, research documents, screenshots, and run output to Waypoint, the user's artifact store, so they can be viewed at a stable URL from any machine on their tailnet. Use when you produce an HTML or markdown plan, a report, screenshots, or a multi-file run output that the user should look at, or when the user asks to put something in Waypoint, update a Waypoint collection, or read one back. Requires the `waypoint` MCP server."
---

# Waypoint

Waypoint stores agent artifacts as **collections**. Each collection is a growing history of immutable **revisions**. A revision is a set of files with one **head document**, the file the user sees first. Every write gives you URLs that work right away on the user's tailnet.

Use the `waypoint` MCP server's tools. If they aren't available, tell the user the Waypoint MCP server isn't configured for this agent, point them to `<writer>/mcp` for setup, and stop. Don't invent another upload path.

## When to use it

- You wrote a plan, design doc, report, or research summary the user should review. Publish it instead of only leaving it on disk.
- You produced screenshots, images, or several related files from a run. Publish them together as one collection.
- The user hands you a Waypoint URL. Call `resolve_url` to get IDs, then `get_collection` or `read_file`.
- You're revising something you published earlier in this task. Add a revision; don't create a new collection.

## How to write

1. **New artifact:** `create_collection` with a clear `title` and the files, then **keep the returned `collection_id`** for the rest of the task.
   - A single document: `files: [{ path: "plan.md", source_path: "/abs/path/plan.md" }]`.
   - A directory of run output: `source_dir: { dir: "/abs/path/run-output" }`. `.git`, `node_modules`, and dotfiles are excluded by default.
   - Paths must be **absolute**. Small generated text can be passed inline with `content` instead of `source_path`.
   - Set `head_path` when it isn't obvious. Otherwise Waypoint picks `index.html`, then `index.md`, then `README.md`, then the only file.
2. **Updating it:** `add_revision` with the `collection_id`. It **merges** by default: send only the changed files, and list deleted paths in `remove`. Use `mode: "replace"` only when the file set should be exactly what you send.
3. Write a short `message` on each revision describing what changed, like a commit message.
4. Relative links between files in the same collection work, for example `[details](notes/details.md)` and `![chart](img/chart.png)`.

## What to tell the user

- Give them **`latest_url`**, which always shows the newest revision. Give `url` (pinned to this revision) only when they need a fixed snapshot.
- `sync_state` of `pending` or `committed` is normal; the content is already viewable. It becomes `synced` once it reaches the cloud. `failed` means the cloud upload gave up; mention it and suggest checking `<writer>/status`.
- If `waypoint_status` reports `mcp.update_available`, tell the user that restarting the agent session picks up the newer Waypoint MCP version.

## Rules

- **Never publish secrets.** Before publishing, check that files don't contain API keys, tokens, passwords, `.env` contents, or private keys. Everything is stored in the cloud.
- One collection per artifact or task, not per file. Revise rather than duplicate.
- Don't delete or purge collections. Those actions are for the user, through the Waypoint UI.
- Use `read_file` to reload an earlier plan instead of asking the user to paste it.
