# DataSync Ingestion Solution

This repository contains a TypeScript + PostgreSQL ingestion service for the DataSync Analytics challenge.

The service pulls events from the DataSync API and writes them into Postgres with resumable checkpointing.

## Tech Stack

- TypeScript (Node.js 20)
- PostgreSQL 16
- Docker / Docker Compose

## How To Run

### 1. Set your API key

Create a local env file from the example and set `TARGET_API_KEY`:

```bash
cp .env.example .env
# edit .env and set TARGET_API_KEY
```

or run with an inline env var:

```bash
TARGET_API_KEY='YOUR_KEY' sh run-ingestion.sh
```

### 2. Start ingestion

```bash
sh run-ingestion.sh
```

This script:
- builds and starts containers
- waits for startup
- polls `ingested_events` count every 5s
- exits when logs contain `ingestion complete`

### 3. Manual monitoring (optional)

```bash
docker logs -f assignment-ingestion
```

```bash
docker exec assignment-postgres psql -U postgres -d ingestion -c "SELECT COUNT(*) FROM ingested_events;"
```

```bash
docker exec assignment-postgres psql -U postgres -d ingestion -c "SELECT * FROM ingestion_state;"
```

## Architecture

### Components

- `packages/ingestion/src/index.ts`
  - bootstraps DB
  - creates API client
  - runs ingestion loop
- `packages/ingestion/src/api-client.ts`
  - calls `/events`
  - applies retry/backoff for network and 5xx
  - handles `429` using `Retry-After` and `X-RateLimit-*` headers
- `packages/ingestion/src/ingester.ts`
  - fetches pages
  - prefetches next page when budget allows
  - batch-inserts into DB
  - stores checkpoint (`cursor`, `events_ingested`)
- `packages/ingestion/src/db.ts`
  - schema setup
  - bulk inserts with `ON CONFLICT DO NOTHING`
  - checkpoint load/save/complete

### Data model

- `ingested_events`
  - primary key: `id`
  - flattened event/session fields
  - timestamp normalized to `TIMESTAMPTZ`
- `ingestion_state`
  - single row (`id=1`)
  - `last_cursor`
  - `events_ingested`
  - `completed`

### Resumability model

On restart, ingestion reads `ingestion_state` and resumes from saved cursor.

## API Discoveries

From exploration + runtime behavior:

1. `bulk=true` on `/events` is important for throughput.
2. Sending `limit=10000` with `bulk=true` returns `5000` events per page in practice.
3. Rate-limit headers are critical:
   - `X-RateLimit-Limit`
   - `X-RateLimit-Remaining`
   - `X-RateLimit-Reset`
   - `Retry-After` on 429
4. `/events` and `/metrics` can have different limits (observed `/events` lower).
5. Cursors can expire; stale cursor handling is required for robust long-running ingestion.
6. Timestamps are mixed (epoch and ISO string), so normalization is required.

## Challenges Encountered / Errors Made

### 1. Worker parallelism vs shared key rate limits

Running multiple workers against one key frequently produced 429 storms and low effective progress.

### 2. Cursor expiry under heavy throttling

With repeated 429 delays, previously issued cursors could expire and fail resumes.

### 3. Progress metric pitfall

Using inserted-row count as the only progress metric can mislead during duplicate-heavy replay paths (`ON CONFLICT DO NOTHING`), because fetched pages may advance while inserts remain flat.

### 4. State/schema migration mismatch

Switching between single-worker and multi-worker checkpoint schemas caused runtime errors until state table shape was aligned.

### 5. Operational mistake: resetting Docker volume

`docker compose down -v` deletes Postgres volume and prior ingested progress.

### 6. Transient data quality/runtime issues

Occasional malformed timestamp payloads and intermittent 5xx responses required retries and robust error handling.

## Throughput Notes

Observed throughput varied with API key state and rate limits. In healthy periods, ingestion progressed in 5k-page increments quickly; in degraded periods, 429 and 5xx dominated runtime.

## Postmortem: Throughput Experiments

This section summarizes what was tried and what was learned under live API conditions.

### Overall summary

I first got a stable single-worker implementation running, with an expected completion time around ~1 hour based on observed throughput. After that baseline was working, I spent the remainder of the session trying to push throughput with multi-worker approaches. During that phase I hit a resumability/progress bug where restarts were not advancing correctly, and while recovering I eventually reset Docker volumes to continue. I did not back up the existing Postgres volume first, which caused loss of previously ingested data and cost significant time.

### Baseline that worked

- Single worker with `bulk=true` and large page size.
- Effective page size observed from API: 5000 events/page.
- Practical rate observed during stable periods: roughly 600-700 events/second.
- Approximate full-run projection from those periods: around 65-80 minutes.

### Experiments that did not improve results

1. Parallel worker partitioning with one API key
   - Attempt: multiple workers reading different offsets concurrently.
   - Observation: frequent 429 storms and low useful insert throughput.
   - Conclusion: with one key and tight `/events` bucket, uncontrolled parallelism reduced effective throughput.

2. Aggressive prefetch under tight rate limits
   - Attempt: fetch next page in parallel while writing current page.
   - Observation: can help in healthy windows, but during heavy throttling it increased retries and instability.
   - Conclusion: prefetch is conditional optimization, not universally beneficial.

3. Schema/model switching during active run
   - Attempt: switching between single-worker and per-worker checkpoint models.
   - Observation: table-shape mismatches caused runtime failures and restart loops until state schema was aligned.
   - Conclusion: checkpoint schema changes need migration/versioning guardrails.

### Key operational lessons

1. Rate limits dominate architecture choices with a single key.
   - In this environment, maximizing request quality (`bulk=true`, large pages) was more effective than maximizing worker count.

2. Insert count alone is not enough for progress visibility.
   - With `ON CONFLICT DO NOTHING`, fetched pages can advance while inserts appear flat, especially after partial replays.

3. Avoid destructive resets during timed runs.
   - `docker compose down -v` removes Postgres state and destroys accumulated progress.

## What I Would Improve With More Time

1. Add explicit stale-cursor recovery path that falls back to offset/bootstrap logic.
2. Separate "fetched" vs "inserted" counters in persisted state for more accurate resume and monitoring.
3. Add migration-safe schema versioning for checkpoint table changes.
4. Add integration tests for resume scenarios and rate-limit behavior.
5. Add structured metrics endpoint (events/sec, retries, 429 rate, lag to completion ETA).

## AI Tooling Used

I used GPT-based coding assistance (Codex/ChatGPT style workflow) to accelerate implementation, debugging, and iteration on ingestion/retry/resume behavior.
