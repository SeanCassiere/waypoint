// The text and CSV renderers' golden fixtures. Their rendered output hashes to TEXT_GOLDEN_HASH
// and CSV_GOLDEN_HASH: any change to this hash needs a TEXT_/CSV_RENDERER_VERSION bump (see
// src/text.ts and src/csv.ts). Also checked against the built package and the writer's bundle
// (tests/built-renderer.test.ts at the repository root). The drain script, metrics JSON and
// results CSV are the RX-08 mockups' files, shared with the browser scenarios.

/** SHA-256 of every text golden input's rendered HTML (the literal `null` for null), in order. */
export const TEXT_GOLDEN_HASH = "434de6b09ca4d4da52bb4875d1385330b8420fb86f4228b26721446071bc3b3b";
/** SHA-256 of every CSV golden input's rendered HTML (the literal `null` for null), in order. */
export const CSV_GOLDEN_HASH = "9ac580c516e9c45dea62895762d7cf909c8e2cea627ff67a44c67046fccfea96";

/** The mockup's shell script: 37 lines, 1,094 bytes. */
export const DRAIN_SCRIPT: string =
  [
    "#!/usr/bin/env bash",
    "# Pause PgBouncer, wait for in-flight transactions, then hand over to pg_upgrade.",
    "# Run from the bastion as the admin user. Safe to re-run: every step checks state first.",
    "set -euo pipefail",
    "",
    'PGB_HOST="${PGB_HOST:-pgbouncer}"',
    'PGB_PORT="${PGB_PORT:-6432}"',
    'DB="app"',
    "DRAIN_TIMEOUT=120   # seconds to wait for active server connections to finish",
    "",
    'log() { echo "[$(date -u +%H:%M:%S)] $*"; }',
    "",
    "pgb() {",
    '  psql -h "$PGB_HOST" -p "$PGB_PORT" -U admin pgbouncer -tAc "$1"',
    "}",
    "",
    'log "Pausing $DB on $PGB_HOST:$PGB_PORT"',
    'pgb "PAUSE $DB;"',
    "",
    "# PAUSE returns once clients are queued; server connections may still be busy.",
    'for i in $(seq 1 "$DRAIN_TIMEOUT"); do',
    '  active=$(pgb "SHOW SERVERS;" | awk -F\'|\' -v db="$DB" \'$2 == db && $4 == "active"\' | wc -l)',
    '  if [ "$active" -eq 0 ]; then',
    '    log "Drained after ${i}s"',
    "    break",
    "  fi",
    "  sleep 1",
    "done",
    "",
    'if [ "$active" -ne 0 ]; then',
    '  log "Still $active active connections after ${DRAIN_TIMEOUT}s; resuming and aborting"',
    '  pgb "RESUME $DB;"',
    "  exit 1",
    "fi",
    "",
    'log "Paused. Clients are queued, not refused. Run pg_upgrade now, then:"',
    "log \"  pgb 'RESUME $DB;'\"",
  ].join("\n") + "\n";

/** The mockup's metrics JSON, minified: one 570-byte line (with its newline), 50 lines formatted. */
export const METRICS_JSON: string =
  '{"run":"2026-10-06T21:14:03Z","model":"rerank-v4","baseline":"bm25+rules","queries":1200,"metrics":{"ndcg@10":{"baseline":0.412,"candidate":0.468,"delta":0.056},"mrr@10":{"baseline":0.377,"candidate":0.431,"delta":0.054},"recall@50":{"baseline":0.781,"candidate":0.804,"delta":0.023},"p95_latency_ms":{"baseline":38,"candidate":61,"delta":23}},"slices":[{"name":"navigational","queries":410,"ndcg_delta":0.012},{"name":"long-tail","queries":520,"ndcg_delta":0.091},{"name":"misspelled","queries":270,"ndcg_delta":0.047}],"regressions":["q-0193","q-0877"],"passed":true}' +
  "\n";

const QUERIES = [
  "refund policy for annual plan",
  "how to rotate api keys",
  "webhook retry schedule",
  "export invoices csv",
  "sso with okta",
  "rate limit headers",
  "delete workspace",
  "change billing email",
  "audit log retention",
  "2fa recovery codes",
  "ip allowlist",
  "custom domain ssl",
  "pagination cursor",
  "data residency eu",
];

/** An evaluation results file: a header and `rows` data rows (the demo fixture has 1,284). */
export function resultsCsv(rows = 1284): string {
  const lines = ["query_id,query,ndcg@10,mrr,recall@50,latency_ms"];
  for (let i = 1; i <= rows; i++)
    lines.push(
      [
        `q-${String(i).padStart(4, "0")}`,
        QUERIES[(i - 1) % QUERIES.length],
        (0.6 + ((i * 37) % 400) / 1000).toFixed(3),
        (0.55 + ((i * 53) % 400) / 1000).toFixed(3),
        (0.8 + ((i * 29) % 200) / 1000).toFixed(3),
        String(30 + ((i * 7) % 30)),
      ].join(","),
    );
  return `${lines.join("\n")}\n`;
}

/** A log of 40 short lines and one 5,000-character line (41 lines). */
export function bigLog(): string {
  const lines = Array.from(
    { length: 40 },
    (_, n) =>
      `2026-10-06T21:14:${String(n % 60).padStart(2, "0")}Z INFO request id=${n + 1} status=200`,
  );
  lines.push("2026-10-06T21:15:00Z WARN payload=".padEnd(5000, "ab"));
  return `${lines.join("\n")}\n`;
}

/** Controls, bidi overrides and markup that must come out escaped and marked. */
export const TROJAN_JS =
  'const s = "</pre><script>alert(1)</script>";\n// \u202E}\u202C {\n\u200B\u0000x\ry\n';

/** Text sources and their MIME types, covering every feature of the text view. */
export function textGoldenInputs(): Array<[string, string]> {
  const samples: Array<[string, string]> = [
    ["echo hi\n", "text/x-shellscript"],
    ['{"a": [1, true, null]}\n', "application/json"],
    ['{"a":1}\n', "application/ld+json"],
    ['{"a":1}\n{"b":2}\n', "application/ndjson"],
    ["const x = 1;\n", "application/javascript"],
    ["let y: number = 2;\n", "text/typescript"],
    ["def f():\n    return 1\n", "text/x-python"],
    ["a: 1\nb: [x, y]\n", "application/yaml"],
    ["a: 1\n", "text/yaml"],
    ['[table]\nkey = "value"\n', "application/toml"],
    ["--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n", "text/x-diff"],
    ["body { color: red }\n", "text/css"],
    ["package main\n\nfunc main() {}\n", "text/x-go"],
    ["fn main() {}\n", "text/x-rust"],
    ["SELECT 1 FROM t WHERE a = 'b';\n", "text/x-sql"],
    ["FROM node:24\nRUN echo hi\n", "text/x-dockerfile"],
    ["<a><b>1</b></a>\n", "application/xml"],
    ["<feed/>\n", "application/atom+xml"],
    ["plain words\n", "text/plain"],
    ["other words\n", "text/x-unknown"],
  ];
  return [
    [DRAIN_SCRIPT, "text/x-shellscript"],
    [METRICS_JSON, "application/json"],
    ['{\n  "a": 1\n}\n', "application/json"],
    [
      `{"n":12345678901234567890,"s":"\\u00e9","k":1,"k":2,"pad":"${"p".repeat(200)}"}`,
      "application/json",
    ],
    [
      '{"id":1,"kind":"deploy"}\n{"id":2,"kind":"build"}\n{"id":3,"kind":"test"}\n',
      "application/x-ndjson",
    ],
    [bigLog(), "text/plain"],
    [TROJAN_JS, "text/javascript"],
    ["\uFEFFa\r\nb\r\n", "text/plain"],
    ["", "text/plain"],
    [Array.from({ length: 6000 }, (_, i) => `x_${i} = ${i}`).join("\n") + "\n", "text/x-python"],
    ...samples,
    ["x".repeat(2_097_153), "text/plain"],
    ["a\n".repeat(50_001), "text/plain"],
  ];
}

/** CSV and TSV sources and their MIME types, covering every feature of the table view. */
export function csvGoldenInputs(): Array<[string, string]> {
  return [
    [resultsCsv(), "text/csv"],
    ['name,note\n"Smith, J.","said ""hi""\nthen left"\nLee,ok\n', "text/csv"],
    ["a,b,c\n1\n2,3\n4,5,6,7\n", "text/csv"],
    ["region\trequests\nwest\t12\neast\t34\n", "text/tab-separated-values"],
    ['a,b\n"unterminated,1\n', "text/csv"],
    ["name,value\n\u202Eevil,</td><script>alert(1)</script>\n", "text/csv"],
    ["only,a,header\n", "text/csv"],
    ["", "text/csv"],
    [`long\n${"y".repeat(70_000)}\n`, "text/csv"],
    [`big\n${"z".repeat(2_097_148)}\n`, "text/csv"],
  ];
}
