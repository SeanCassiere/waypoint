/** @jsxImportSource hono/jsx */
import { MCP_LAUNCHER_API, withBase } from "@waypoint/core";
import type { Context } from "hono";

import type { HttpServices } from "../../http.ts";
import { getChrome } from "../chrome.ts";
import { Time } from "../components.tsx";
import { HomeBar, Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";

export interface McpCommands {
  claude: string;
  codex: string;
  json: string;
  skills: string;
}
export function mcpCommands(baseUrl: string): McpCommands {
  const tarball = withBase(baseUrl, "/mcp/waypoint-mcp.tgz");
  const skill = withBase(baseUrl, "/mcp/skill/SKILL.md");
  return {
    claude: `claude mcp add waypoint --env WAYPOINT_URL=${baseUrl} -- npx --prefer-offline -y ${tarball}`,
    codex: `[mcp_servers.waypoint]\ncommand = "npx"\nargs = ["--prefer-offline", "-y", "${tarball}"]\n[mcp_servers.waypoint.env]\nWAYPOINT_URL = "${baseUrl}"`,
    json: `{"mcpServers":{"waypoint":{"command":"npx","args":["--prefer-offline","-y","${tarball}"],"env":{"WAYPOINT_URL":"${baseUrl}"}}}}`,
    skills: `mkdir -p ~/.claude/skills/waypoint && curl -fsSL ${skill} -o ~/.claude/skills/waypoint/SKILL.md\nmkdir -p ~/.codex/skills/waypoint && curl -fsSL ${skill} -o ~/.codex/skills/waypoint/SKILL.md`,
  };
}

function CodeBlock(props: { label: string; text: string; what: string }) {
  return (
    <div class="codeblock">
      <div class="cbh">
        <span>{props.label}</span>
        <button
          type="button"
          class="btn sm"
          data-action="copy-text"
          data-text={props.text}
          data-label={props.what}
        >
          Copy
        </button>
      </div>
      <pre>{props.text}</pre>
    </div>
  );
}

/** Connect an agent (spec §5.10). Tabs are links, so the page works without script. */
export async function mcpPage(
  s: HttpServices,
  c: Context,
  bundle: string | null,
): Promise<Response> {
  const now = Date.now();
  const [chrome, facets] = await Promise.all([getChrome(s, now), s.reads.facets(now)]);
  const commands = mcpCommands(s.reads.baseUrl);
  const client = c.req.query("client");
  const tab = client === "codex" || client === "json" ? client : "claude";
  const tabs = [
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["json", "JSON config"],
  ] as const;
  return noStore(
    c.html(
      <Layout title="Connect an agent" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="mcp">
        <main class="wrap narrow" id="main">
          <div class="ph">
            <div>
              <h1>Connect an agent</h1>
              <p>
                Agents publish to Waypoint through a small MCP server. Set it up once per machine.
                It updates itself on every session start.
              </p>
            </div>
          </div>
          <nav class="tabs2" aria-label="Agent">
            {tabs.map(([id, label]) => (
              <a href={`/mcp?client=${id}`} aria-current={id === tab ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          {tab === "claude" ? (
            <CodeBlock label="Terminal" text={commands.claude} what="command" />
          ) : tab === "codex" ? (
            <CodeBlock label="~/.codex/config.toml" text={commands.codex} what="config" />
          ) : (
            <CodeBlock label="MCP client config (JSON)" text={commands.json} what="config" />
          )}
          <h2 class="sec">Teach the agent how to use it (skill)</h2>
          <CodeBlock label="Terminal" text={commands.skills} what="commands" />
          <h2 class="sec">
            Machines that have published <span class="n">from revision metadata</span>
          </h2>
          <div class="rows">
            {facets.hosts.length ? (
              facets.hosts.map((host) => (
                <div class="r">
                  <span class="t mono">{host.value}</span>
                  <span class="aside">
                    last write <Time at={host.last_written_at} fmt="ago" now={now} />
                  </span>
                </div>
              ))
            ) : (
              <div class="empty">No machine has published yet.</div>
            )}
          </div>
          <p class="muted small">
            {bundle ? (
              <>
                Server bundle <span class="mono">{bundle}</span> ·{" "}
              </>
            ) : null}
            launcher API {MCP_LAUNCHER_API} · <a href="/mcp.md">Raw setup notes (markdown)</a> · Set{" "}
            <span class="mono">WAYPOINT_MCP_PIN=embedded</span> for debugging.
          </p>
        </main>
      </Layout>,
    ),
  );
}
