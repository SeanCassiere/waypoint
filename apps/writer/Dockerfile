FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/writer/package.json apps/writer/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/render/package.json packages/render/package.json
COPY packages/mcp/package.json packages/mcp/package.json
RUN pnpm install --frozen-lockfile
COPY tsconfig*.json ./
COPY apps/writer apps/writer
COPY packages packages
COPY skills/waypoint/SKILL.md skills/waypoint/SKILL.md
RUN pnpm build && pnpm --filter @waypoint/writer deploy --prod --legacy /out

FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
# The base image's `node` user is uid/gid 1000, matching agent-1's owner of the bind-mounted data dir.
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/ ./
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/waypoint-mcp.tgz /app/static/waypoint-mcp.tgz
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/launcher.mjs /app/static/launcher.mjs
COPY --from=build --chown=1000:1000 /src/packages/mcp/dist/waypoint-mcp-server.mjs /app/static/waypoint-mcp-server.mjs
COPY --from=build --chown=1000:1000 /src/skills/waypoint/SKILL.md /app/static/skills/waypoint/SKILL.md
ENV NODE_ENV=production WAYPOINT_MCP_TARBALL=/app/static/waypoint-mcp.tgz WAYPOINT_MCP_LAUNCHER=/app/static/launcher.mjs WAYPOINT_MCP_SERVER=/app/static/waypoint-mcp-server.mjs WAYPOINT_MCP_SKILL=/app/static/skills/waypoint/SKILL.md
USER 1000:1000
EXPOSE 7410
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 CMD node -e 'fetch("http://127.0.0.1:7410/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js", "serve"]
