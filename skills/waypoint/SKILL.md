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
- The user hands you a Waypoint URL, an ID, or a title, or asks you to act on work another agent published. See [Picking up existing work](#picking-up-existing-work).
- You're revising something you published earlier in this task. Add a revision; don't create a new collection.

## How to write

1. **New artifact:** `create_collection` with a clear `title` and the files, then **keep the returned `collection_id`** for the rest of the task.
   - A single document: `files: [{ path: "plan.md", source_path: "/abs/path/plan.md" }]`.
   - A directory of run output: `source_dir: { dir: "/abs/path/run-output" }`. `.git`, `node_modules`, and dotfiles are excluded by default.
   - Paths must be **absolute**. Small generated text can be passed inline with `content` instead of `source_path`.
   - Set `head_path` when it isn't obvious. Otherwise Waypoint picks `index.html`, then `index.md`, then `README.md`, then the only file.
2. **Updating it:** `add_revision` with the `collection_id`. It **merges** by default: send only the changed files, and list deleted paths in `remove`. Use `mode: "replace"` only when the file set should be exactly what you send. The head document carries over from the previous revision, so pass `head_path` only to change it.
3. Write a short `message` on each revision describing what changed, like a commit message.
4. Relative links between files in the same collection work, for example `[details](notes/details.md)` and `![chart](img/chart.png)`.

## Picking up existing work

Another agent (or an earlier session) may have built a collection for you to act on.

1. **Find it:** `search_collections`.
   - Pass a title fragment, ID, public ID, or URL as `query`, or filter by `metadata` (e.g. `{ "project": "api" }`).
   - With no arguments it lists the most recently updated collections, with titles and metadata.
   - If several match, prefer the most recently updated one, or ask the user when it's ambiguous.
2. **Read it:** `get_collection` with `include_head: true` returns the manifest and the head document's text in one call. Read the other files it references with `read_file`.
3. **Note the revision you read** (`latest_revision.id`), and say which revision your work is based on.
4. **Watch for changes** if you're waiting on another agent: `wait_for_revision` with that revision ID. It returns as soon as a newer revision exists, or `changed: false` after the timeout; call it again to keep waiting.
5. **Report back into the same collection** with `add_revision` (e.g. a `results.md`) when the user wants your outcome kept alongside the plan. Otherwise create your own collection and mention the source collection's `latest_url` in it.

When publishing work that others should pick up, set `metadata` such as `{ "project": "<repo or topic>", "tags": ["research"] }` so it can be found by filter.

## What to tell the user

- Give them **`latest_url`**, which always shows the newest revision. Give `url` (pinned to this revision) only when they need a fixed snapshot.
- `sync_state` of `pending` or `committed` is normal; the content is already viewable. It becomes `synced` once it reaches the cloud. `failed` means the cloud upload gave up; mention it and suggest checking `<writer>/status`. To re-check sync state later, call `list_revisions`.
- If `waypoint_status` reports `mcp.update_available`, tell the user that restarting the agent session picks up the newer Waypoint MCP version.
- If `waypoint_status` lists a `local_only` warning, the writer runs without cloud sync: writes stay on that machine only and share links can't be served publicly. Mention it when the user relies on durability or sharing.
- A `warning: WAYPOINT_URL uses plain HTTP` line on stderr is informational. If the user trusts the network to the writer, `WAYPOINT_MCP_ALLOW_HTTP=1` in the MCP server's `env` silences it.

## Rules

- **Never publish secrets.** Before publishing, check that files don't contain API keys, tokens, passwords, `.env` contents, or private keys. Everything is stored in the cloud.
- One collection per artifact or task, not per file. Revise rather than duplicate.
- Don't delete or purge collections. Those actions are for the user, through the Waypoint UI.
- Use `read_file` to reload an earlier plan instead of asking the user to paste it.
