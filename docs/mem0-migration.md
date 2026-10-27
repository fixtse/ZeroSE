# Long-term memory with Mem0 OSS

Zero uses the pinned TypeScript `mem0ai/oss` SDK with its native PostgreSQL vector
store. There is no Mem0 Cloud account, Mem0 API key, additional service or second
LLM required. Existing AI provider settings still select embeddings. Mem0 SDK
telemetry is disabled before the SDK loads. Mem0's `infer: true` pipeline extracts
new memories from each completed user/assistant exchange using the profile's approved
AI model, with application tools disabled. A separate job runs in the same chat queue,
so inference failures do not prevent delivery of the conversational reply. Disabled
memory queues no extraction. Commands, failed turns and historical pending messages
are not submitted automatically. Existing queued consolidation jobs retire without
replaying their history; `schedules.consolidate` and `memory.categories` are ignored
when loading legacy settings and no longer appear in the admin UI.

Inference runs in an isolated worker with an ephemeral in-process workspace. At most
three already scoped/ranked memory summaries are supplied as candidates; its constant
scratch vector includes all of those candidates and is not a semantic embedding.
The configured embedding provider computes durable pgvector embeddings only when
Zero publishes the extracted records through its existing stable-handle write path.
Simple mode makes no embedding-provider requests. No second persistent memory store,
entity index, integration credentials or database connection is exposed to inference.
The global Memory section is no longer exposed or editable in service settings.
AI providers own model and embedding settings; each user/group profile owns its memory
mode. Legacy internal values remain private to preserve existing storage aliases,
embedding capacity and migration compatibility.
Categories/tags and faithful summaries are inferred per record, without a predefined
list. Existing stored categories remain discoverable and filterable on demand.

Publication rechecks access, memory mode and shared-profile identity after inference
and before each save. Writes retain source deduplication and uncertain-write guards.
There is no automatic retry of failed inference jobs or uncertain publications.

The existing tool names and numeric IDs stay unchanged. Profiles map to Mem0's
`user_id`; shared profiles, disabled memory, keyword-only mode, categories, date
filters, bounded summaries and detail pagination retain their existing contracts.
Conversations, queues, user context, Google and Home Assistant are unchanged.

## Manage a user's memory

Open **Usuarios**, choose the profile and select **Memoria**. The tab supports
paginated browsing, literal text/tag search, category filtering, full-text details,
manual creation, correction and confirmed deletion. Corrections supersede the old
record through the existing Zero memory port. Disabling memory blocks creation and
correction while leaving existing records available for inspection or deletion.

The existing administrator authentication protects these endpoints. Their scope is
resolved from the saved profile, existing Home Assistant/Telegram bindings and the
owner's configured memory alias; clients cannot supply a storage profile or a list
of superseded IDs. Other users and groups retain their separate memory scopes.
The tab, filters, page, selected record and open editor are restored through URL
parameters. Memory operations do not save the profile's other settings.

## Offline migration

This is an explicit production operation, requiring deployment authorization.
Do not run it against the live database as part of code validation. Take a private
database backup and stop the assistant before applying the migration. Use the
intended private `ASSISTANT_DATABASE_URL`, never a URL in shell history or source.

```sh
pnpm memory:migrate          # inspect counts without modifying the database
pnpm memory:migrate --apply  # apply schema and import, with the assistant stopped
```

The import is transactional and verifies every non-forgotten text, summary,
category, tag, embedding, timestamp, profile and supersession link before committing.
It preserves numeric IDs and consolidation source keys, imports tombstones without
their content, and advances the new identity sequence. It makes no LLM or embedding
calls. The `mem0:v1` import marker makes an already completed import a no-op.
An existing nonempty Mem0 destination without that marker fails for inspection.
Startup refuses an unmigrated legacy database rather than silently falling back.
After success, start the new version and verify scoped search, read and browsing.

The former `memories` table remains an offline rollback archive; runtime memory
reads and saves use `zero_mem0_records` and `zero_mem0_vectors`. Explicit deletion
also scrubs a matching legacy record, so the archive cannot resurrect deleted
content. It does not erase private backups. Do not restart an older version after
new Mem0 writes: its archive will not contain those writes. Back up and reconcile
changes explicitly before rolling back.

## Writes and recovery

The numeric-handle table tracks `pending`, `ready` and `forgotten` records. A write
first reserves a handle, then calls the SDK, and finally publishes it together with
any supersessions in one PostgreSQL transaction. Staged vectors are invisible to
search, browsing and reads. Concurrent corrections recheck active scoped handles
before publication. A source already ready or forgotten is never added again.

An SDK failure, crash or timeout can leave a pending handle and an invisible staged
vector. Zero does not replay these uncertain writes. Inspect their IDs, profile,
source and associated `zero_id` payload privately before taking an explicit recovery
action. Do not retry extraction or delete pending rows blindly. The operation
must either be reconciled as the original write, or explicitly discarded before
the user requests a new write. Payloads and vectors remain private database data.

SDK calls run in isolated workers to close all SDK-owned PostgreSQL clients on
completion or timeout and keep SDK diagnostics out of application logs. Workers
receive only the already computed vector and the scoped operation; no integration
credentials are needed. Keyword-only searches stay in PostgreSQL. Advanced search
uses Mem0's ranking, combined with scoped lexical results so imported records with
no embedding remain discoverable. Different embedding spaces are never compared.

## Validation

Use an isolated Codespace with `TEST_DATABASE_URL` pointing to a disposable
PostgreSQL/pgvector database. `test/mem0.test.ts` exercises the real OSS SDK, offline
import, stable IDs, metadata, profile isolation, date/category/embedding-space
filters, supersessions, deletion, source deduplication and uncertain writes.
Run the project's required format, type, test, build and Compose checks there.

## Retrieval enhancements

Mem0 extraction can return bounded entity names, explicit attributed relationship triples
and an optional user-requested expiration timestamp. Metadata lives in the existing
payloads; no destructive migration or secondary service is required. Retrieval performs
one-hop relation expansion within the same active profile and applies category/date,
supersession and expiration filters to every candidate source. The AI settings reranking
tab selects an optional registered model for the final relevance stage, after scoped
retrieval and before result budgets. Existing records without metadata remain compatible.

The SDK's expiration API accepts calendar dates only. Zero stores the exact UTC timestamp
separately and enforces it consistently across assistant recall and discovery. Admin
inspection and deletion remain available after expiration; clearing expiration by correction
creates a new stable record with the existing supersession semantics. No automatic purge,
corpus reanalysis or replay occurs.
