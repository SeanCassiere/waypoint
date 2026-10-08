# Changelog

## 0.1.0 (2026-10-08)


### Features

* collection search, identifier lookup, and revision watching for agent handoff ([#13](https://github.com/SeanCassiere/waypoint/issues/13)) ([bd3537f](https://github.com/SeanCassiere/waypoint/commit/bd3537f63e155d7354ba9cd23e14a59325e1840b))
* decouple runtime config from the owner's deployment (S3 endpoint, local-only prod, version reporting) ([#28](https://github.com/SeanCassiere/waypoint/issues/28)) ([25c9edf](https://github.com/SeanCassiere/waypoint/commit/25c9edfaa41ffbfe0ffdccd593d0cc735d0a8471))
* **deploy:** Docker image, Tailscale sidecar, health-gated deploys ([#8](https://github.com/SeanCassiere/waypoint/issues/8)) ([9d15768](https://github.com/SeanCassiere/waypoint/commit/9d15768475013a42eb642c29f2e0e74b80e57e0d))
* **deploy:** generic upgrade.sh, instance config, compose files, generated reader config, install test ([#29](https://github.com/SeanCassiere/waypoint/issues/29)) ([e8593be](https://github.com/SeanCassiere/waypoint/commit/e8593be7c431578aa26225a9c7a4abff8b512561))
* Folio, the redesigned Waypoint UI (writer, renditions v2, public reader) ([#19](https://github.com/SeanCassiere/waypoint/issues/19)) ([f056085](https://github.com/SeanCassiere/waypoint/commit/f056085e4db536b6c66553cc203c34f4df8bc34a))
* **mcp:** stable self-updating launcher; agent docs and Waypoint skill ([#11](https://github.com/SeanCassiere/waypoint/issues/11)) ([1c418e3](https://github.com/SeanCassiere/waypoint/commit/1c418e39c2fceeec3fd0813c2288312c4dc44370))
* **mcp:** stdio MCP server for agents, served by the writer ([#6](https://github.com/SeanCassiere/waypoint/issues/6)) ([2e1514c](https://github.com/SeanCassiere/waypoint/commit/2e1514c230509235e50ad1a0b24e0de12426a5c4))
* phase 2: share links and the public read-only reader on Cloudflare Workers ([#17](https://github.com/SeanCassiere/waypoint/issues/17)) ([278c9b6](https://github.com/SeanCassiere/waypoint/commit/278c9b6046a2c899652b38904373288feaf1a544))
* **render:** deterministic markdown renditions ([#4](https://github.com/SeanCassiere/waypoint/issues/4)) ([75cdaea](https://github.com/SeanCassiere/waypoint/commit/75cdaeacad0483ed1bfa81a322eafeb418d7b9e8))
* **viewer:** owner feedback 1: calm motion, light-dismiss popovers, copyable public URLs ([#24](https://github.com/SeanCassiere/waypoint/issues/24)) ([186a70e](https://github.com/SeanCassiere/waypoint/commit/186a70ee93931885ab08c1be855c0cf1f7336b9e))
* **viewer:** server-rendered viewer UI on the writer ([#7](https://github.com/SeanCassiere/waypoint/issues/7)) ([96a3b22](https://github.com/SeanCassiere/waypoint/commit/96a3b2220431cd9380c7a11bfbdc1f04c3e850a5))
* workspace scaffold, CI, and @waypoint/core ([#3](https://github.com/SeanCassiere/waypoint/issues/3)) ([5b7ca0a](https://github.com/SeanCassiere/waypoint/commit/5b7ca0ad7145f651365d6545d9b530c734700c5d))
* **writer:** committer, R2 bucket, Turso Sync loop, purge, restore ([#9](https://github.com/SeanCassiere/waypoint/issues/9)) ([7df9fe5](https://github.com/SeanCassiere/waypoint/commit/7df9fe5799d57763d24b81e19be692e6318c60c1))
* **writer:** storage, queue, ingest, read model, and HTTP API ([#5](https://github.com/SeanCassiere/waypoint/issues/5)) ([ebbd5e5](https://github.com/SeanCassiere/waypoint/commit/ebbd5e51d66cfbe77b5b2ef96169d57044b87485))


### Bug Fixes

* **deploy:** writer image builds with the reader workspace package present ([#18](https://github.com/SeanCassiere/waypoint/issues/18)) ([bb4914f](https://github.com/SeanCassiere/waypoint/commit/bb4914f9a3e132bc9ac08589b812c34001d71405))
* **deps:** override transitive sharp to 0.35.5 (GHSA-wq5f-xc86-pv6w) ([#20](https://github.com/SeanCassiere/waypoint/issues/20)) ([9dfaec4](https://github.com/SeanCassiere/waypoint/commit/9dfaec46e033ae7b522ed86cd9b78a51476bc067))
* **deps:** override transitive uuid to &gt;=11.1.1 (GHSA-w5hq-g745-h8pq) ([#14](https://github.com/SeanCassiere/waypoint/issues/14)) ([959ad25](https://github.com/SeanCassiere/waypoint/commit/959ad25a0115ec42afa85141057c0e999d8e80bd))


### Documentation

* add FUNDING.yml ([7c2ff52](https://github.com/SeanCassiere/waypoint/commit/7c2ff52f26d3d8aa1cccbb6fccb38948e4116458))
* add Waypoint design docs and glossary ([a792449](https://github.com/SeanCassiere/waypoint/commit/a79244906c94e98d5c0cb46b729bad382e398925))
* centralize the trust model in docs/trust-model.md ([#16](https://github.com/SeanCassiere/waypoint/issues/16)) ([3e96033](https://github.com/SeanCassiere/waypoint/commit/3e96033cc80df19e1c4ff74f1080f686b26a8282))
* mark phase 1 complete ([#10](https://github.com/SeanCassiere/waypoint/issues/10)) ([f33b6c7](https://github.com/SeanCassiere/waypoint/commit/f33b6c71727f2bf38c828e172f1cd155a5d3aeb0))
* open-source hygiene (MIT license, community files, dependabot, generic docs, repo-wide owner-string check) ([#32](https://github.com/SeanCassiere/waypoint/issues/32)) ([6bc7b9c](https://github.com/SeanCassiere/waypoint/commit/6bc7b9ce39c883f791d5f1aa22f3b2b5bea9ddea))
* phase 2 complete; remove spikes; 5 s share-link cache ([#23](https://github.com/SeanCassiere/waypoint/issues/23)) ([889df46](https://github.com/SeanCassiere/waypoint/commit/889df462f189580b648f0f34e1257ded57ef1503))
* provisioning guide for the local writer and cloud reader ([#15](https://github.com/SeanCassiere/waypoint/issues/15)) ([4845a6d](https://github.com/SeanCassiere/waypoint/commit/4845a6d970e8795b38384a9e05cedc5b83e694d6))
* record provisioned Turso and R2 infrastructure ([#1](https://github.com/SeanCassiere/waypoint/issues/1)) ([51a926c](https://github.com/SeanCassiere/waypoint/commit/51a926cdb2531c82c6c2cb49c233fa2338ba16d5))
* **skill:** clarify head inheritance and how to re-check sync state ([#12](https://github.com/SeanCassiere/waypoint/issues/12)) ([2068cd7](https://github.com/SeanCassiere/waypoint/commit/2068cd7f16a54fc29cdfb78045e00f7298667152))


### Build System

* bundle packages with tsdown, per-package tests, source condition, pruned Docker build ([#27](https://github.com/SeanCassiere/waypoint/issues/27)) ([d3478f7](https://github.com/SeanCassiere/waypoint/commit/d3478f7bc44799f9b6a4b4a72ef40a28445ea1ca))
* Turborepo task orchestration with signed Vercel remote cache ([#26](https://github.com/SeanCassiere/waypoint/issues/26)) ([5d6064b](https://github.com/SeanCassiere/waypoint/commit/5d6064bae0d5d12221d1d84c0a2b66089431788f))
