---
name: waypoint
description: "Publish finished artifacts to Waypoint, the user's store of point-in-time records: plans, design docs, reports, research, screenshots, run results, and self-contained interactive HTML prototypes. Each one is kept as an immutable revision with a stable URL the user can open from any machine on their tailnet, and can share publicly. Use when you produce something the user should review, keep, or share, or when the user asks to put something in Waypoint, update a Waypoint collection, or read one back. Not a scratchpad: don't use it for work-in-progress files, temporary scripts, or logs. Requires the `waypoint` MCP server."
---

# Waypoint

Waypoint is where the user keeps **artifact collections** from agent work: documents, reports, visuals and prototypes that capture a decision, a finding or a result at a point in time. Think of each collection as something the user will come back to, link from elsewhere, or share, not as a place to park files while you work.

Each collection is a growing history of immutable **revisions**. A revision is a set of files with one **head document**, the file the user sees first. Every revision is kept forever, and every write gives you URLs that work right away on the user's tailnet.

Use the `waypoint` MCP server's tools. If they aren't available, tell the user the Waypoint MCP server isn't configured for this agent, point them to `<writer>/mcp` for setup, and stop. Don't invent another upload path.

## What belongs in Waypoint

Publish things that are worth keeping as a record:

- **Documents:** plans, design docs, specs, proposals, decision records, reviews, research summaries, postmortems.
- **Results:** a report on what a run found, benchmark or test results with their charts, screenshots that show the state of something.
- **Interactive HTML prototypes:** a clickable UI mockup, a design exploration, a small tool or visualisation the user can try in the browser. See [HTML prototypes](#html-prototypes).
- **Work handed between agents:** a plan one agent writes and another picks up. See [Picking up existing work](#picking-up-existing-work).

Keep these out of it:

- Work-in-progress notes, drafts you're still iterating on alone, and scratch files. Publish when there is something for the user to look at.
- Throwaway scripts, raw logs, build output, `node_modules` or whole working directories. Summarise what matters in a document, and attach only the files that support it.
- Anything that belongs in the repository instead (source code, config the project depends on).

A good test: would the user want to open this URL again next week, or send it to someone? If not, it probably doesn't belong.

## When to use it

- You finished a plan, design doc, report, or research summary the user should review. Publish it instead of only leaving it on disk.
- You built an HTML prototype or visual the user should try out.
- You produced screenshots, images, or several related files that together make up one result. Publish them together as one collection, with a head document that explains them.
- The user hands you a Waypoint URL, an ID, or a title, or asks you to act on work another agent published. See [Picking up existing work](#picking-up-existing-work).
- You're revising something you published earlier in this task. Add a revision; don't create a new collection.

## How to write

1. **New artifact:** `create_collection` with a clear `title` and the files, then **keep the returned `collection_id`** for the rest of the task.
   - A single document: `files: [{ path: "plan.md", source_path: "/abs/path/plan.md" }]`.
   - Several files: list them in `files`, or point `source_dir: { dir: "/abs/path/report" }` at a directory you assembled for publishing (not your working directory). `.git`, `node_modules`, and dotfiles are excluded by default.
   - Paths must be **absolute**. Small generated text can be passed inline with `content` instead of `source_path`.
   - Set `head_path` when it isn't obvious. Otherwise Waypoint picks `index.html`, then `index.md`, then `README.md`, then the only file.
2. **Updating it:** `add_revision` with the `collection_id`. It **merges** by default: send only the changed files, and list deleted paths in `remove`. Use `mode: "replace"` only when the file set should be exactly what you send. The head document carries over from the previous revision, so pass `head_path` only to change it.
3. Write a short `message` on each revision describing what changed, like a commit message. Revisions are the artifact's history, so each one should be a version worth keeping, not every intermediate save.
4. Relative links between files in the same collection work, for example `[details](notes/details.md)` and `![chart](img/chart.png)`.

## HTML prototypes

HTML files are served exactly as written and run their scripts, so a single `.html` file can be a working, interactive prototype. The user views it inside the Waypoint viewer on the tailnet or the public reader, so make the HTML file stand on its own:

- **Bake your own CSS and JavaScript into the HTML file**, in `<style>` and `<script>` elements, rather than splitting them into separate `.css` and `.js` files beside it. Don't count on the page being able to load a relative stylesheet or script. Libraries and fonts from a CDN are fine to reference by URL.
- **Images** can be inline SVG or `data:` URIs, or separate image files in the same collection referenced by relative path (`img/hero.png`).
- **Publish what runs in the browser.** If you used a framework or bundler, publish the built output with your code inlined, not the sources.
- **Bake the data in.** Embed the data the prototype shows (a snapshot, a sample, or made-up records) as a JavaScript object in the page, rather than loading it from a production API, so it shows the same thing every time it's opened. Calling a public or demo API is fine when that's part of what the prototype shows. Never embed API keys or tokens, and don't call the Waypoint writer's own API.
- **Make it work when shared publicly.** Public share links show HTML in a sandboxed frame with an opaque origin, where some browser features fail:
  - `localStorage`, `sessionStorage`, IndexedDB and cookies throw. Keep state in memory, or wrap storage access in `try`/`catch` and carry on without it.
  - `alert`, `confirm` and `prompt` do nothing. Show messages in the page instead.
  - Form submission is blocked. Handle forms with a `submit` listener that calls `preventDefault()`.
  - Downloads started from the page are blocked. Users can download the file itself from the viewer.
- **Follow the system colour scheme** with `prefers-color-scheme`; the viewer has no theme toggle of its own.
- **Make it fit:** set `<meta name="viewport" content="width=device-width, initial-scale=1">` and check that the layout works at phone width, since the user may open it from any device.
- Name it `index.html` (or set `head_path`) so it opens first. If the prototype needs explaining, add a short `README.md` alongside it and link to it from the page, or link to the prototype from a markdown head document.

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

When publishing work that others should pick up, set `metadata` such as `{ "project": "<repo or topic>", "tags": ["research"] }` so it can be found by filter. Tag prototypes with `"prototype"`.

## What to tell the user

- Give them **`latest_url`**, which always shows the newest revision. Give `url` (pinned to this revision) only when they need a fixed snapshot.
- `sync_state` of `pending` or `committed` is normal; the content is already viewable. It becomes `synced` once it reaches the cloud. `failed` means the cloud upload gave up; mention it and suggest checking `<writer>/status`. To re-check sync state later, call `list_revisions`.
- If `waypoint_status` reports `mcp.update_available`, tell the user that restarting the agent session picks up the newer Waypoint MCP version.
- If `waypoint_status` lists a `local_only` warning, the writer runs without cloud sync: writes stay on that machine only and share links can't be served publicly. Mention it when the user relies on durability or sharing.
- A `warning: WAYPOINT_URL uses plain HTTP` line on stderr is informational. If the user trusts the network to the writer, `WAYPOINT_MCP_ALLOW_HTTP=1` in the MCP server's `env` silences it.

## Rules

- **Never publish secrets.** Before publishing, check that files don't contain API keys, tokens, passwords, `.env` contents, or private keys. Everything is stored in the cloud and kept forever, and revisions can't be edited after the fact.
- One collection per artifact, not per file. Revise rather than duplicate.
- Publish finished artifacts, not working files. Waypoint is a record, not a scratchpad.
- Don't delete or purge collections. Those actions are for the user, through the Waypoint UI.
- Use `read_file` to reload an earlier plan instead of asking the user to paste it.
