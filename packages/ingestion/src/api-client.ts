import { ApiEvent } from './db';

interface Pagination {
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;
  cursorExpiresIn: number | null;
}

interface Meta {
  total: number;
  returned: number;
  requestId: string;
}

export interface EventsPage {
  data: ApiEvent[];
  pagination: Pagination;
  meta: Meta;
}

interface ApiClientConfig {
  baseUrl: string;
  apiKey: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ApiClient {
  private baseUrl: string;
  private apiKey: string;
  rateLimitRemaining: number = 10;
  private rateLimitReset: number = 60;

  constructor(config: ApiClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  async fetchEventsPage(cursor: string | null): Promise<EventsPage> {
    const params = new URLSearchParams({ bulk: 'true', limit: '10000' });
    if (cursor) params.set('cursor', cursor);

    const url = `${this.baseUrl}/events?${params}`;

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        console.log(`Retry attempt ${attempt}, waiting ${backoffMs}ms...`);
        await sleep(backoffMs);
      }

      let response: Response;
      try {
        response = await fetch(url, {
          headers: { 'X-API-Key': this.apiKey },
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`Network error on attempt ${attempt + 1}: ${lastError.message}`);
        continue;
      }

      // Parse rate limit headers from every response
      const remaining = response.headers.get('X-RateLimit-Remaining');
      const reset = response.headers.get('X-RateLimit-Reset');
      if (remaining !== null) this.rateLimitRemaining = parseInt(remaining, 10);
      if (reset !== null) this.rateLimitReset = parseInt(reset, 10);

      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 65000;
        console.log(`Rate limited (429). Waiting ${waitMs / 1000}s before retry...`);
        await sleep(waitMs);
        attempt--; // don't count this as a retry attempt
        continue;
      }

      if (response.status >= 500) {
        lastError = new Error(`Server error ${response.status}`);
        console.error(`Server error ${response.status} on attempt ${attempt + 1}`);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }

      const data = (await response.json()) as EventsPage;

      // Proactively wait if we're close to exhausting the rate limit
      if (this.rateLimitRemaining <= 1) {
        const waitMs = (this.rateLimitReset + 1) * 1000;
        console.log(`Rate limit nearly exhausted (${this.rateLimitRemaining} remaining). Waiting ${this.rateLimitReset + 1}s for reset...`);
        await sleep(waitMs);
      }

      return data;
    }

    throw lastError ?? new Error('Max retries exceeded');
  }
}
