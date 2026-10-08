import { describe, expect, it } from "vitest";

import {
  McpBody,
  mcpClient,
  mcpCommands,
  mcpMarkdown,
  type McpClient,
} from "../src/viewer/pages/mcp.tsx";

const base = "http://127.0.0.1:7421";
const now = Date.UTC(2026, 9, 9, 12);
const hosts = [
  { value: "devbox", count: 12, last_written_at: now - 2 * 3600_000 },
  { value: "my laptop", count: 1, last_written_at: now - 3 * 3600_000 },
];

/** hono/jsx escapes &, <, >, " and '; tests compare decoded values. */
function decode(html: string): string {
  return html
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}
const text = (html: string): string => decode(html.replace(/<[^>]*>/g, ""));

async function render(client: McpClient): Promise<string> {
  return String(await McpBody({ baseUrl: base, client, hosts, now, bundle: "abc1234" }));
}
/** Each code block's copied text, its pre's markup and its Copy button's suffix and label. */
function codeBlocks(html: string) {
  return [
    ...html.matchAll(
      /<div class="codeblock"><div class="cbh"><span>([^<]*)<\/span>.*?data-text="([^"]*)" data-label="([^"]*)">.*?<span class="sr"> ([^<]*)<\/span><\/button><\/div><pre( class="sh")? tabindex="0">(.*?)<\/pre>/gs,
    ),
  ].map(([, header, data, label, what, sh, pre]) => ({
    header: decode(header!),
    text: decode(data!),
    label: decode(label!),
    what: decode(what!),
    sh: !!sh,
    pre: pre!,
  }));
}

describe("mcpCommands", () => {
  const commands = mcpCommands(base);
  it("matches the command snapshot", () => {
    expect(commands).toMatchInlineSnapshot(`
      {
        "claude": {
          "server": "claude mcp add waypoint --env WAYPOINT_URL=http://127.0.0.1:7421 -- npx --prefer-offline -y http://127.0.0.1:7421/mcp/waypoint-mcp.tgz",
          "skill": "mkdir -p ~/.claude/skills/waypoint && curl -fsSL http://127.0.0.1:7421/mcp/skill/SKILL.md -o ~/.claude/skills/waypoint/SKILL.md",
        },
        "codex": {
          "server": "[mcp_servers.waypoint]
      command = "npx"
      args = ["--prefer-offline", "-y", "http://127.0.0.1:7421/mcp/waypoint-mcp.tgz"]
      [mcp_servers.waypoint.env]
      WAYPOINT_URL = "http://127.0.0.1:7421"",
          "skill": "mkdir -p ~/.codex/skills/waypoint && curl -fsSL http://127.0.0.1:7421/mcp/skill/SKILL.md -o ~/.codex/skills/waypoint/SKILL.md",
        },
        "other": {
          "server": "{
        "mcpServers": {
          "waypoint": {
            "command": "npx",
            "args": [
              "--prefer-offline",
              "-y",
              "http://127.0.0.1:7421/mcp/waypoint-mcp.tgz"
            ],
            "env": {
              "WAYPOINT_URL": "http://127.0.0.1:7421"
            }
          }
        }
      }",
          "skill": "http://127.0.0.1:7421/mcp/skill/SKILL.md",
        },
        "skillUrl": "http://127.0.0.1:7421/mcp/skill/SKILL.md",
      }
    `);
  });
  it("keeps the Claude Code command and the Codex TOML byte for byte", () => {
    expect(commands.claude.server).toBe(
      `claude mcp add waypoint --env WAYPOINT_URL=${base} -- npx --prefer-offline -y ${base}/mcp/waypoint-mcp.tgz`,
    );
    expect(commands.codex.server).toMatchInlineSnapshot(`
      "[mcp_servers.waypoint]
      command = "npx"
      args = ["--prefer-offline", "-y", "http://127.0.0.1:7421/mcp/waypoint-mcp.tgz"]
      [mcp_servers.waypoint.env]
      WAYPOINT_URL = "http://127.0.0.1:7421""
    `);
  });
  it("pretty-prints Other's JSON", () => {
    expect(JSON.parse(commands.other.server)).toEqual({
      mcpServers: {
        waypoint: {
          command: "npx",
          args: ["--prefer-offline", "-y", `${base}/mcp/waypoint-mcp.tgz`],
          env: { WAYPOINT_URL: base },
        },
      },
    });
    expect(commands.other.server).toContain("\n  ");
  });
  it("installs the skill for the chosen client only", () => {
    expect(commands.claude.skill).toBe(
      `mkdir -p ~/.claude/skills/waypoint && curl -fsSL ${base}/mcp/skill/SKILL.md -o ~/.claude/skills/waypoint/SKILL.md`,
    );
    expect(commands.claude.skill).not.toContain(".codex");
    expect(commands.codex.skill).toContain("~/.codex/skills/waypoint");
    expect(commands.codex.skill).not.toContain(".claude");
    expect(commands.other.skill).toBe(commands.skillUrl);
    expect(commands.skillUrl).toBe(`${base}/mcp/skill/SKILL.md`);
  });
});

describe("mcpMarkdown", () => {
  const markdown = mcpMarkdown(base);
  it("follows the page's order and shows every client", () => {
    expect(markdown.startsWith("# Waypoint MCP")).toBe(true);
    const headings = [
      "## 1. Add the Waypoint MCP server",
      "## 2. Add the Waypoint skill",
      "## 3. Check that it works",
      "## Troubleshooting",
    ].map((heading) => markdown.indexOf(`\n${heading}\n`));
    expect(headings.every((at) => at > 0)).toBe(true);
    expect(headings.toSorted((a, b) => a - b)).toEqual(headings);
    expect(markdown.match(/--prefer-offline/g)).toHaveLength(3);
    expect(markdown).toContain("~/.claude/skills/waypoint/SKILL.md");
    expect(markdown).toContain("~/.codex/skills/waypoint/SKILL.md");
    expect(markdown).toContain("WAYPOINT_MCP_PIN=embedded");
    expect(markdown).toContain(mcpCommands(base).other.server);
    expect(markdown).not.toMatch(/waypoint-mcp-[a-f0-9]{12}\.tgz/);
  });
});

describe("McpBody", () => {
  const suffixes: Record<McpClient, string[]> = {
    claude: [" Claude Code command", " skill command", " prompt"],
    codex: [" Codex config", " skill command", " prompt"],
    other: [" MCP client config", " skill URL", " prompt"],
  };
  // The pinned per-tab strings: step 2's client, its hint (as rendered markup) and the block headers.
  const pinned: Record<McpClient, { who: string; hint: string; headers: string[] }> = {
    claude: {
      who: "Claude Code",
      hint: 'This tab installs it for Claude Code only. The Codex tab shows the <span class="mono">~/.codex/skills</span> command.',
      headers: ["Run in a terminal on that machine", "Run in a terminal on that machine"],
    },
    codex: {
      who: "Codex",
      hint: 'This tab installs it for Codex only. The Claude Code tab shows the <span class="mono">~/.claude/skills</span> command.',
      headers: ["Add to ~/.codex/config.toml on that machine", "Run in a terminal on that machine"],
    },
    other: {
      who: "your agent",
      hint: "Other clients: save this file wherever your client reads skills or instructions from.",
      headers: ["Add to your MCP client's configuration (JSON)", "The skill file"],
    },
  };
  it.each(["claude", "codex", "other"] as const)("renders the %s tab", async (client) => {
    const html = await render(client);
    // Step order.
    const steps = /<ol class="steps">(.*?)<\/ol>/s.exec(html)?.[1] ?? "";
    expect(steps.match(/<li>/g)).toHaveLength(3);
    const headings = [...steps.matchAll(/<h2>(.*?)<\/h2>/gs)].map(([, h]) => text(h!));
    expect(headings).toHaveLength(3);
    expect(headings[0]).toBe("Add the Waypoint MCP server");
    expect(headings[1]).toMatch(/^Add the Waypoint skill, so /);
    expect(headings[1]).toBe(
      `Add the Waypoint skill, so ${pinned[client].who} knows how to publish`,
    );
    expect(html).toContain(`<p class="note">${pinned[client].hint}</p>`);
    expect(headings[2]).toBe("Check that it works");
    expect(html).toContain(`href="/mcp?client=${client}" aria-current="page"`);

    // Copy button labels, in document order; each label is its suffix, trimmed.
    const buttons = [
      ...html.matchAll(
        /data-action="copy-text" data-text="[^"]*" data-label="([^"]*)">.*?<span class="sr">([^<]*)<\/span>/gs,
      ),
    ];
    expect(buttons.map(([, , what]) => what)).toEqual(suffixes[client]);
    for (const [, label, what] of buttons) expect(label).toBe(what!.trim());

    // The pre's text is the copied text, byte for byte; only shell blocks get the (CSS) prompt.
    const blocks = codeBlocks(html);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.header)).toEqual(pinned[client].headers);
    for (const block of blocks) {
      expect(text(block.pre)).toBe(block.text);
      expect(text(block.pre)).not.toContain("$");
      expect(block.pre).toMatch(/^<span class="ln"><span class="tk">/);
    }
    expect(blocks.map((block) => block.sh)).toEqual(
      client === "claude" ? [true, true] : client === "codex" ? [false, true] : [false, false],
    );

    // Machines: links to a host search, quoted when the name has a space.
    const list = /<ul class="hosts">(.*?)<\/ul>/s.exec(html)?.[1] ?? "";
    const links = [...list.matchAll(/<li><a href="([^"]*)">(.*?)<\/a><\/li>/gs)];
    expect(links.map(([, href]) => decode(href!))).toEqual([
      "/?q=host%3Adevbox",
      "/?q=host%3A%22my+laptop%22",
    ]);
    expect(text(links[0]![2]!)).toContain("12 revisions · last");
    expect(text(links[0]![2]!)).toContain("See its collections ›");
    expect(text(links[1]![2]!)).toContain("1 revision · last");
    expect(links[0]![2]).toContain('<span aria-hidden="true">›</span>');

    // Troubleshooting.
    const details = /<details class="tr">(.*?)<\/details>/s.exec(html)?.[1] ?? "";
    expect(/<summary>(.*?)<\/summary>/.exec(details)?.[1]).toBe("Troubleshooting");
    expect(details).toContain("WAYPOINT_MCP_PIN=embedded");
    expect(details).toContain("abc1234");
    expect(details).toContain("/mcp/waypoint-mcp-&lt;hash&gt;.tgz");
  });
  it("installs only the chosen client's skill", async () => {
    const [, codexSkill] = codeBlocks(await render("codex"));
    expect(codexSkill!.text).toContain(".codex/skills");
    expect(codexSkill!.text).not.toContain(".claude/skills");
    const [, claudeSkill] = codeBlocks(await render("claude"));
    expect(claudeSkill!.text).toContain(".claude/skills");
    expect(claudeSkill!.text).not.toContain(".codex/skills");
    const [, otherSkill] = codeBlocks(await render("other"));
    expect(otherSkill!.text).toBe(`${base}/mcp/skill/SKILL.md`);
  });
  it("keeps an indented line's indent with its first token, so it never wraps alone", async () => {
    const [json] = codeBlocks(await render("other"));
    expect(json!.pre).toContain(
      `<span class="ln"><span class="tk">        &quot;${base}/mcp/waypoint-mcp.tgz&quot;</span>\n</span>`,
    );
    expect(json!.pre).not.toMatch(/<span class="ln"> /);
  });
  it("keeps the empty state when no machine has published", async () => {
    const html = String(
      await McpBody({ baseUrl: base, client: "claude", hosts: [], now, bundle: null }),
    );
    expect(html).toContain("No machine has published yet.");
    expect(html).not.toContain('<ul class="hosts">');
    expect(html).not.toContain("Server bundle");
  });
});

describe("mcpClient", () => {
  it("accepts today's json as Other and falls back to Claude Code", () => {
    expect(mcpClient("json")).toBe("other");
    expect(mcpClient("other")).toBe("other");
    expect(mcpClient("codex")).toBe("codex");
    expect(mcpClient("claude")).toBe("claude");
    expect(mcpClient("vim")).toBe("claude");
    expect(mcpClient(undefined)).toBe("claude");
  });
});
