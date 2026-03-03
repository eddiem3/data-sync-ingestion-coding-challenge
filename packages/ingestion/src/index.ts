import { Pool } from 'pg';
import { setupDatabase } from './db';
import { ApiClient } from './api-client';
import { runIngestion } from './ingester';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const apiBaseUrl = process.env.API_BASE_URL;
  const apiKey = process.env.TARGET_API_KEY;

  if (!databaseUrl) throw new Error('DATABASE_URL environment variable is required');
  if (!apiBaseUrl) throw new Error('API_BASE_URL environment variable is required');
  if (!apiKey) throw new Error('TARGET_API_KEY environment variable is required');

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    console.log('Setting up database schema...');
    await setupDatabase(pool);

    const apiClient = new ApiClient({ baseUrl: apiBaseUrl, apiKey });

    console.log('Starting ingestion...');
    const startTime = Date.now();

    const total = await runIngestion(pool, apiClient);

    const durationMin = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`ingestion complete`);
    console.log(`Total: ${total.toLocaleString()} events ingested in ${durationMin} minutes`);
  } finally {
    await pool.end();
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
