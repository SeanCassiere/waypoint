// The golden renderer fixture. Its rendered output hashes to GOLDEN_HASH; any change to that
// needs a RENDERER_VERSION bump (see src/render.ts). Also checked against the built package and
// the writer's bundle (tests/built-renderer.test.ts at the repository root).

/** SHA-256 of every golden input's rendered HTML, in order. */
export const GOLDEN_HASH = "7277152229f0f7c7aa8a1d1f4df263d2fd963ebab5b0dd014e22cbcc64a0d055";

/** Markdown sources and title overrides (`null`: none) covering every renderer feature. */
export function goldenInputs(): Array<[string, string | null]> {
  const languages = [
    "typescript",
    "javascript",
    "tsx",
    "jsx",
    "json",
    "bash",
    "python",
    "go",
    "rust",
    "sql",
    "yaml",
    "toml",
    "html",
    "css",
    "diff",
    "markdown",
    "dockerfile",
  ];
  const fences = languages
    .map((language) => `\`\`\`${language}\nconst value = 1\n\`\`\``)
    .join("\n\n");
  const alerts = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]
    .map((kind) => `> [!${kind}]\n> ${kind} body.`)
    .join("\n\n");
  const sections = ["One", "Two", "Three", "Four"]
    .map((name) => `## ${name}\n\nText with \`code\`.`)
    .join("\n\n");
  const fixture = `---\ntitle: Test\n---\n# Golden &amp; title\n# Golden &amp; title\n\n${sections}\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~old~~ https://example.com\n\nNote[^1].\n\n[^1]: Footnote.\n\n<aside>Raw</aside>\n\n${alerts}\n\n> Quote\n\n![Figure](./figure.png)\n\n${fences}\n\n\`\`\`oddlang\nx\n\`\`\`\n\n\`\`\`mermaid\ngraph TD; A-->B\n\`\`\``;
  return [
    [fixture, null],
    [fixture, " Golden override "],
    ["x".repeat(1_000_001), null],
    [">".repeat(101), null],
  ];
}
