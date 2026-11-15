/**
 * Minimal GitHub REST client: pagination via Link headers, primary and secondary rate limits,
 * bounded exponential backoff with jitter for transient failures. The token is sent only to
 * api.github.com and never logged.
 */
export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

/** Rate limit whose reset is further away than we are willing to wait: the job pauses. */
export class RateLimitError extends GitHubError {
  constructor(public resetAt: Date) {
    super(429, `GitHub rate limit reached; resets at ${resetAt.toISOString()}`, true);
  }
}

export interface GitHubOptions {
  token?: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  maxRateLimitWaitMs?: number;
  maxPages?: number;
  timeoutMs?: number;
}

const BASE = 'https://api.github.com';
export const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export class GitHubClient {
  readonly stats = { requests: 0, retries: 0, rateLimitWaits: 0 };
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private opts: GitHubOptions = {}) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private backoff(attempt: number) {
    return Math.min(30_000, 500 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
  }

  async request<T = unknown>(pathOrUrl: string): Promise<{ data: T; next: string | null }> {
    const url = pathOrUrl.startsWith('https://') ? pathOrUrl : `${BASE}${pathOrUrl}`;
    // Follow only api.github.com URLs (Link headers are external input).
    if (!url.startsWith(`${BASE}/`)) throw new GitHubError(0, 'Refusing non-GitHub URL', false);
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'repoinsight-prototype',
    };
    if (this.opts.token) headers.Authorization = `Bearer ${this.opts.token}`;
    const maxAttempts = this.opts.maxAttempts ?? 4;

    for (let attempt = 1; ; attempt++) {
      this.stats.requests++;
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000) });
      } catch {
        if (attempt >= maxAttempts) throw new GitHubError(0, 'GitHub unreachable', true);
        this.stats.retries++;
        await this.sleep(this.backoff(attempt));
        continue;
      }
      if (res.ok) return { data: (await res.json()) as T, next: nextLink(res.headers.get('link')) };

      const remaining = res.headers.get('x-ratelimit-remaining');
      const retryAfter = res.headers.get('retry-after');
      if ((res.status === 403 || res.status === 429) && (remaining === '0' || retryAfter)) {
        const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
        const waitMs = retryAfter ? Number(retryAfter) * 1000 : Math.max(0, reset - Date.now()) + 1000;
        if (waitMs > (this.opts.maxRateLimitWaitMs ?? 60_000) || attempt >= maxAttempts) {
          throw new RateLimitError(new Date(Date.now() + waitMs));
        }
        this.stats.rateLimitWaits++;
        await this.sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        this.stats.retries++;
        await this.sleep(this.backoff(attempt));
        continue;
      }
      throw new GitHubError(res.status, `GitHub request failed (${res.status})`, res.status >= 500);
    }
  }

  /** Iterates all items of a list endpoint (100 per page, bounded number of pages). */
  async *paginate<T>(path: string): AsyncGenerator<T> {
    let url: string | null = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    for (let page = 0; url && page < (this.opts.maxPages ?? 50); page++) {
      const { data, next }: { data: T[]; next: string | null } = await this.request<T[]>(url);
      yield* data;
      url = next;
    }
  }
}

function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const m = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}
