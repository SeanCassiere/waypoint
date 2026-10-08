FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS base
RUN corepack enable
ENV TURBO_TELEMETRY_DISABLED=1

# The writer, the MCP bundles and the workspace packages they use, with the lockfile cut down to
# them (`turbo prune --docker`): json/ holds the manifests and lockfile, full/ the sources. Uses
# the turbo version pinned in the root package.json.
FROM base AS prune
WORKDIR /src
COPY . .
RUN pnpm dlx "turbo@$(node -p 'require("./package.json").devDependencies.turbo')" \
    prune @waypoint/writer @waypoint/mcp --docker --out-dir /pruned

FROM base AS build
WORKDIR /src
# Manifests and lockfile first, so the install layer is reused until dependencies change.
COPY --from=prune /pruned/json/ ./
RUN pnpm install --frozen-lockfile
COPY --from=prune /pruned/full/ ./
# The MCP build puts LICENSE and THIRD_PARTY_NOTICES.md in the server bundle and launcher package.
COPY tsconfig.base.json .node-version LICENSE THIRD_PARTY_NOTICES.md ./
# Turborepo builds the writer, the MCP bundles and their workspace dependencies. The image is
# always built from source: `--cache=local:,remote:` turns off both the local and the remote
# cache, whatever TURBO_* variables or config the build environment has. `pnpm deploy` then
# keeps the writer's bundle (dist/, its `files`) and its production npm dependencies; the
# workspace packages are inlined in the bundle.
RUN pnpm exec turbo run build --filter=@waypoint/writer --filter=@waypoint/mcp --cache=local:,remote: \
    && pnpm --filter @waypoint/writer deploy --prod --legacy /out

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
# The base image's `node` user is uid/gid 1000, which must own the bind-mounted data dir.
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/ ./
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/waypoint-mcp.tgz /app/static/waypoint-mcp.tgz
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/launcher.mjs /app/static/launcher.mjs
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/waypoint-mcp-server.mjs /app/static/waypoint-mcp-server.mjs
COPY --chown=1000:1000 skills/waypoint/SKILL.md /app/static/skills/waypoint/SKILL.md
# Waypoint's license, and the notices (with full license texts) of the third-party code the MCP
# bundles inline (the npm dependencies under node_modules/ carry their own).
COPY --chown=1000:1000 LICENSE THIRD_PARTY_NOTICES.md /app/
LABEL org.opencontainers.image.licenses="MIT"
# The git commit the image is built from, reported on /healthz and /status. Optional: an image
# built without it reports `"sha": null`. Declared late, so a new commit reuses the build layers.
ARG WAYPOINT_BUILD_SHA=""
ENV WAYPOINT_BUILD_SHA=$WAYPOINT_BUILD_SHA
ENV NODE_ENV=production WAYPOINT_MCP_TARBALL=/app/static/waypoint-mcp.tgz WAYPOINT_MCP_LAUNCHER=/app/static/launcher.mjs WAYPOINT_MCP_SERVER=/app/static/waypoint-mcp-server.mjs WAYPOINT_MCP_SKILL=/app/static/skills/waypoint/SKILL.md
USER 1000:1000
EXPOSE 7410
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e 'fetch("http://127.0.0.1:7410/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js", "serve"]
