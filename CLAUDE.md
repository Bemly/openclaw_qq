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
