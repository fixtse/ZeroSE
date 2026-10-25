# Isolated validation

Use Node 22 and the pinned pnpm via Corepack. The post-create command installs
locked dependencies. Start a disposable test PostgreSQL/pgvector instance:

```sh
docker run -d --name assistant-test-db -p 127.0.0.1:55432:5432 -e POSTGRES_DB=assistant_test -e POSTGRES_USER=assistant -e POSTGRES_PASSWORD=test-only-password pgvector/pgvector:0.8.7-pg17-bookworm
pnpm format:check
pnpm check
pnpm test
pnpm build
ASSISTANT_POSTGRES_PASSWORD=compose-validation-only docker compose config --quiet
ASSISTANT_POSTGRES_PASSWORD=compose-validation-only docker compose -f compose.yaml -f compose.build.yaml config --quiet
```

`TEST_DATABASE_URL` points only to this disposable database. Do not supply live
integration credentials for tests. Development startup uses `pnpm dev` with a
private development config and database; never copy production config or data.
Docker images are built by GitHub Actions. Callback notifications use a private
Codespaces secret supplied by the current T3 thread; never commit its value.

For real Home Assistant lifecycle smoke checks, use Python 3.14 in the Codespace:

```sh
python3.14 -m venv /tmp/assistant-ha-venv
/tmp/assistant-ha-venv/bin/pip install -r test/ha_runtime/requirements.txt
/tmp/assistant-ha-venv/bin/python test/ha_runtime/verify.py
```
