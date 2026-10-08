# Third-party notices

Waypoint is MIT-licensed ([LICENSE](LICENSE)). Some of what it distributes contains third-party
code, all under permissive licenses (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Apache-2.0). No
copyleft (GPL, LGPL, AGPL) or unlicensed package is shipped.

## What ships where

- **The writer image** (`ghcr.io/seancassiere/waypoint-writer`) installs the writer's production
  npm dependencies unmodified in `node_modules/`, each with its own license file. Only Waypoint's
  own packages (`@waypoint/*`) are inlined into the writer bundle. The image's base layers are the
  official `node` Debian image, under its own licenses.
- **The public reader Worker** (`apps/reader/dist/index.js`, and `reader/index.js` in each release
  bundle) inlines:

  | Package | License | Copyright |
  |---|---|---|
  | `hono` | MIT | (c) 2021 - present, Yusuke Wada and Hono contributors |
  | `@tursodatabase/serverless` | MIT | Turso (tursodatabase) |
  | `aws4fetch` | MIT | 2018 Michael Hart |

- **The MCP server bundle** (`/mcp/server.mjs` on a writer) and **the MCP launcher**
  (`/mcp/waypoint-mcp.tgz`) inline:

  | Package | License | Copyright |
  |---|---|---|
  | `@modelcontextprotocol/sdk` | MIT | (c) 2024 Anthropic, PBC |
  | `zod` | MIT | (c) 2025 Colin McDonnell |
  | `zod-to-json-schema` | ISC | (c) 2020, Stefan Terdell |
  | `ajv`, `ajv-formats`, `fast-deep-equal`, `json-schema-traverse` | MIT | (c) 2015-2021 Evgeny Poberezkin |
  | `fast-uri` | BSD-3-Clause | (c) 2011-2021, Gary Court; Fastify contributors |
  | `typeid-js` | Apache-2.0 | Jetify |
  | `uuid` | MIT | (c) 2010-2020 Robert Kieffer and other contributors |

Each package's full license text is in its published npm package. The permission notices of the
MIT, ISC and BSD licenses, and the Apache License 2.0, apply to the copies inlined above.

## Checking it again

After a dependency change, list the licenses of what can ship:

```bash
pnpm -r licenses list --prod                  # the writer's and the reader's runtime dependencies
pnpm --filter @waypoint/mcp licenses list     # the MCP bundles inline their devDependencies
```

and update this file if a bundle inlines a new package, or if anything isn't permissive.
