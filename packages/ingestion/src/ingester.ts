import { Pool } from 'pg';
import { ApiClient } from './api-client';
import { batchInsertEvents, loadCheckpoint, markComplete, saveCheckpoint } from './db';

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

export async function runIngestion(pool: Pool, apiClient: ApiClient): Promise<number> {
  const checkpoint = await loadCheckpoint(pool);

  if (checkpoint.completed) {
    log('Ingestion already complete, skipping.');
    return checkpoint.eventsIngested;
  }

  let cursor = checkpoint.lastCursor;
  let totalIngested = checkpoint.eventsIngested;

  if (cursor) {
    log(`Resuming from checkpoint: ${totalIngested.toLocaleString()} events already ingested`);
  } else {
    log('Starting fresh ingestion from the beginning');
  }

  let pageNum = 0;

  while (true) {
    pageNum++;

    // Fetch current page
    const page = await apiClient.fetchEventsPage(cursor);

    // Pre-fetch next page in parallel with DB write if rate limit allows
    let nextPagePromise: ReturnType<typeof apiClient.fetchEventsPage> | null = null;
    if (page.pagination.hasMore && page.pagination.nextCursor && apiClient.rateLimitRemaining >= 2) {
      nextPagePromise = apiClient.fetchEventsPage(page.pagination.nextCursor);
    }

    // Write current batch to DB
    const inserted = await batchInsertEvents(pool, page.data);
    totalIngested += inserted;

    // Save checkpoint: store the cursor we just consumed so we can resume after this page
    await saveCheckpoint(pool, page.pagination.nextCursor, totalIngested);

    // Log progress every ~50k events or on last page
    if (totalIngested % 50000 < page.data.length || !page.pagination.hasMore) {
      const pct = ((totalIngested / 3_000_000) * 100).toFixed(1);
      log(`Progress: ${totalIngested.toLocaleString()} / 3,000,000 events (${pct}%) — page ${pageNum}, batch size ${page.data.length}, inserted ${inserted}`);
    }

    if (!page.pagination.hasMore) {
      break;
    }

    cursor = page.pagination.nextCursor;

    // If we pre-fetched the next page, use it on the next iteration
    if (nextPagePromise) {
      // Await the pre-fetched page and process it immediately
      const nextPage = await nextPagePromise;

      // Write next batch to DB
      const nextInserted = await batchInsertEvents(pool, nextPage.data);
      totalIngested += nextInserted;
      pageNum++;

      await saveCheckpoint(pool, nextPage.pagination.nextCursor, totalIngested);

      if (totalIngested % 50000 < nextPage.data.length || !nextPage.pagination.hasMore) {
        const pct = ((totalIngested / 3_000_000) * 100).toFixed(1);
        log(`Progress: ${totalIngested.toLocaleString()} / 3,000,000 events (${pct}%) — page ${pageNum}, batch size ${nextPage.data.length}, inserted ${nextInserted}`);
      }

      if (!nextPage.pagination.hasMore) {
        cursor = null;
        break;
      }

      cursor = nextPage.pagination.nextCursor;
    }
  }

  await markComplete(pool, totalIngested);
  return totalIngested;
}
