/** @jsxImportSource hono/jsx */
import { MCP_LAUNCHER_API, withBase } from "@waypoint/core";
import { icon } from "@waypoint/ui";
import type { Context } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";

import type { HttpServices } from "../../http.ts";
import type { Facets } from "../../read-model.ts";
import { getChrome } from "../chrome.ts";
import { Time } from "../components.tsx";
import { HomeBar, Layout } from "../layout.tsx";
import { noStore } from "../respond.ts";

export type McpClient = "claude" | "codex" | "other";
export interface McpClientCommands {
  server: string;
  skill: string;
}
export interface McpCommands {
  claude: McpClientCommands;
  codex: McpClientCommands;
  other: McpClientCommands;
  skillUrl: string;
}
/** What each client copies. The Claude Code command and the Codex TOML are byte-identical to the
 *  earlier page's; only Other's JSON is pretty-printed. */
export function mcpCommands(baseUrl: string): McpCommands {
  const tarball = withBase(baseUrl, "/mcp/waypoint-mcp.tgz");
  const skillUrl = withBase(baseUrl, "/mcp/skill/SKILL.md");
  const skill = (dir: string) =>
    `mkdir -p ~/${dir}/skills/waypoint && curl -fsSL ${skillUrl} -o ~/${dir}/skills/waypoint/SKILL.md`;
  const json = {
    mcpServers: {
      waypoint: {
        command: "npx",
        args: ["--prefer-offline", "-y", tarball],
        env: { WAYPOINT_URL: baseUrl },
      },
    },
  };
  return {
    claude: {
      server: `claude mcp add waypoint --env WAYPOINT_URL=${baseUrl} -- npx --prefer-offline -y ${tarball}`,
      skill: skill(".claude"),
    },
    codex: {
      server: `[mcp_servers.waypoint]\ncommand = "npx"\nargs = ["--prefer-offline", "-y", "${tarball}"]\n[mcp_servers.waypoint.env]\nWAYPOINT_URL = "${baseUrl}"`,
      skill: skill(".codex"),
    },
    other: { server: JSON.stringify(json, null, 2), skill: skillUrl },
    skillUrl,
  };
}

const PROMPT = "Publish a short note to Waypoint titled “Hello from this machine”.";

const fence = (lang: string, text: string) => `\`\`\`${lang}\n${text}\n\`\`\``;

/** The setup notes for agents and curl (`/mcp` without text/html, and `/mcp.md`): every client,
 *  in the page's order. */
export function mcpMarkdown(baseUrl: string): string {
  const c = mcpCommands(baseUrl);
  const sections = [
    "# Waypoint MCP",
    "The local server reads files from this machine and writes them to Waypoint. Updates take effect the next time the agent starts the MCP server; configs never need changing.",
    `The agent's machine must be able to reach ${baseUrl}. If that address is on your tailnet, the machine must be on it too.`,
    "## 1. Add the Waypoint MCP server",
    "Claude Code:",
    fence("sh", c.claude.server),
    "Codex (`~/.codex/config.toml`):",
    fence("toml", c.codex.server),
    "Other MCP clients:",
    fence("json", c.other.server),
    "## 2. Add the Waypoint skill",
    "Claude Code:",
    fence("sh", c.claude.skill),
    "Codex:",
    fence("sh", c.codex.skill),
    `Other MCP clients: save ${c.skillUrl} wherever your client reads skills or instructions from.`,
    "## 3. Check that it works",
    "Start a new session on that machine and ask:",
    `> ${PROMPT}`,
    "## Troubleshooting",
    [
      "- Set up before the stable address? A config naming /mcp/waypoint-mcp-<hash>.tgz keeps running the old server until its npx cache entry is cleared. Replace it with the command above once.",
      "- Writer unreachable? The agent runs the last server it downloaded; waypoint_status says when an update is waiting.",
      "- Set WAYPOINT_MCP_PIN=embedded for debugging.",
    ].join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}

/** `?client=`: `json` (the earlier tab's value) is Other; anything unknown is Claude Code. */
export function mcpClient(value: string | undefined): McpClient {
  if (value === "codex" || value === "other") return value;
  return value === "json" ? "other" : "claude";
}

/** Display-only wrapping: a line per `.ln`, a token per `.tk` (never split), and every byte of the
 *  text kept as text, newlines inside their line, so the pre's textContent is the copied text. A
 *  line's leading whitespace sits inside its first token, so a phone never breaks a line after its
 *  indent (a blank-looking line) when the first token is wider than the block. */
function lines(text: string): Child[] {
  const all = text.split("\n");
  return all.map((line, index) => {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    const parts = line.slice(lead.length).split(/([ \t]+)/);
    return (
      <span class="ln">
        {parts[0] ? null : lead}
        {parts.map((part, i) => {
          if (i % 2) return part; // the whitespace between tokens, as is
          if (!part) return null;
          return <span class="tk">{i === 0 ? lead + part : part}</span>;
        })}
        {index < all.length - 1 ? "\n" : null}
      </span>
    );
  });
}

/** Visible "Copy"; the hidden suffix names what it copies, and the toast reads "Copied {what}". */
function CopyButton(props: { text: string; what: string }) {
  return (
    <button
      type="button"
      class="btn sm"
      data-action="copy-text"
      data-text={props.text}
      data-label={props.what}
    >
      {raw(icon("copy"))}
      <span>Copy</span>
      <span class="sr"> {props.what}</span>
    </button>
  );
}

function CodeBlock(props: { label: string; text: string; what: string; shell?: boolean }) {
  return (
    <div class="codeblock">
      <div class="cbh">
        <span>{props.label}</span>
        <CopyButton text={props.text} what={props.what} />
      </div>
      {/* Focusable, so a keyboard can scroll a block that is wider than a phone. */}
      <pre class={props.shell ? "sh" : undefined} tabindex={0}>
        {lines(props.text)}
      </pre>
    </div>
  );
}

const TABS: readonly (readonly [McpClient, string])[] = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["other", "Other MCP client"],
];
const SKILL_FOR: Record<McpClient, string> = {
  claude: "Claude Code",
  codex: "Codex",
  other: "your agent",
};

/** "host:devbox", or `host:"my box"` when the name has whitespace, as a `/?q=` link. */
function hostHref(host: string): string {
  // Known limitation: parseSearch has no escape inside quotes, so a name with whitespace and `"`
  // can't round-trip.
  const value = /\s/.test(host) ? `"${host}"` : host;
  return `/?${new URLSearchParams({ q: `host:${value}` }).toString()}`;
}

/** The Connect an agent page body: three steps for the chosen client, then the machines and
 *  troubleshooting. Pure, so tests render it without a writer. */
export function McpBody(props: {
  baseUrl: string;
  client: McpClient;
  hosts: Facets["hosts"];
  now: number;
  bundle: string | null;
}) {
  const commands = mcpCommands(props.baseUrl);
  const { client } = props;
  const chosen = commands[client];
  return (
    <main class="wrap narrow mcp" id="main">
      <div class="ph">
        <div>
          <h1>Connect an agent</h1>
          <p>
            Agents publish to Waypoint through a small MCP server. Set it up once per machine. It
            updates itself on every session start.
          </p>
        </div>
      </div>
      <p class="req">
        The agent's machine must be able to reach <span class="mono">{props.baseUrl}</span>. If that
        address is on your tailnet, the machine must be on it too.
      </p>
      <ol class="steps">
        <li>
          <h2>Add the Waypoint MCP server</h2>
          <nav class="tabs2" aria-label="Agent">
            {TABS.map(([id, label]) => (
              <a href={`/mcp?client=${id}`} aria-current={id === client ? "page" : undefined}>
                {label}
              </a>
            ))}
          </nav>
          {client === "claude" ? (
            <CodeBlock
              label="Run in a terminal on that machine"
              text={chosen.server}
              what="Claude Code command"
              shell
            />
          ) : client === "codex" ? (
            <CodeBlock
              label="Add to ~/.codex/config.toml on that machine"
              text={chosen.server}
              what="Codex config"
            />
          ) : (
            <CodeBlock
              label="Add to your MCP client's configuration (JSON)"
              text={chosen.server}
              what="MCP client config"
            />
          )}
        </li>
        <li>
          <h2>Add the Waypoint skill, so {SKILL_FOR[client]} knows how to publish</h2>
          {client === "other" ? (
            <>
              <CodeBlock label="The skill file" text={chosen.skill} what="skill URL" />
              <p class="note">
                Other clients: save this file wherever your client reads skills or instructions
                from.
              </p>
            </>
          ) : (
            <>
              <CodeBlock
                label="Run in a terminal on that machine"
                text={chosen.skill}
                what="skill command"
                shell
              />
              <p class="note">
                {client === "claude" ? (
                  <>
                    This tab installs it for Claude Code only. The Codex tab shows the{" "}
                    <span class="mono">~/.codex/skills</span> command.
                  </>
                ) : (
                  <>
                    This tab installs it for Codex only. The Claude Code tab shows the{" "}
                    <span class="mono">~/.claude/skills</span> command.
                  </>
                )}
              </p>
            </>
          )}
        </li>
        <li>
          <h2>Check that it works</h2>
          <p>Start a new session on that machine and ask:</p>
          <div class="ask">
            <q>{PROMPT}</q>
            <CopyButton text={PROMPT} what="prompt" />
          </div>
          <p class="note">
            It appears at the top of <a href="/">Recent</a> within a few seconds, and the machine
            joins the list below.
          </p>
        </li>
      </ol>
      <h2 class="sec">Machines that have published</h2>
      {props.hosts.length ? (
        <ul class="hosts">
          {props.hosts.map((host) => (
            <li>
              <a href={hostHref(host.value)}>
                <span class="mono">{host.value}</span>
                <span class="m">
                  {host.count === 1 ? "1 revision" : `${host.count} revisions`} · last{" "}
                  <Time at={host.last_written_at} fmt="ago" now={props.now} />
                </span>
                <span class="go">
                  See its collections <span aria-hidden="true">›</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <div class="rows">
          <div class="empty">No machine has published yet.</div>
        </div>
      )}
      <details class="tr">
        <summary>Troubleshooting</summary>
        <ul>
          <li>
            <b>Set up before the stable address?</b> A config naming{" "}
            <span class="mono">/mcp/waypoint-mcp-&lt;hash&gt;.tgz</span> keeps running the old
            server until its npx cache entry is cleared. Replace it with the command above once.
          </li>
          <li>
            <b>Writer unreachable?</b> The agent runs the last server it downloaded;{" "}
            <span class="mono">waypoint_status</span> says when an update is waiting.
          </li>
          <li>
            {props.bundle ? (
              <>
                Server bundle <span class="mono">{props.bundle}</span> ·{" "}
              </>
            ) : null}
            launcher API {MCP_LAUNCHER_API} · <a href="/mcp.md">Raw setup notes (markdown)</a> · Set{" "}
            <span class="mono">WAYPOINT_MCP_PIN=embedded</span> for debugging.
          </li>
        </ul>
      </details>
    </main>
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
  return noStore(
    c.html(
      <Layout title="Connect an agent" chrome={chrome} bar={<HomeBar chrome={chrome} />} page="mcp">
        <McpBody
          baseUrl={s.reads.baseUrl}
          client={mcpClient(c.req.query("client"))}
          hosts={facets.hosts}
          now={now}
          bundle={bundle}
        />
      </Layout>,
    ),
  );
}
