# Security review before publication

The October 2026 review covers the tracked source and locally available Git history.
It does not authorize publication, deployment, credential rotation, or changes to
live Telegram, Google, or Home Assistant integrations.

## Dependency protections

Zod is pinned to 4.6.7, including transitive consumers, to address
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
The workspace override also replaces Mem0's Zod 3 dependency. Mem0's configuration,
inference, migration, search, and storage paths must remain covered by the real
memory tests when this override changes. A regression test verifies that oversized
bounded arrays, sets, and maps reject input before visiting individual elements.

ExcelJS uses UUID 11.1.1 through a scoped override to address
[GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
The XLSX regression test writes a workbook with ExcelJS and extracts it through
Zero's document adapter. Do not remove either override until upstream dependencies
resolve to corrected, compatible versions.

## Pairing admission

Public pairing requests have independent per-socket-peer limits for initiation and
exchange, smaller request-body limits, HTTP 429 responses, and `Retry-After` hints.
Invalid requests count toward the quota. The limiter bounds its peer map and does
not evict active quotas to admit new peers. It ignores untrusted forwarding headers.
Reverse-proxy clients share their proxy's quota; configure trusted edge limits for
individual clients and distributed attacks. These process-local limits reset on
restart and supplement the existing handshake capacity, expiry, administrator
approval, and single-use exchange protections.

## Secret scanning

Use Gitleaks 8.30.1 with the repository's `.gitleaks.toml`, default rules, full Git
history, and complete redaction:

```sh
gitleaks git --config .gitleaks.toml --redact=100 --log-opts="--all" .
```

Also scan an export of tracked and intended new source files with `gitleaks dir`
before committing. Keep reports and runtime backups private. The configuration
exempts only three reviewed, literal test/CI credentials in their exact file paths;
it does not exclude test directories, commits, or production credential patterns.
New findings require review rather than expanding exclusions to entire files.

The initial administrator registration behavior remains unchanged by explicit
request. Complete it on a trusted connection before exposing a new installation.
Secret scanning does not establish that commit metadata, images, free text, issues,
logs, or artifacts contain no personal information; review those separately before
making the repository public.
