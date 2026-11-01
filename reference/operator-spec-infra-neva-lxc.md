# PVE host — LXC topology

Durable map of the Proxmox host `PVE` (Debian 13, PVE 7.0.14) and the LXC
containers it runs. All unprivileged, `ostype: debian`, `features: nesting=1`.

## Networks

- `vmbr1` = `10.0.0.0/24`, gateway **`10.0.0.1`** (bridge IP on the host) —
  main LAN. Most containers are DHCP; some are pinned static.
- `vmbr2` = `10.0.2.0/24` — isolated segment, only CETAS (100) uses it.
- **MTU**: bridges are 1500. Keep every container's `net0` MTU at **1500** to match.
  A `mtu=1300` override on 102 caused ~7.5% RX drops and intermittent TLS stalls on
  **all** outbound cloud calls (CopilotKit Intelligence and the model upstream via
  the router), which looked like "every model is slow". Fixed 2026-10-10
  (`pct set 102 -net0 ...,mtu=1500`). Diagnose with
  `pct exec <id> -- ip -s link show eth0` (watch RX dropped).

## SSH access

- `sshd` listens on **22**, key-only (`passwordauthentication no`, `permitrootlogin no`),
  user **`sam`**; PVE firewall is enabled and `host.fw` allows 22 **only** from the
  `management` ipset: `192.168.1.0/24`, `10.0.0.0/24`, `10.0.2.0/24`, `100.64.0.0/10`
  (Tailscale), `127.0.0.0/8`. Port 22 is **not** open to the internet.
- Tailscale traffic is accepted earlier by `ts-input` (`-i tailscale0 -j ACCEPT`) and therefore
  bypasses the PVE rules. Use `sam@100.64.0.10` or `neva` (MagicDNS), from LAN
  `192.168.1.75`.
- **Gotcha (2026-10-28)**: a VPN/exit-node enabled on the client breaks SSH — the client showed
  `Permission denied` while **no packet reached** `sshd` (verify with `journalctl -u ssh` +
  `tcpdump -i any 'tcp port 22'`). Disable the client VPN; `fail2ban` had 0 bans.

## MTU fallback system (auto)

- **Automatic ladder (kept).** `mtu-fallback` (+ `/etc/default/mtu-fallback`) runs every 30 s via
  `mtu-fallback.timer`: probe, then walk `1500 1400 1300 1280` on failure, adopt the first that
  works, **return to 1500** when the probe succeeds again. `mtu-fallback status` shows state.
- **Canaries must transfer a large payload.** Use
  `https://deb.debian.org/debian/dists/trixie/Release` (~138 KB) and the security mirror. A small
  page answers at any MTU and **cannot detect a blackhole** — the old github/npm/openrouter canaries
  were the bug. Canonical container config: `/usr/local/share/mtu-fallback/mtu-fallback.default`.
- **Host (PVE)** manages **`vmbr0` only** (`MTU_IFACE="vmbr0"`, internet egress; gw 192.168.1.150),
  `mtu-fallback.service` (boot) + `mtu-fallback.timer` enabled. `tailscale0` (1280) is not managed.
  A `TCPMSS --set-mss 1240` clamp remains on `vmbr0` as a safeguard.
- **`vmbr1`/`vmbr2` must stay at 1500 forever** — they are the L2 path to the containers. Lowering
  them drops large download frames and no MSS setting can repair that. Only the host egress may
  walk the ladder.
- **Host installer**: `/usr/local/sbin/mtu-fallback-install <vmid>` pushes the canonical files,
  enables the timer, and sets `net0 mtu=1500`. Deployed on 100, 102, 104, 105, **108**.
- **Persistence**: host = boot service + timer enabled; containers = timer enabled
  (`OnBootSec=60s`); every container's LXC `net0` is `mtu=1500`.
- **INCIDENT 2026-10-26 — the host watchdog broke downloads on every container.** Config had
  `MTU_IFACE="vmbr0 vmbr1 vmbr2"` + small-page canaries: a transient failure lowered **all**
  bridges to 1400, the small canaries still answered (their reply fits one segment), so it stayed
  at 1400. Downloads from the internet arrive as 1448–1489-byte frames (`vmbr0` pcap) and an L2
  bridge at 1400 drops them → in **all** containers (102 and 108) TCP connected and the request was
  sent, but the response never arrived; `wget`/`apt` hung silently. The host worked (no vmbr1).
  **Fix applied**: ladder on `vmbr0` only + large-payload canaries on host and containers (backups
  `*.bak-20261026`); bridges back to 1500.
- **LXC 108 (webmarexsoft)**: watchdog installed (was absent); its stale `veth108i0` at 1400 was
  raised to 1500 by hand and `net0` carries `mtu=1500`. After recreating a container/veth, check
  the **host-side veth MTU**, not just `eth0`.

## Containers

| ID | Name | Role | IP | onboot |
|----|------|------|----|--------|
| 100 | CETAS | app + Docker ("SamAgent"/Cetas web UI) | `10.0.0.100` + `10.0.2.100` | 1 |
| 101 | SamAgent | agent | DHCP | 0 |
| 102 | app-lxc | llama.cpp / local LLM | `10.0.0.102` | 1 |
| 103 | Websearch | websearch service | DHCP | 1 |
| 104 | redis | Redis cache/db | `10.0.0.104` (static) | 1 |
| 105 | web-lxc | nginx reverse proxy (serves public vhosts) | `10.0.0.105` | 1 |
| 106 | caddy | Caddy | DHCP | 0 |
| 107 | freellmapi | CETAS gateway fork (see `cetas-byok-licensing.md`) | `10.0.0.107`, port 3001 | 1 |
| 108 | webmarexsoft | web app / dev container (user account `sam`) | `10.0.0.108` (DHCP) | 1 |

Only 100, 102, 105 (and 104 now) are normally running; the rest are stopped but
`onboot`-enabled where noted. 108 is up as of 2026-10-26 (`net0 mtu=1500`).

## Redis (LXC 104)

- Redis **8.0.2**, `bind 0.0.0.0`, port **6379**, `protected-mode yes`,
  `requirepass Papa!26+`.
- Reached over `vmbr1` at `10.0.0.104:6379`; verified working from the host and
  from CETAS (100).
- Originally installed on 29/08 and left unused (empty `dump.rdb`). Pinned to a
  static IP on 02/10/2026, `onboot: 1`.
- Operations: `sudo pct {start|stop|reboot} 104`,
  `sudo pct exec 104 -- redis-cli -a 'Papa!26+' ping`.
- If repurposed (cache/sessions/queue), keep auth on and note the client here.

## freellmapi gateway (LXC 107)

- App = the `cetas-gateway` fork, repo `/home/sam/freellmapi`, run by Docker Compose
  (`docker compose up -d`), image `cetas-gateway:latest`, `restart: unless-stopped`.
- `HOST_BIND=10.0.0.107`, port **3001**; healthcheck on `/api/ping`.
- **Deliberate lockdown**: iptables `DOCKER-USER` inside 107 accepts `--dport 3001`
  only from `10.0.0.105` and `DROP`s everything else — so the host and other
  containers time out by design. Access path is nginx on 105.
- Public vhost `nevallm.example.com` → `10.0.0.107:3001` (nginx 105,
  `sites-available/nevallm.conf`). `GET /api/ping` is open; BYOK endpoints require auth.
- `.env` holds `BYOK_LICENSE_HASH` (licensed) — see `cetas-byok-licensing.md`.

## OpenDots (LXC 102, cetas rag)

- CopilotKit **OpenDots** app in `/home/sam/OpenDots` (installed 2026-10-08), Node 24
  via NodeSource; `esbuild` install-script allow-listed.
- Runs as systemd unit `opendots.service` (User=sam), **loopback only**
  (`HOST=127.0.0.1:4310`); reach it externally via SSH tunnel.
- Configured 2026-10-08 and chat-operational: model served via the LiteLLM router on 102
  (`OPENAI_BASE_URL=http://127.0.0.1:4000/v1`, `OPENAI_MODEL=opencode-deepseek-v4.1`; set
  `OPENAI_MODEL` to any router model name) + hosted CopilotKit Intelligence
  (`CPK_INTELLIGENCE_API_KEY`, free Developer plan); `OWNER_TOKEN` set.
- Access is via SSH tunnel; `/api/health` requires the owner token (401 otherwise).
- Dot computers enabled (2026-10-08): OpenBot `computer-supervisor` via
  `docker compose -f compose.computers.yml up -d computer-supervisor`, loopback
  `127.0.0.1:4312`, images `opendots-computer:b6932d3` / `opendots-supervisor:b6932d3-dot-auth`
  (OpenBot pinned `b6932d3`). Secrets `COMPUTER_SUPERVISOR_TOKEN`/`COMPUTER_TOKEN` in `.env`,
  `COMPUTER_NAMESPACE=opendots`. ~2 GB RAM per computer.
- Rebuild `npm run build`, then `systemctl restart opendots`. After a master-token change the
  supervisor replaces owned computers on next ensure (volumes retained).
- LXC 102 also hosts the cetas-lite repo and `~/DOCUMENTATION/` (its operation journal).
- **Customized as "NevaDots"** (2026-10-08): rebranded from OpenDots, ocean-blue theme accent
  `#2196F3`/`#1976D2` (from cetas-lite), and a composer **model selector**. Global default =
  env `OPENAI_MODEL`; per-Dot override via `PUT /api/dots/:id/model` (Dot column `model`);
  selectable list = env `OPENAI_MODELS` (the LiteLLM router's models); `GET /api/models`.
  Logo/favicon generated from the user's `Logo nevaDots.png` (Chromium/playwright crop of the
  full emblem = N + 3 robots on navy `#000016` → `favicon.svg`, `favicon-32/16.png`,
  `apple-touch-icon.png`, `icon-256/512.png`); 3 avatars (`public/dots/` `blue|pink|green.png`)
  with CSS state animations (idle/thinking/listening/writing/paused) plus a liquid metaball effect
  (SVG `dot-goo` filter + orbiting blobs, `Mascot.tsx`/`style.css`) shown only in listening/writing.
  `writing` fires when the
  current tool is `computer_files_write|computer_exec|computer_type|create_space_page|edit_space_page`.
  Source images under `docs/FORKoffLine/img/`.
- **Mascot avatars**: PNG dots (`public/dots/blue|pink|green.png`) with CSS state animations +
  the metaball blob effect. A three.js 3D avatar was tried (2026-10-08, commits `f24d3f2..a97a689`,
  fixes up to `4fb0c72`) but **removed 2026-10-10** (`fc58ae6`) — the model looked bad; `Mascot3D.tsx`,
  `public/models/dot.glb` and the `three` deps are gone. `Chat.tsx` derives the state from the active
  tool (search/web vs write) and live reasoning, with transient `complete`/`error` flashes; `style.css`
  animates searching/analyzing/complete/error on the PNG.
- **Reasoning panel + manual translation** (2026-10-08, commits `8c48d6a`, `1e48a84`): server tees the
  provider SSE (`src/server/reasoning.ts`) for `reasoning_content`/`reasoning` deltas and emits AG-UI
  REASONING_*; stats are **finalized on the `[DONE]` marker** (not only on stream close — the opencode
  proxy may never close), and the client re-fetches them when the run ends. The right-side panel
  auto-opens only when reasoning is streamed, with a CETAS-style header (model/time/tokens/tok-s/cost
  via `src/shared/pricing.ts`) and auto-collapse. The "Traduire" button calls `POST /api/translate`
  with a free OpenRouter model (source wrapped in `<source>` tags + instruction to never follow
  embedded instructions) — needs `OPENROUTER_API_KEY` (+ optional `TRANSLATE_MODEL`, default
  `nvidia/nemotron-3-super-120b-a12b:free`) in `.env`. Verified: `deepseek-reasoner` via the router
  emits `reasoning_content` in SSE. **Stats ids** (commit `67ed325`): the TanStack adapter already
  emits its own reasoning message (`openai-compatible-…`) besides our tee (`reasoning-…`), so stats
  are stored under **both** ids (the client panel keys on the adapter id).
- **resolved 2026-10-10**): the runtime advertises
  `inspectorMetadata:true` + `inspectorLearning:true` in `/api/copilotkit/info`, but the fork
  denies those routes in `src/server/runtime-scope.ts` → the CopilotKit client retried
  `GET /api/copilotkit/inspector-metadata` and flooded 403s (hundreds/minute; a real jank source).
  Fixed by short-circuiting `inspector-metadata`/`inspector-learning` to `204` in `platform.handle`
  before `validateRuntimeScope`, plus `showDevConsole={false}` on `<CopilotKitProvider>`. The client
  still polls that route (~0.5/s) but now gets cheap 204s and no console 403s.
- **Latency / input bloat** (resolved 2026-10-10): the "slow, not fluid" feeling came from two
  sources, not the providers (router streaming is fast: ~2–3 s for opencode-deepseek-v4.1). (1) the
  inspector 403 flood above; (2) large tool results being resent to the model on every agent
  iteration — `dot-agent.ts` now truncates `tool` messages to `TOOL_RESULT_LIMIT` (6 000 chars)
  before conversion, keeping the full text for the UI capture/brief. Build/ops note: always run
  `npm run build` as `sam`, never root (a root build leaves `dist/` root-owned → EACCES).
- **Intelligence resilience** (2026-10-09, commit `5c7cd40`): `createConversation` retries transient
  failures (5xx/429/retryable) up to 3× with backoff and a 6 s per-attempt timeout (the SDK has none,
  so requests could hang forever during a hosted outage), and surfaces the real cause
  (`CopilotKit Intelligence is unavailable (status)` / `unreachable`) instead of the misleading
  "check the runtime key". The hosted Intelligence API (`api.intelligence.copilotkit.ai`) is a
  CopilotKit dependency that can be down (503) independently of NevaDots.
- **Conversation deletion** (2026-10-10, commits `059258e`, `cbf26c1`): `DELETE /api/conversations/:id`
  and `DELETE /api/conversations` (all). Backend removes the local binding (plus `task_threads`/
  `calls`/`captures`) **first** and fires the hosted Intelligence delete **in the background** (it can
  hang up to 6s each when Intelligence is down — never blocks the response); the client also removes
  the row optimistically, so deletion is visible in ~0.1s. UI: per-row trash (on hover) + a delete-all
  in the RECENT CHATS header, with confirm dialogs. Note: `app.ts` only requires `application/json`
  when a `content-type` header is present, so body-less DELETE works (previously 415).
- **UI refonte** (branch `NevaDots-refont-UI`, started 2026-10-10, Phase 0 = commit `0ff6283`):
  goal is to port **cetas-lite's UI/UX** (used only as a reference; cetas-lite is never modified)
  into NevaDots — skin **and** layout restructuring, adopting cetas-lite's colour system, keeping
  all NevaDots features. Phase 0 = `src/client/tokens.css` (`--nd-*` primitives + mappings of the
  legacy tokens `--ink/--muted/--line/--blue/--lavender/--accent…`), 8 accent palettes, and
  `theme.ts` extended (`hard_dark` + palette API). **Key constraint**: NevaDots auto-generates its
  dark theme at build time via the PostCSS plugin `src/build/dark-theme.ts` (OKLab flip) — so
  **do not hand-write `:root[data-theme='dark']` colours for components**; only pin core tokens if
  needed. `hard_dark` reuses `data-theme='dark'` + `data-dark='hard'` (the plugin only knows 'dark').
  Remaining phases: 1 layout, 2 components, 3 ocean effects, 4 verification.
  **Phase 1** (`c98d65d`, `080780d`): `src/client/refonte.css` (additive overrides via tokens,
  imported last, modelled on cetas-lite's `ocean.css`) covers rail/sidebar/topbar/composer/messages/
  modals/reasoning panel. Phases 2 (component library + secondary views) and 3 (ocean effects) pending.
  **Phase 2** (`a058cad`): `refonte.css` also covers form controls, `.icon-button`, the Spaces/
  Documents editor (remaps `--document-ink/muted/line`, drops the original green), the Result pane,
  the Computer panel and the Connections cards. Phase 3 (ocean effects: glassmorphism/glow/ripple)
  still pending.
  **Phase 3** (`6531f9f`): `src/client/refonte-ocean.css` (glassmorphism, accent glow, logo
  breathing) + `src/client/ripple.ts` (delegated click ripple, wired in `main.tsx`, no JSX changes).
  **Gotcha**: write only `backdrop-filter` (no `-webkit-` twin) — the CSS minifier drops the standard
  property otherwise. Phase 4 (final verification / merge to `main`) pending.
  **Earlier Phase 4 verification** covered the pre-reconstruction shell in light/dark/hard_dark +
  palettes; it does not certify the current layout work. Branch `NevaDots-refont-UI` is separate;
  `main` remains untouched pending explicit user approval to merge.
  **Post-Phase-4**: `3479f3f` fixes the stale shell (`index.html` → `Cache-Control: no-store`,
  `/assets/*` → `immutable`); `2146579` adds a cetas-lite-style sidebar **Métriques** block
  (Model/CPU/RAM/Disk/Network) backed by a new `GET /api/metrics` (`src/server/metrics.ts`,
  reads `/proc/stat`, `/proc/meminfo`, `statfs`, `/proc/net/dev`, polled every 3 s). Memory and disk
  now include absolute used/total byte values as well as percentages for Cetas-style sidebar output.
  **Current layout invariant:** reproduce cetas-lite's single-sidebar composition with no separate
  icon rail; the sidebar owns navigation and conversation history, and the chat canvas stays
  uncluttered. Do not restore the old rail + DOTS/SPACES sidebar + breadcrumb topbar. Preserve access
  to Dots, Spaces, Computers, scheduled activity, and settings. The shell now defaults to green
  (`#22c55e`); the other palettes remain selectable. `refonte.css` remains additive and is imported
  after base styles, editor styles, and tokens; `refonte-ocean.css` follows it. An open conversation
  mirrors Cetas too: no persona header, right-aligned user bubbles with full-width assistant text, a
  session token/cost bar, and a pill composer with a model note. The shared "+" composer menu
  (`src/client/ComposerMenu.tsx`) exposes page source, scheduling, computer, Dot switching/creation,
  and memory insertion; the settings modal (`WorkspaceDialog`) is tabbed (appearance, preferences,
  dots/spaces, connections, health, about). The **Muse-style activity** (`src/shared/activity.ts` =
  `deriveActivity`, plus `ActivityPanel.tsx` / `ActivityBubbles.tsx`) shows what the agent does —
  terminal commands, websites, files, searches, MCP tools, reasoning — derived from the AG-UI
  `agent.messages`, and persists a per-conversation summary/activity server-side for the day-grouped
  timeline. The collapsed, **draggable** bubble floats over the chat. See `muse-ui-panel.md`.
- **Git**: published fork at `https://github.com/Hajrudin-Zelef/NevaDots` (remote `nevadots`);
  `origin` = upstream `CopilotKit/OpenDots`. The clone started `--depth 1`, so run
  `git fetch --unshallow origin` before pushing full history to a fresh repo. `docs/FORKoffLine/`
  (source images) is gitignored — user keeps local docs out of commits.
- **Source edit workflow** (repo lives only in 102): `pct exec 102 -- tar -C /home/sam/OpenDots
  -czf /tmp/src.tgz src index.html` → `pct pull` → edit host copy → `pct push` + `tar -xzf` in
  `/home/sam/OpenDots` → `chown -R sam:sam` → `npm run build` → `systemctl restart opendots`.
- **User drop-in workflow**: the user drops a `*.tar.gz` (full files, not patches) in
  `/home/sam/OpenDots/docs/FORKoffLine/` with its sha256. Apply = verify sha256, extract, `cp` over
  the tree, `chown -R sam:sam`, then `npm run typecheck && npm run lint && npm run build && npm test`
  (307 tests), fix any rebrand-driven test breakage, commit and push to `nevadots`.

## LiteLLM router (LXC 102)
- `docker compose` in `/home/sam/litellm` (image `ghcr.io/berriai/litellm:main-stable`),
  `network_mode: host`, listens on **`10.0.0.102:4000`**, OpenAI-compatible `/v1`.
- Auth via `LITELLM_MASTER_KEY` (in `/home/sam/litellm/.env`, 0600). Provider keys live in
  the same `.env` (DeepSeek, OpenRouter, OpenCode Go, llama.cpp).
- Models: `deepseek-chat`, `deepseek-reasoner`, `openrouter-auto`, `openrouter-deepseek`,
  `opencode-go` (model `hy3`; LiteLLM injects the required `x-opencode-session` header),
  `local-qwen` (→ llama.cpp `127.0.0.1:8080`, key in `/etc/llama-server.apikey`).
- **OpenCode Go selection (2026-10-10)**: the user only funds **OpenCode** (flat Go subscription,
  no OpenRouter/DeepSeek credit). Six models ≤ $1.5/1M output were added — reasoning:
  `deepseek-v4-flash`, `deepseek-v4.1-flash`, `glm-5.3-flash`; non-reasoning: `minimax-m3`, `hy3`,
  `hy4-preview` (all via `https://opencode.ai/zen/go/v1`). OpenDots `.env` `OPENAI_MODELS` = those six.
  `claude-haiku-5-5`/`minimax-m2.7`/`gpt-*-luna` return `ModelProtocolUnsupported` on chat/completions.
  **Reasoning is controllable per request**: `reasoning_effort` is honored — `none` disables thinking
  (0 reasoning chunks), `low`/`high` enable it.
  **Tool-call reliability (2026-10-11, see `opendots-computer.md`)**: with the full ~23-tool request the
  runtime sends, `hy4-preview` streams malformed tool-call JSON ~9/10 (drops the closing `}`),
  `hy3`/`minimax-m3` ~3/10, `glm-5.3-flash` ~1/10 **and leaks reasoning into the visible answer**,
  `deepseek-v4-flash` ~1/10, `deepseek-v4.1-flash` **0/10 and clean** → `OPENAI_MODEL` is now
  `deepseek-v4.1-flash` (LEO's per-Dot override reset to null). Full catalog:
  `GET https://opencode.ai/zen/go/v1/models`. Pricing reference: `https://models.dev/api.json`
  (provider "OpenCode Zen").
- `llama-server` (local `local-qwen`, Qwen3.5-4B, ~3.2 GB mlock): the user **does not use it** —
  stopped manually 2026-10-13 (port 8080 freed, healthcheck timer stopped) but **left enabled**, so it
  restarts on reboot. Not in `OPENAI_MODELS`, so the app never calls it. **Consumers**: OpenDots on 102
  (`OPENAI_BASE_URL=http://127.0.0.1:4000/v1`) and the opencode CLI on PVE (provider `litellm` in
  `~/.config/opencode/opencode.jsonc`, `baseURL http://10.0.0.102:4000/v1`).
- The `cetas-gateway` (`nevallm`) provider is **not** wired yet (needs its API key).
- Update config: edit `config.yaml`/`.env`, then `docker compose up -d` (or restart `litellm`).
  **Run `docker restart litellm` as root** — `sam` is not in the docker group (docker socket denied).

## Agent loop optimizations (Phase A, 2026-10-11)

Ported from the `nathaninline/ajean` reference (see `.operator/index-session.md`). These are durable
contracts of the Dot agent (`src/server/dot-agent.ts`); tests in `tests/` (page-cache, tool-archive,
context-compaction, model-errors) enforce the invariants.

- **Web reads return an outline, not a dump** (`src/server/page-cache.ts`): `read_public_page` /
  `search_web` cache the full text and return `{title,url,pageId,lines,chars,headings,head,note}`
  (~1.5k head). The model reads deeper lines with `read_page_slice(pageId, from, to)` or finds them
  with `grep_page(pageId, query)`. Cache is in-memory, TTL 10 min, 40 pages max.
- **Truncated tool results are archived, never lost** (`src/server/tool-archive.ts`): tool messages
  over `TOOL_RESULT_LIMIT` (6000 chars) are cut and the full text archived under an `r<hash>` id; the
  truncation marker names the id. Tools `recall(id)` and `recall_search(query)` are **only added to
  the schema when the thread already has archives** (~200 tokens saved otherwise). TTL 1 h, 200 max.
- **Automatic context compaction** (`src/server/context-compaction.ts`): runs **once per turn**,
  before the model call, in the TanStack factory (which is async). Trigger at ≥75% of the model
  window (`OPENAI_CONTEXT_WINDOW`, default 128000). Keeps leading system/developer messages + the
  last ~20% (snapped to a user/assistant boundary), archives the torso verbatim, and replaces it with
  a model-written summary (`[CONTEXT COMPACTED]`) that lists the archived ids. No-op if <20% reduction
  or if the summary call fails. Summaries are cached per head+torso hash; the summary call bypasses
  the reasoning tee.
- **Model errors are classified** (`src/server/model-errors.ts`): the chat/completions fetch wrapper
  rewrites provider HTTP failures and network errors into short actionable French messages (no credit,
  bad key, missing model, rate limit, timeout, unreachable, context length) — while preserving abort
  signals and non-model errors (so the observable still rejects for domain errors). Empty answers are
  surfaced on the client (`src/client/Chat.tsx`), which no longer overwrites a captured run error.
- **Reasoning is a per-Dot, per-turn choice**: `Dot.reasoningEffort` (`none|low|medium|high|null`,
  `PUT /api/dots/:id/reasoning`) is sent to the model as `reasoning_effort` via `modelOptions`, so the
  composer's « Réflexion » button (cycles default → off → low → high) genuinely toggles thinking.

## Streaming & composer fluidity (Phase B, 2026-10-11)

- **Streaming render** (`src/client/ChatTranscript.tsx`): assistant messages stream through
  `StreamingMarkdown` — a time-based typewriter follower (τ 260 ms, floor 0.4 char/frame) whose
  Markdown re-parse is throttled to a cadence adapted to the last parse cost
  (`clamp(lastCost*6, 16, 500 ms)`, measured in a `useLayoutEffect`), killing the O(n²) re-parse jank.
  A blinking `.stream-caret` marks the live block; `prefers-reduced-motion` disables it. Non-streaming
  messages render directly.
- **Auto-scroll** (`src/client/Chat.tsx`): the transcript follows the bottom via a rAF loop while a
  turn runs, throttled to one write / 150 ms, gated by a `following` flag (set by the user's scroll
  distance <48 px) and suspended while touching; a forced jump happens when a message is appended and
  when the turn ends.
- **Per-turn stats**: the token bar shows `⏱ {elapsed}s · ~{liveOut} tok · {liveRate} tok/s` while
  running (live output estimated from the streaming text length / 4), alongside the cumulative
  input/output/cost read from `/api/reasoning-stats`.
- **Queue/steer (B6 decision: client-side queue)**: sending while a turn runs appends to a client
  queue, shows a `.chat-bubble.user.pending` bubble, and starts the next prompt automatically when the
  turn ends. The composer shows Send and Stop together so a message can be queued mid-run.
- **Compression**: `hono/compress` is scoped to `/assets/*` only (gzip; `Vary: Accept-Encoding`), so
  the SSE endpoint (`/api/copilotkit`) and JSON APIs are never compressed/buffered.
- **Cache policy** (`src/server/index.ts`): `/assets/*` → `immutable`; **`/dots/*` → `public, max-age=86400`**
  (avatar art, incl. state clips — rename a file when its drawing changes); everything else (the SPA
  shell) → `no-store`.

## Avatar & intervention (Phase C, 2026-10-11)

Reference: `nathaninline/ajean` (Jean avatar/stage). NevaDots keeps its own robot avatars in
`public/dots/`: six still PNGs (`blue,pink,green,mint,orange,purple`) plus two animated robots —
`robot` (green) and `robot-blue` (LEO) — each a base webp + per-state clips (`robot-<state>.webp`,
`robot-blue-<state>.webp`; see the custom-avatar notes below).

- **Living avatar** (`src/client/Mascot.tsx`): non-`small` mascots run a single `requestAnimationFrame`
  spring loop (damped springs) that leans the head toward the pointer (proximity-normalised, wanders
  after 6 s idle), bobs per state (`idle`/`working`/`thinking`/`listening`/`writing`/`complete`),
  hops + squashes on click, and only runs while visible. `prefers-reduced-motion` disables it. A live
  body renders a `.dot-layers` wrapper holding **two stacked `<img class="dot-body">`**; the spring
  transforms that wrapper (not the img), and the CSS state animations are neutralised for
  `.mascot.live .dot-body` (`refonte.css`).
- **Per-Dot avatar**: `Dot.avatar` (an id from `src/shared/avatars.ts`, or `null`) — column +
  migration, `PUT /api/dots/:id/avatar`, `setDotAvatar`, and inclusion in the Dot create/update body;
  a swatch picker in the Dot dialog and the Muse profile tab. `src/shared/avatars.ts` is the single
  source of truth (`AVATAR_IDS`, `AVATAR_FILES` id→file, `avatarSrc`); the server's two zod schemas
  (`workspace-routes.ts`) use `z.enum(AVATAR_IDS)`, and all three render sites resolve via `avatarSrc`,
  so an avatar may be a still PNG or an animated WebP without further code. A Dot with `avatar: null`
  falls back to a hash-derived colour over `blue|pink|green` (LEO = `robot`). Static surfaces (sidebar
  rows, conversation cards) use the base file only; live surfaces (welcome hero, Muse header, call
  view, intervention stage, **chat token bar**) swap clips per state (see below).
- **Custom animated avatar (`robot`, 2026-10-13)**: the 7th id maps to `public/dots/robot.webp`, an
  animated WebP produced from a 256 px source GIF with Pillow (`venv-cetas` on LXC 102). The encode
  pipeline: union-bbox crop + 6 % margin (character fills the frame), RGB matted to the sampled edge
  teal (no dark/green fringe), soft (feathered) alpha instead of the GIF's 1-bit mask, one cross-fade
  frame inserted per pair → **24 fps, 240 frames, 224 px, ~980 KB** (alpha_quality 60). Source GIF/APNG
  were 2–9 MB (bad for these gradients); animated WebP is the format to use. Lesson: an animated image
  plays only at its coded frame rate — the browser adds no frames — and the source clip has just
  12 poses/s, so real 60 fps is impossible without interpolation (ffmpeg absent). Asset is versioned
  in `public/dots/` and ships via `vite build` → `dist/client/dots/`.
- **Per-state clips (2026-10-13)**: an avatar may ship one animated WebP per mascot state, declared in
  `AVATAR_STATE_FILES` (`src/shared/avatars.ts`) and resolved by `avatarStateSrc(id, state)` — exact
  state → `null` (caller falls back to the base file). No server/schema change. On a state change,
  `Mascot` pre-decodes the next clip (`new Image().decode`), writes it to the idle `<img>` layer and
  flips `data-active` → a 0.5 s opacity crossfade (`.dot-layers` in `style.css`); the outgoing clip
  keeps looping until it fades. In-flight switches are cancelled/coalesced, so rapid state changes
  never flash.
  - **`robot` (green, 2026-10-13 v2)** ships all 9 states
    `robot-{listening,thinking,analyzing,searching,working,writing,complete,error,paused}.webp` + base
    `robot.webp` (idle). Source: `VERT-mascotte-*.zip` (corrected set). 208 px, **30 fps** (see cadence
    note below).
  - **`robot-blue` (LEO, 2026-10-13)**: 8th avatar id; base/idle = `robot-blue-complete.webp`. Only 5
    real clips ship (`thinking/searching/writing/complete/error`); missing states are **aliased to the
    nearest blue clip** so the color never flicks to green (`analyzing→thinking`, `working→writing`,
    `paused→complete`, and `listening→thinking` **temporarily** until the real `listening` APNG is
    re-exported — its source was truncated). LEO is set to `robot-blue`.
  - All clips: source APNG 320 px / **12 fps** (120 fr / 10 s) → **208 px WebP q72/aq55, 30 fps**
    (300 frames @ 33 ms) by linear resampling (cheap dissolve, not motion interpolation — ffmpeg
    absent). Served `max-age=86400`. Sources in `OffLineFork/AVATAR DOTS/_src/{VERT,BLEU}` (gitignored).
  - **Source cleanup (2026-10-13, hardened `1b3e3ab`)**: the exported APNGs had a **baked-in black
    background**, dark smudges **enclosed by the glow** (unreachable by a border flood fill), and the
    blue set had **green-mascot contamination**. The Pillow+numpy conversion now: floods the
    non-body area from the borders and clears **every dark pixel the outside can reach** (the dark
    visor, enclosed by opaque body, is never reached and survives); keeps only the large connected
    components of the union mask (**removes floating specks**, stable across frames); **decontaminates
    the edge** (partial-alpha pixels borrow the nearest opaque colour); chroma-keys green on blue
    clips; resizes with premultiplied alpha. Residual green specks in the blue `complete`/`working`
    frames remain → a clean re-export of the blue set is the proper fix.
  - **Seamless loop (`1b3e3ab`)**: the source loop did **not** join (last vs first frame differed by
    8–25× a normal step → a visible "pop" every 10 s). The conversion now **dissolves the last 1 s
    (30 frames) toward frame 0**, so `frame[-1] ≡ frame[0]` and the loop plays continuously (seam
    ratio ≤ ~1.8× now). This is a dissolve, not motion interpolation. The state-change crossfade was
    also lengthened to **0.5 s** (`style.css` `.dot-layers`).
  - **Mascot layers**: `Mascot.tsx` renders **one `<img>` at rest** and adds a second only during the
    0.5 s crossfade. Two always-mounted copies of the same animated WebP drift out of sync (double
    image / ghosting) and double the decode cost — this caused the "weird background" seen behind the
    Dot avatars.
- **Muse avatar badge**: `.muse-head .mascot` (Activity panel header only) shows a round light disc
  (`::before`, token-based radial gradient + ring + shadow) behind the avatar, Muse-style; the welcome
  hero keeps its own green halo. `Mascot.tsx`'s rAF loop caches `getBoundingClientRect` (measured on
  pointer/resize/scroll) instead of reading layout every frame.
- **Intervention stage** (`src/client/InterventionStage.tsx`): full-screen overlay opened from the
  chat token bar — shows the Dot's avatar with orbiting dots while running, the streaming answer
  (`StreamingMarkdown`), a caption from the latest activity event, and an inline stop. Rendered from
  React state (no DOM reflection), closed back to the thread.
- **Notifications (C6-lite)**: when a turn finishes while the tab is hidden and permission is granted,
  the client raises a `Notification` (`tag: nevadots-turn`) with an excerpt; a bell toggle in the
  token bar requests permission and remembers the choice. True server Web Push (VAPID + sw.js) is a
  deliberate follow-up.

Deferred: **painted animated eyes** (C2). Reliable automated cleaning of the drawn eye arcs across
all six avatars was not achievable; it needs per-avatar eye coordinates. The body engine above already
provides the "alive" feel.

## Scheduled tasks (Phase D, 2026-10-11)

- **One-shot tasks**: `POST /api/tasks` accepts `runAt` (epoch ms, from the browser's
  `datetime-local`, so it is the user's wall-clock time). A one-shot is stored with
  `intervalSeconds=null` and `nextRunAt=runAt`; `Store.claim` only picks a queued task once
  `nextRunAt IS NULL OR nextRunAt<=now`, and `finish` leaves `nextRunAt=null` when there is no
  interval — so it runs exactly once. Repeating tasks keep the interval model. UI: the schedule
  dialog offers « Répéter » (interval) or « Une seule fois, à une heure précise » (datetime-local).
- **Task results in the activity feed** (`src/shared/activity.ts`): messages flagged by
  `isScheduledTaskMessage` become a `task` activity event (icon `CalendarClock`, verb « tâche
  planifiée terminée »). Scheduled results were already posted into the conversation by the headless
  turn (`src/server/index.ts` + `headless.ts`); the rail now surfaces them too.

Deferred / N-A for NevaDots: **script-only tasks** (no scripts-folder concept; tasks are model-based),
**per-Dot memory modes** (only the existing `memoryAllowed` on/off exists; injected/search/on-demand
would need a memory-search tool), **MCP pre-warm** (connections are few here), and gating the global
3 s workspace poll (it also drives conversations/activity, so it is not task-specific).

## Runtime latency & CopilotKit Intelligence (2026-10-11)

Measured for a fresh "salut" turn (~9 s total): conversation creation
(`CopilotKitIntelligence.createThread`) ~1.35 s, `GET /api/copilotkit/info` ~1.4 s
(Intelligence `getRuntimeEntitlements`, cached after first hit), agent `connect` ~0.3 s, then the model
itself (~2.5 s ttfb). Reusing an existing conversation skips `createThread`.

**Removing Intelligence is not a config flip.** The runtime was switched to `CopilotSseRuntime`
(SSE mode: local `InMemoryAgentRunner`, no hosted round-trips) and the server streamed the answer
correctly (`RUN_STARTED … TEXT_MESSAGE_CONTENT "Salut !" … RUN_FINISHED`, immediately, no `/info`).
But chat does **not** render: in Intelligence mode the `/run` response returns a
`{ joinToken, realtime:{ clientUrl: wss://realtime.intelligence.copilotkit.ai, topic } }` and the
bridge (`@copilotkit/react-core` 1.75, `useAgent({ runtimeAgentId })` → proxied Intelligence agent)
applies answer events from that **realtime WebSocket**. In SSE mode there is no WS, so the client
never applies the inline events → "no response". Using SSE mode therefore requires rewiring the
client agent (HttpAgent / `parseSSEStream` / `useSingleEndpoint`), a non-trivial change. Reverted to
Intelligence mode; the SSE path is documented here as a future option.

Update (2026-10-11): the SSE retry was more thorough. In `CopilotSseRuntime` mode the server streams the
full AG-UI answer (`Content-Type: text/event-stream`, `/info` reports `mode:"sse"`, conversation creation
9 ms, no `createThread`/`/info` round-trips). The client (`@copilotkit/react-core` 1.75) advertises an
SSE path (`ProxiedCopilotRuntimeAgent extends HttpAgent`, `adoptRuntimeMode`, `#runViaHttp` →
`super.run`) yet **applies none of it**: 0 assistant/reasoning bubbles, no console error. Setting
`useSingleEndpoint` makes it POST `/api/copilotkit` and get **403** (different envelope, not handled).
So dropping Intelligence is **not a config switch** — it requires rewiring the client to drive an
`HttpAgent`/AG-UI run directly (bypassing the proxied Intelligence agent). Reverted; chat runs in
Intelligence mode.

**Resolved (2026-10-13, branch `NevaDots-sans-intelligence`).** Intelligence **is** fully removable
with the stock client, no rewiring. The earlier failure was a config/state bug, not a client limit:
with `new CopilotRuntime({ agents, runner })` (no `intelligence` option) the runtime is
`CopilotSseRuntime` (`mode:'sse'`), and `@copilotkit/react-core` 1.75 negotiates it via
`GET /api/copilotkit/info` and runs over plain HTTP+SSE. Key points:
- **No `intelligence` key anywhere** — the presence of the option (not an env var) selects the mode;
  a stale browser session minted while `/info` said `intelligence` (upstream bug #7130) silently
  replays nothing, so clear the key paths and do a hard reload on switch.
- **Durability** = subclass `InMemoryAgentRunner` (`ɵGLOBAL_STORE` is exported) and mirror every run +
  messages snapshot to SQLite, rehydrating that store on construction (`src/server/sqlite-runner.ts`,
  tables `runner_runs`/`runner_threads`). This backs `/threads` and `connect` replay across restarts.
- **Rewired off Intelligence** in the same change: `createConversation` (local UUID → `bindThread`,
  no `createThread` → **no more 503**), delete, `history()`, `page-service` transcript, and the
  headless turn (`Platform.turn` runs the `DotAgent` in-process via the runner, for scheduled tasks and
  voice). **AG-UI gotcha**: `AbstractAgent.prepareRunAgentInput` rebuilds the run input from **`this.threadId`
  and `this.messages`**, ignoring the `input` passed to `runAgent` — a hand-built input is silently
  discarded. So a headless turn must seed the agent first (`agent.threadId = threadId;
  agent.setMessages([...prior, userMessage])`) or the run hits a random threadId and empty history
  (symptom: scheduled task fails in ~5 ms with "Conversation does not belong…"). Fixed in `9cd024c`.
  Removed: learning skills (`learnedSkills`) and Slack Channels (`channels` throws in SSE
  mode); `setupStatus` no longer requires an intelligence key; CSP `connect-src` drops the hosted
  `wss://realtime…`. Consequence: ~1.35 s `createThread` + ~1.4 s `/info` latency per turn disappear.
- Verified live: `/info` → `mode:"sse"`, agent registered, Playwright round-trip (send → reply →
  **transcript replayed after reload**), zero 503/console errors. 330 tests pass.
- Still external (independent, non-blocking): CopilotKit **telemetry** (`telemetry.copilotkit.ai`,
  `setup-telemetry.ts`); Slack module kept but unwired (`slack-channel.ts` used for logging helpers).

## Public domain — nevadots.example.com (2026-10-13)

- **DNS** `nevadots.example.com` → `203.0.113.10` (même IP publique que `nws`), NAT 80/443 → **LXC 105**.
- **nginx sur 105 uniquement** (`/etc/nginx/sites-available/nevadots.conf`, symlink dans `sites-enabled`) :
  `:80` webroot acme → certbot (`--webroot -w /var/www/certbot -d nevadots.example.com`, compte
  existant, ECDSA, expire 2027-01-11) ; `:443 ssl http2` proxy → `http://10.0.0.102:4310`, avec
  `map $http_upgrade $nv_conn` (WS screencast) et **SSE sans buffering** (`proxy_buffering off`,
  `proxy_read_timeout 3600s`, `X-Accel-Buffering no`) sur `/api/copilotkit` ; `client_max_body_size 25m` ;
  `gzip on`. Pas de module brotli (nginx 1.26.3).
- **App 102** : `.env` → `HOST=0.0.0.0` (joignable sur le LAN 10.0.0.0/24 ; protégé par OWNER_TOKEN
  + contrôle same-origin) et `APP_ORIGIN=https://nevadots.example.com,http://127.0.0.1:4310,http://localhost:4310`
  (garde l'accès local). Aucun changement de code : `APP_ORIGIN` (`src/server/app-origin.ts`) et, sans
  lui, le contrôle d'origine est same-origin (`app.ts`).
- L'accès direct local reste : `http://127.0.0.1:4310` (login au token d'owner).
- **Gotcha `Origin: null` (2026-10-19)** : certains navigateurs (durcis / contextes
  particuliers) envoient littéralement `Origin: null` même en same-origin — visible dans
  `journalctl -u opendots` via le log `[origin] rejected Origin null`. Le middleware
  (`src/server/app.ts`) exempte `"null"` du test d'allowlist ; la protection reste assurée
  par `Sec-Fetch-Site: cross-site → 403` (en-tête navigateur, infalsifiable par un site).
  nginx 105 ne touche pas à `Origin`, rien à y changer.

## Public domain — nevspot.example.com (2026-10-23)

- **DNS** `nevspot.example.com` → `203.0.113.10` (déjà présent chez OVH), NAT 80/443 → **LXC 105**.
- **nginx sur 105 uniquement** (`sites-available/nevspot.conf`, symlink `sites-enabled`) :
  `:80` webroot acme → certbot (`--webroot -w /var/www/certbot -d nevspot.example.com`,
  expire 2027-01-21) ; `:443 ssl http2` proxy → `http://10.0.0.102:8444` (**admin NevSpot**,
  pas le portail `:8095` qui reste LAN). Headers `Host`/`X-Real-IP`/`X-Forwarded-For`/
  `X-Forwarded-Proto`, `client_max_body_size 10m`, `gzip on`. Pas de SSE/WS (panneau sans JS).
- **App 102** : `/etc/nevspot/nevspot.toml` (backup `nevspot.toml.bak-20261023`) →
  `[admin] listen = "0.0.0.0:8444"` (était `127.0.0.1:8444`, injoignable depuis 105) et
  `secure_cookies = true` (cookies `Secure` derrière le proxy TLS, cf. contrat `hardening.md`) ;
  `tls_enabled` reste `false` (TLS terminé par nginx). `systemctl restart nevspotd`.
  Vérifié : `POST /login` → 303 + cookie `nevspot_admin` Secure, `GET /` → 200 en public.

## Public domain — portail.nevspot.example.com (2026-10-23, en attente DNS)

- **Vente semi-manuelle (gratuit, sans agrégateur)** : le client déclare son transfert Mobile
  Money sur `/acheter.html` (forfait + numéro + opérateur moov|wave|orange|mtn + référence) →
  `payment_declarations` (migration `0008_payments.sql`, 1 pending max par numéro, token de
  suivi sha256) → l'opérateur valide dans `/paiements` (cap `payments.review` = admin+manager) :
  un code **crédit = prix du forfait sur le plan par défaut** (`advanced_settings`) est émis
  (groupe `vente-ligne`, `sold=true`), visible sur la page d'impression + la page `/suivi.html`
  du client (reveal audité). Le client se connecte avec le code puis achète le forfait sur
  `codeflat.html` (flux standard). Rejet avec motif ; expiration d'affichage 48 h.
- **Proxy trust** : `clientIP()` (portail + admin) n'honore `X-Forwarded-For` que si le pair
  direct est dans `[proxy] trusted` (`/etc/nevspot/nevspot.toml` → `["10.0.0.105"]`, backup
  `nevspot.toml.bak-20261023-pay`). Sans ça, rate-limit/quotas/audit voient tous les visiteurs
  comme une seule IP (le proxy). Config validée au démarrage (`IP ou CIDR`).
- **nginx 105** : `sites-available/portail.conf` (staged, `:80` seul) → `http://10.0.0.102:8095`.
  **Reste à faire** : créer l'A `portail.nevspot.example.com` → `203.0.113.10` chez OVH, puis
  `certbot certonly --webroot -w /var/www/certbot -d portail.nevspot.example.com` + vhost `:443`
  (modèle `nevspot.conf`) + reload. Vérifié en attente : tout le flux de bout en bout testé en
  local (declare → 303 → suivi pending → validation + code → suivi validée → codelogin →
  counter → codeflat → session flat active).

## Front-end perf (2026-10-13)

- **Typo** : Geist Sans + Geist Mono **auto-hébergées** (`public/fonts/*.woff2`, `@font-face` dans
  `src/client/fonts.css`, preload dans `index.html`, cache `/fonts/*` 7 j) — CSP `default-src 'self'`
  interdit un CDN. Échelle relevée (base 14→15px, `+2px` ≤13px sinon `+1px`) sur `style.css`/`refonte.css`/`editor.css`.
- **Bundle** : `vite.config.ts` sépare `vendor-react` et `vendor-copilotkit` (`manualChunks`, compat
  rolldown-vite 8) — l'app passe de ~2,8 Mo à **376 Ko** (117 Ko gzip), les vendors se cachent à part.
  Les packs de langage shiki restent des chunks paresseux.
- **Runtime** : le polling (`/metrics`, `/workspace`, capture) est **suspendu onglet masqué**
  (`document.visibilityState`).

## Raisonnement (réflexion) — gotchas AG-UI (2026-10-13)

Bouton « Réflexion » du composeur (`cycleReasoning`, `dot.reasoningEffort` = `none|low|high`) →
`reasoning_effort` envoyé à LiteLLM. Le provider renvoie `reasoning_content`, capturé par
`createReasoningFetch` (`src/server/reasoning.ts`) qui émet les événements AG-UI `REASONING_*`.

Deux bugs corrigés (`1c2bd18`) qui faisaient que **le modèle ne répondait pas** quand la réflexion
était activée :
- **`REASONING_START` doit porter un `messageId`** (comme le prescrit AG-UI). Sans lui, le client
  `@ag-ui/client` corrompait l'assemblage des messages et **perdait la réponse assistant** (symptôme :
  « Le modèle n'a produit aucune réponse »).
- L'adaptateur TanStack émet **son propre** message de raisonnement, jamais fermé → doublon qui
  cassait le flux. On **filtre les `REASONING_*` de l'adaptateur** dans la souscription (`dot-agent.ts`)
  et on garde les nôtres (bien formés).
- On ferme la phase de raisonnement **dès le premier delta de contenu** (`onAnswerStart`) pour que
  l'ordre AG-UI reste valide (raisonnement terminé avant le texte), tout en continuant à collecter
  l'usage jusqu'à `[DONE]` (stats).
- Le panneau droit (`ReasoningPanel`) s'ouvre en **live** pendant la réflexion puis se replie à la fin ;
  le raisonnement s'affiche aussi **en ligne** dans le transcript (« Raisonnement »). `/reasoning-stats`
  renvoie `{}` quand absent → le client le normalise en `null` (sinon « NaN s »).
