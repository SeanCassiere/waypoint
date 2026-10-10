# Changelog

## [0.2.2](https://github.com/SeanCassiere/waypoint/compare/v0.2.1...v0.2.2) (2026-10-10)


### Performance

* **deploy:** writer health checks every second while it starts, and faster polls ([#98](https://github.com/SeanCassiere/waypoint/issues/98)) ([4d28f5b](https://github.com/SeanCassiere/waypoint/commit/4d28f5bf76502636e0b2a45cc309dbcffdb27390))

## [0.2.1](https://github.com/SeanCassiere/waypoint/compare/v0.2.0...v0.2.1) (2026-10-10)


### Bug Fixes

* **viewer:** dialog footers sit flush with the dialog's bottom edge ([aa2516c](https://github.com/SeanCassiere/waypoint/commit/aa2516cceccbe227bca48c04fdfd343b5584ebef))

## [0.2.0](https://github.com/SeanCassiere/waypoint/compare/v0.1.2...v0.2.0) (2026-10-10)


### Features

* A11Y-08 calm loading line for slow documents in the reader and the writer ([3b6a842](https://github.com/SeanCassiere/waypoint/commit/3b6a84204fe50f5eecdbeee3fe35dcfa2bc04d41))
* **reader:** A11Y-07 Files as a light-dismiss popover and phone sheet, tab overflow ([f6bdaa0](https://github.com/SeanCassiere/waypoint/commit/f6bdaa0d5d6d6d768cf2b908c428f445014e15e3))
* **reader:** RX-01 one letterhead with every link state, About on demand, phone short forms ([6cd5361](https://github.com/SeanCassiere/waypoint/commit/6cd53613d7308de302cc4e14c3d10e24a62c5016))
* **reader:** RX-03 file type icons, download marker and per-file title ([8929438](https://github.com/SeanCassiere/waypoint/commit/8929438734aba9a6517fbdc172d4f70062f5d83d))
* **reader:** RX-04 image stage in the reader and the writer, Open in gallery only with a gallery ([fe5c2ed](https://github.com/SeanCassiere/waypoint/commit/fe5c2ed5deb4834d5ccddb378561c7beea3528bd))
* **reader:** RX-06 Download the original file from the shell ([5384734](https://github.com/SeanCassiere/waypoint/commit/5384734ba4c8d2d0d22ace743ff9c05ec7fb2a50))
* **reader:** RX-07 one fixed denial body per route family, framable /x/ card ([86e3206](https://github.com/SeanCassiere/waypoint/commit/86e3206ee8fc110c59dd893d2208a9322ea9c8b1))
* **reader:** RX-11 latest links say when a newer revision is being synced ([3b394c3](https://github.com/SeanCassiere/waypoint/commit/3b394c36021f211caf90e5f879866d8aad6b9771))
* **reader:** VS-05b shared shell button family with 44 px touch targets ([e392ad3](https://github.com/SeanCassiere/waypoint/commit/e392ad3eb0bb5a0e68c394462c4830ed4d2fe20b))
* **render:** RX-08 text v1 and csv v1 renditions for text, code, logs, JSON and CSV ([ee82585](https://github.com/SeanCassiere/waypoint/commit/ee82585304c420def8535ffffb9d0a197552d976))
* **render:** VS-07 documents on the warm Folio palette (markdown renderer v3) ([fc18fc6](https://github.com/SeanCassiere/waypoint/commit/fc18fc6bcb0a2ee5ff5cef1018ede4dbd8f09f87))
* **ui:** FB2 VS-01a tokens v2 split by consumer, new roles, contrast and consumer guards ([#46](https://github.com/SeanCassiere/waypoint/issues/46)) ([575444d](https://github.com/SeanCassiere/waypoint/commit/575444de72b782789a3093f63b1059f90b223dcb))
* **ui:** FB3 VS-03a one SVG icon set with sprite helpers and iconCss in the shared tokens ([#48](https://github.com/SeanCassiere/waypoint/issues/48)) ([7523b15](https://github.com/SeanCassiere/waypoint/commit/7523b15eb43a47917998001949cd6254c75be812))
* **viewer:** A11Y-04 one row contract for Recent, search and Trash ([be9ee00](https://github.com/SeanCassiere/waypoint/commit/be9ee001052869c2acfce6b182ad293d829b74ed))
* **viewer:** A11Y-05b lightbox button modes and safe arrows, Esc on Gallery and Changes, data-change on code and tables, grouped shortcuts dialog ([034e8a9](https://github.com/SeanCassiere/waypoint/commit/034e8a9230319cf487c663226fa5033e266f0803))
* **viewer:** FC3 NAV-09a canonical search tokens is:public, is:failed, is:uploading; old tokens stay as aliases ([b74e3dd](https://github.com/SeanCassiere/waypoint/commit/b74e3dd3531fa8971b3670c32b10cb123f55f4ea))
* **viewer:** FD1 NAV-05a lineage.ts: latest line, parent stepping, relations and lanes on display order ([#41](https://github.com/SeanCassiere/waypoint/issues/41)) ([daac327](https://github.com/SeanCassiere/waypoint/commit/daac3273dab9c2d920e5491cb3b921c3bceff41d))
* **viewer:** FD2 A11Y-05a one keymap registry; g l and g t; / and ? work with shortcuts off; / opens Find ([906ef4b](https://github.com/SeanCassiere/waypoint/commit/906ef4b42a6b9958b761fab3d7cbc558c3e921be))
* **viewer:** FD3 OW-02 flash toasts that survive the reload, sticky error toasts with cause and next step, no undo ([2a13dea](https://github.com/SeanCassiere/waypoint/commit/2a13dea0c3413134f6fb340e1362c69ec3fbee6c))
* **viewer:** NAV-01 one global bar with Recent, Public links and Trash tabs and live counts ([9752c38](https://github.com/SeanCassiere/waypoint/commit/9752c385e514609862eebebe2c309b9d18aaaf27))
* **viewer:** NAV-02 Find dialog on every page, grouped suggestions and a real empty search page ([7858610](https://github.com/SeanCassiere/waypoint/commit/78586107e1536adc49c6285bde155ef6a75e7c49))
* **viewer:** NAV-03 removable filter chips, Trash-aware results and a phone search field ([3f8e560](https://github.com/SeanCassiere/waypoint/commit/3f8e5607ed5bdafc1b8fb304f43ab8a5f52e9696))
* **viewer:** NAV-04 collection bar as a breadcrumb with revision and file pills at three widths ([9e48eda](https://github.com/SeanCassiere/waypoint/commit/9e48edae2fae217d8c326b0b88aa0cc5509ff141))
* **viewer:** NAV-05b history lanes on display order; [ and ] follow parents ([ad37073](https://github.com/SeanCassiere/waypoint/commit/ad37073df25840f67ac11ffa778a4d8ff31d1bc4))
* **viewer:** NAV-06 first run in two steps, and all-in-Trash keeps Recent ([b15d1a0](https://github.com/SeanCassiere/waypoint/commit/b15d1a00cec4b25638e93b00253ab8e5d6a6fc53))
* **viewer:** NAV-09b one vocabulary: tailnet-scoped Copy menu, named file actions, Public links tab and pinned-sentence checks ([a964988](https://github.com/SeanCassiere/waypoint/commit/a96498805d73dbe59e6373a2e79cf3c445f40ff5))
* **viewer:** NAV-10 compare as a History mode; ordered pairs, range and branch headers ([669aa72](https://github.com/SeanCassiere/waypoint/commit/669aa72d2d6f6e042c3a789675a6025dac618106))
* **viewer:** NAV-11 collection details card and one details dialog ([c32980a](https://github.com/SeanCassiere/waypoint/commit/c32980a01fd160f2de7c25a7e02f2279e2ae7742))
* **viewer:** NAV-13 connect an agent in three steps with wrap-safe commands and named Copy buttons ([db4d5c5](https://github.com/SeanCassiere/waypoint/commit/db4d5c506ab58e4f99e493cae0f73a334b150bf7))
* **viewer:** OW-03 share dialog shows what each target publishes; preview follows the target ([14751f9](https://github.com/SeanCassiere/waypoint/commit/14751f9fb2b0d48ea9f6262e2264402bad0dde83))
* **viewer:** OW-04 Links tab stays true after revoke and extend ([7927bf5](https://github.com/SeanCassiere/waypoint/commit/7927bf5bc869e984e9c44268c716934bdaa4eca1))
* **viewer:** OW-05b /links groups live, paused, expired and revoked links by collection ([272e38c](https://github.com/SeanCassiere/waypoint/commit/272e38c1b28742d148188bb7c2d69ad01fd7a090))
* **viewer:** OW-06b Needs attention and Status worded by lineage; row chips name revisions ([011b8a6](https://github.com/SeanCassiere/waypoint/commit/011b8a62729e85ffa436216329e5b5ec9d01dde7))
* **viewer:** OW-07 every restore asks about paused links; Trash rows name and open their collection ([3b379a9](https://github.com/SeanCassiere/waypoint/commit/3b379a90e2e1625446935d75e04a691cc62b5ad0))
* **viewer:** OW-08 unread rows stay in place and read marks persist ([6611285](https://github.com/SeanCassiere/waypoint/commit/6611285b43eead03add5e09d94e68b0b7160b000))
* **viewer:** OW-10b scope the health pill to the collection; split the popover ([dd34909](https://github.com/SeanCassiere/waypoint/commit/dd3490977c3285ec6a9564f0bad2181a1c588aa8))
* **viewer:** OW-12a honest Changes page: Hide on open folds, long runs and source hunks that open, a visible stepper, tallies, removed images, violet changed ([8bf469d](https://github.com/SeanCassiere/waypoint/commit/8bf469d1ceb204562c3fdfb9632ae1aa77104c04))
* **viewer:** OW-12b rendered table diffs, the fold's context table, GFM callouts and working relative links on Changes ([33da2d7](https://github.com/SeanCassiere/waypoint/commit/33da2d72491293349736504cc1a6b716567f5f35))
* **viewer:** OW-14 purges you can follow on Trash and Status; grace waits aren't errors ([3fde1ca](https://github.com/SeanCassiere/waypoint/commit/3fde1caccb7abe1884b6b8a996d90da134d4b7a7))
* **viewer:** RX-10 public preview band names the revision and the failed target page tells the truth ([e168818](https://github.com/SeanCassiere/waypoint/commit/e1688183220c52ad9bd05156d7f0dbafd425ec0e))
* **viewer:** VS-03b replace the remaining Unicode glyphs with icons and empty the icon allowlist ([8d0ac9c](https://github.com/SeanCassiere/waypoint/commit/8d0ac9c0e757d099dce597647df6496c3dd52c84))
* **viewer:** VS-04 dark-safe solid buttons and bands, no opacity dimming, one selection style ([9875fdb](https://github.com/SeanCassiere/waypoint/commit/9875fdb176c7c1b618cd5f98368624ed35a9a2c2))
* **viewer:** VS-05a 28/32 px button sizes, 44 px touch buttons, 16 px phone fields and keyboard-aware sheets ([726b3af](https://github.com/SeanCassiere/waypoint/commit/726b3afe51bc3c5024eabab1e977a94b53ff3bab))
* **viewer:** VS-05c solid destructive confirms, 44 px row actions at 760 px and the phone field audit ([5859c1c](https://github.com/SeanCassiere/waypoint/commit/5859c1c3da713fff8b1e383b2f5e881644ab7fd1))
* **writer:** FC1 OW-05a one live rule for share links: paused and waiting states, exact revoke-all, chrome counts ([97062b3](https://github.com/SeanCassiere/waypoint/commit/97062b37dc18a7bf8e53e69ac3d8dbb01d8ed88d))
* **writer:** FC2 OW-06a/OW-10a one sync-health rule: syncStateOf, Retry restarts the clock, scopeFor ([8bf7a24](https://github.com/SeanCassiere/waypoint/commit/8bf7a24f930e930ffcdeec11adb0bae8a15b6e3d))
* **writer:** FD4 additive migrations: collection_syncing in waypoint.db, pending_purges title and public_id in queue.db ([#44](https://github.com/SeanCassiere/waypoint/issues/44)) ([1a5b06b](https://github.com/SeanCassiere/waypoint/commit/1a5b06b629756e77748a2825455b4e909828f287))


### Bug Fixes

* **reader:** RX-02 keep shell links correct after in-frame navigation ([189092d](https://github.com/SeanCassiere/waypoint/commit/189092d42a1384880a9ad04c6a7d24b4bbac6e41))
* **reader:** RX-05 serve CSV and TSV as plain text on the raw routes ([ab78baf](https://github.com/SeanCassiere/waypoint/commit/ab78baff380f9e6d58a7695659f77d20ac177675))
* RX-09 section links keep #heading in the address bar and open there, in the reader and the writer ([4b1a3ec](https://github.com/SeanCassiere/waypoint/commit/4b1a3ece116f4dd9c91f166879d9f2bc1e5fab29))
* **viewer:** A11Y-10 gallery thumbnails keep their 16:10 frame at any height, and long menus scroll with pinned actions ([ae64689](https://github.com/SeanCassiere/waypoint/commit/ae64689557c11c8fa8e015bef11c1f4c41051ffd))
* **viewer:** A11Y-AUDIT axe and accessibility-tree audit of every writer and reader page at three widths ([afbb45b](https://github.com/SeanCassiere/waypoint/commit/afbb45bf5d22855a71d648de3c112094774e641f))


### Code Refactoring

* **ui:** FB1 split the public shell into modules with named CSS and readable script segments ([#43](https://github.com/SeanCassiere/waypoint/issues/43)) ([f894b39](https://github.com/SeanCassiere/waypoint/commit/f894b392dff3c9efb0c4d0b4b6073ee927d30fcb))
* **viewer:** FA1 split viewer.css into ordered partials ([#45](https://github.com/SeanCassiere/waypoint/issues/45)) ([5302adf](https://github.com/SeanCassiere/waypoint/commit/5302adf81834d2dae276cc2407e8ad3ae7e7e77b))
* **viewer:** FA2 split collection, changes and recent pages into modules ([#47](https://github.com/SeanCassiere/waypoint/issues/47)) ([191696b](https://github.com/SeanCassiere/waypoint/commit/191696bca8d7c86262a8de9605bd2e657c2ee970))

## [0.1.2](https://github.com/SeanCassiere/waypoint/compare/v0.1.1...v0.1.2) (2026-10-08)


### Documentation

* **release:** keep the version heading out of hand-made release notes ([#39](https://github.com/SeanCassiere/waypoint/issues/39)) ([b0d6d4a](https://github.com/SeanCassiere/waypoint/commit/b0d6d4a0cf0104cb1a4ac270d1dc5d9d9eac4e9e))

## [0.1.1](https://github.com/SeanCassiere/waypoint/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* **deps:** bump diff from 8.0.4 to 9.0.0 ([#33](https://github.com/SeanCassiere/waypoint/issues/33)) ([ae35f68](https://github.com/SeanCassiere/waypoint/commit/ae35f68567f0fd007fd5b4291bffae9661b89423))

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
