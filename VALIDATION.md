# Validation — 2026-10-16

Implemented as TypeScript with pnpm 11.28.6 and hexagonal boundaries. Storage uses PostgreSQL with pgvector; integration tests use isolated schemas.

## Passed

- TypeScript type checking and compilation.
- 17 automated tests covering ingress authentication, duplicate updates, per-session ordering,
  cross-session concurrency, interrupted-action handling, delivery failures, memory isolation,
  resets, DST, Home Assistant write verification, OAuth isolation, Codex RPC, architecture,
  and optional Telegram polling.
- Docker build and container health check.
- Reusing `<private-codex-directory>` through the container's `/codex` mount.
- Real Codex dynamic tool invocation using the shared login.
- Full request through the running container: authenticated `/v1/chat` → durable job → Codex →
  `shopping_list_get` → Home Assistant → result `1`. The audit recorded only that read tool.
- Real structured memory consolidation on synthetic data in a temporary database; one fragment
  was created without modifying the production memory corpus.
- Google Calendar, Tasks, and personal-context Docs reads using separate OAuth grants.
- Telegram bot identity and existing webhook inspection.
- Gemini embeddings returned 3072 dimensions matching the memory corpus.
- Home Assistant reads: 192 sensor entities and the configured shopping list.
- Edge TTS plus ffmpeg produced a valid Ogg voice response; no Telegram message was sent.
- Existing ASR service is reachable over the private network.
- Pangolin public health returned 200; unauthenticated webhook requests returned 401;
  an authenticated no-message webhook check returned 200 without queuing work.
- Telegram registration verified at `https://assistant.example.com/telegram/webhook`, with zero
  pending updates and no webhook error reported.

## Remaining

- Representative user acceptance conversations and live write-operation checks.
- End-to-end attachment transcription, calendar/task/document mutations, and scheduled
  notification delivery have not yet been exercised against production accounts.
- A before/after latency benchmark has not been established.

PostgreSQL checks cover the exclusive execution lease, concurrent queue claims,
deduplication, full-precision reranking over a halfvec HNSW index, and filtered search.
The SQLite importer was rehearsed against a consistent production snapshot: all 117
memories and the other state tables matched. A regression test verifies transaction
rollback on malformed vectors, identity-sequence continuation, and overwrite rejection.
