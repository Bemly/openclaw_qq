# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

This is an OpenClaw plugin — it has **no standalone build step**. TypeScript sources are loaded and transpiled at runtime by the OpenClaw framework. `pnpm build` in the README refers to the OpenClaw framework build, not this plugin.

To test changes: restart the OpenClaw gateway (`openclaw gateway restart`) after editing.

There is no `tsconfig.json`, no test suite, and no lint/format configuration in this repository.

## Architecture

```
index.ts                     # Plugin entry point — registers qqChannel with OpenClaw
src/
  channel.ts  (~4400 lines)  # All business logic: message handling, session queues, media caching, reply/forward context, model catalog, inline commands, temp sessions
  client.ts                  # OneBot v11 WebSocket/HTTP transport client (OneBotClient extends EventEmitter)
  config.ts                  # Zod schema for all QQ config (heavy use of z.preprocess for web form string coercion)
  runtime.ts                 # Thin holder for PluginRuntime reference
  types.ts                   # OneBot protocol type definitions
```

`channel.ts` is the single large module where nearly all logic lives. Key internal structures:

- **Session queues** (`SessionQueue`, `Map<sessionKey, SessionQueue>`): Inbound messages are enqueued per session key, debounced via `queueDebounceMs`, and drained sequentially. This implements concurrency merging and "new message interrupts old reply" (`interruptOnNewMessage`).
- **Media caching**: `cacheInboundImagesToLocal` path downloads QQ images to local disk (`cacheOneBotImageLocally` → `buildImageCachePath`), enabling multimodal agents to read them.
- **Reply/forward context**: `buildReplyForwardContextBlock` recursively resolves reply chains and forward messages, injecting layered context with configurable depth/character limits.
- **Block streaming**: When `blockStreaming=true`, commentary/final answers are buffered per assistant message boundary and sent as complete chunks rather than token-by-token.
- **Temp sessions** (`/临时`): Session isolation via `::tmp:<name>` suffix in session keys, managed by inline command parsing.

## Configuration

All config lives in the user's `openclaw.json` under `channels.qq`. The Zod schema in `config.ts` uses `z.preprocess` extensively to coerce web form string inputs (e.g., comma-separated ID lists, loose boolean strings like "true"/"yes"/"1") into proper types. This is the single source of truth for config shape.

## Deployment (production NAS)

Target: `fnOS` (飞牛 NAS, similar to Synology DSM), defined in `~/.ssh/config` as `192.168.1.162` user `bemly`. Plugin path: `/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/qq/`

The NAS runs a `trim.openclaw` package. The OpenClaw gateway runs as `trim.openclaw` user (uid=951), while CLI commands run as `bemly` (uid=1000).

**Critical ownership conflict:**

Both the CLI and gateway perform a "suspicious ownership" check on the extension directory. They each require the directory owner to match their own uid (or root). Since the two processes run as different users with different uids, **no single owner satisfies both**. The only common ground is root, which `bemly` cannot set.

- CLI (`bemly`, uid=1000) requires: uid=1000 or root
- Gateway (`trim.openclaw`, uid=951) requires: uid=951 or root

**Deploy workflow (do ALL steps in order):**

```bash
# 1. Commit and push to GitHub
git add <changed files>
git commit -m "..." && git push origin main

# 2. Push source files to NAS (requires sshpass)
sshpass -p '<pw>' scp src/<changed1> src/<changed2> ... fnOS:'/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/qq/src/'

# 3. Compile TS → JS on NAS (tsc with type errors is ok, JS still emits)
sshpass -p '<pw>' ssh fnOS 'export PATH="/vol1/@appcenter/nodejs_v22/bin:$PATH" && cd /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/qq && npx tsc'

# 4. Fix ownership
sshpass -p '<pw>' ssh fnOS 'chown -R trim.openclaw:trim.openclaw /vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/qq/'
```

**5. Restart via NAS web UI** — the CLI cannot restart the gateway due to the ownership conflict. Go to 飞牛 NAS web interface → 套件中心 (app center) → stop then start `trim.openclaw`.

To verify: use the NAS web UI's OpenClaw monitor, or run:
```bash
sshpass ssh fnOS 'export PATH="/vol1/@appcenter/nodejs_v22/bin:/vol1/@apphome/trim.openclaw/data/home/.openclaw/extensions/qq/node_modules/.bin:$PATH" && HOME=/vol1/@apphome/trim.openclaw/data/home openclaw channels status'
```
Look for `qq default: running`.

**Important notes:**

- Do NOT run `npx tsc` — the remote `tsconfig.json` has `strict: true` but the source has pre-existing type errors. OpenClaw loads TS at runtime.
- Only change files under `src/`. Do not modify `index.ts`, `openclaw.plugin.json`, or `package.json` unless the remote OpenClaw SDK version advances (currently 2026.4.24).
- Node.js is at `/vol1/@appcenter/nodejs_v22/bin` on the NAS.
