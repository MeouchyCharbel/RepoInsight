import { describe, expect, it } from 'vitest';
import { GitHubClient, GitHubError, RateLimitError } from '../src/ingest/github.js';

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | 'network-error';

function mockFetch(replies: Reply[]) {
  const calls: { url: string; auth: string | null }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({ url: String(url), auth: headers.get('authorization') });
    const r = replies.shift();
    if (!r) throw new Error('unexpected request');
    if (r === 'network-error') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
  return { fn, calls };
}

const noSleep = { sleep: async () => {} };

describe('GitHub client', () => {
  it('follows Link pagination and sends the token only to api.github.com', async () => {
    const { fn, calls } = mockFetch([
      { body: [1, 2], headers: { link: '<https://api.github.com/repos/o/r/issues?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"' } },
      { body: [3] },
    ]);
    const gh = new GitHubClient({ fetchFn: fn, token: 'test-token', ...noSleep });
    const items: number[] = [];
    for await (const i of gh.paginate<number>('/repos/o/r/issues')) items.push(i);
    expect(items).toEqual([1, 2, 3]);
    expect(calls[0]!.url).toContain('per_page=100');
    expect(calls.every((c) => c.auth === 'Bearer test-token')).toBe(true);
  });

  it('refuses to follow a next link to another host', async () => {
    const { fn } = mockFetch([{ body: [1], headers: { link: '<https://evil.example/steal>; rel="next"' } }]);
    const gh = new GitHubClient({ fetchFn: fn, token: 't', ...noSleep });
    const it = gh.paginate<number>('/repos/o/r/issues');
    await it.next();
    await expect(it.next()).rejects.toThrow(/non-GitHub/);
  });

  it('retries transient 5xx and network errors with bounded attempts', async () => {
    const { fn } = mockFetch(['network-error', { status: 502 }, { body: { ok: true } }]);
    const gh = new GitHubClient({ fetchFn: fn, ...noSleep });
    expect((await gh.request('/x')).data).toEqual({ ok: true });
    expect(gh.stats.retries).toBe(2);

    const failing = mockFetch([{ status: 503 }, { status: 503 }, { status: 503 }]);
    const gh2 = new GitHubClient({ fetchFn: failing.fn, maxAttempts: 3, ...noSleep });
    await expect(gh2.request('/x')).rejects.toMatchObject({ status: 503, retryable: true });
  });

  it('does not retry client errors such as 404', async () => {
    const { fn, calls } = mockFetch([{ status: 404 }]);
    const gh = new GitHubClient({ fetchFn: fn, ...noSleep });
    await expect(gh.request('/missing')).rejects.toBeInstanceOf(GitHubError);
    expect(calls).toHaveLength(1);
  });

  it('waits for a short rate-limit reset, then continues', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 2);
    const waits: number[] = [];
    const { fn } = mockFetch([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } }, { body: [1] }]);
    const gh = new GitHubClient({ fetchFn: fn, sleep: async (ms) => void waits.push(ms) });
    expect((await gh.request('/x')).data).toEqual([1]);
    expect(gh.stats.rateLimitWaits).toBe(1);
    expect(waits[0]).toBeGreaterThan(0);
  });

  it('honours Retry-After for secondary limits and pauses when the reset is too far away', async () => {
    const { fn } = mockFetch([{ status: 429, headers: { 'retry-after': '3600' } }]);
    const gh = new GitHubClient({ fetchFn: fn, maxRateLimitWaitMs: 60_000, ...noSleep });
    await expect(gh.request('/x')).rejects.toBeInstanceOf(RateLimitError);
  });
});
