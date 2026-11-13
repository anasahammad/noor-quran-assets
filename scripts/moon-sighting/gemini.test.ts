import { describe, it } from 'node:test';

import { issuesFor, type RunResult } from './run.ts';
import { checkGeminiModel, geminiAsker, geminiOff, geminiProblem } from './gemini.ts';
import { expect } from './testing.ts';

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

// A fake Gemini API: the models list (two pages) and single-model lookups.
function api(models: string[], aliases: string[] = [], listStatus = 200) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/models?')) {
      if (listStatus !== 200) return json(listStatus, {});
      const second = url.includes('pageToken=');
      const half = Math.ceil(models.length / 2);
      return json(200, {
        models: (second ? models.slice(half) : models.slice(0, half)).map((name) => ({
          name: `models/${name}`,
          supportedGenerationMethods: ['generateContent'],
        })),
        nextPageToken: second ? undefined : 'p2',
      });
    }
    const name = /\/models\/([^/:?]+)$/.exec(url)?.[1] ?? '';
    return aliases.includes(name) ? json(200, { name: `models/${name}` }) : json(404, {});
  }) as typeof fetch;
  return { impl, calls };
}

describe('Gemini model check (start of every run)', () => {
  it('finds the model in the models list (all pages)', async () => {
    const { impl } = api(['gemini-2.0-flash', 'gemini-3-flash', 'gemini-3-pro']);
    const status = await checkGeminiModel('key', 'gemini-3-pro', impl);
    expect(status).toMatchObject({ state: 'ok', problem: null });
    expect(geminiProblem(status)).toBeNull();
  });

  it('accepts an alias the list does not show, by looking it up', async () => {
    const { impl } = api(['gemini-3-flash'], ['gemini-flash-latest']);
    expect(await checkGeminiModel('key', 'gemini-flash-latest', impl)).toMatchObject({
      state: 'ok',
    });
  });

  it('a retired model (the 10 Nov 2026 HTTP 404) is reported with the models that exist', async () => {
    const { impl } = api(['gemini-3-flash', 'gemini-3-pro', 'embedding-001']);
    const status = await checkGeminiModel('key', 'gemini-2.5-flash', impl);
    expect(status).toMatchObject({
      state: 'missing',
      available: ['gemini-3-pro', 'gemini-3-flash'],
    });
    expect(geminiProblem(status)).toMatch(/gemini-2\.5-flash.*HTTP 404.*GEMINI_MODEL/);
  });

  it('a rejected key or a failed list is an error, not silence', async () => {
    const { impl } = api([], [], 403);
    const status = await checkGeminiModel('bad', 'gemini-flash-latest', impl);
    expect(status).toMatchObject({ state: 'error' });
    expect(status.problem).toMatch(/HTTP 403/);
    const down = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET', message: 'reset' } });
    }) as typeof fetch;
    expect((await checkGeminiModel('k', 'm', down)).problem).toMatch(/ECONNRESET/);
  });
});

describe('Gemini errors while asking', () => {
  it('an HTTP 404 throws and is recorded for the issue', async () => {
    const status = { ...geminiOff('gemini-2.5-flash'), state: 'ok' as const };
    const ask = geminiAsker('k', (async () => json(404, {})) as typeof fetch, {
      model: 'gemini-2.5-flash',
      status,
    });
    await expect(ask('…', '2026-11-10', 'https://a.bd/1')).rejects.toThrow(/HTTP 404/);
    expect(status.errors).toEqual([
      'https://a.bd/1: Gemini gemini-2.5-flash: HTTP 404 (model not found)',
    ]);
    expect(geminiProblem(status)).toMatch(/failed on 1 article/);
  });

  it('uses the configured model in the URL', async () => {
    const urls: string[] = [];
    const ask = geminiAsker(
      'k',
      (async (url: string) => {
        urls.push(url);
        return json(200, { candidates: [] });
      }) as typeof fetch,
      { model: 'gemini-3-flash' },
    );
    await ask('…', '2026-11-10', 'https://a.bd/1');
    expect(urls[0]).toMatch(/\/models\/gemini-3-flash:generateContent$/);
  });
});

describe('issues with a Gemini problem', () => {
  const quiet: RunResult = {
    nowMs: Date.parse('2026-11-20T15:30:00Z'),
    todayKey: '2026-11-20',
    months: [],
    commits: [],
    nextRemote: null,
  };
  const missing = {
    ...geminiOff('gemini-2.5-flash'),
    state: 'missing' as const,
    problem: 'HTTP 404: not in the models list',
    available: ['gemini-3-flash'],
  };

  it('opens its own issue (once) when the run has none', () => {
    const issues = issuesFor(quiet, missing);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe('Moon sighting: Gemini model "gemini-2.5-flash" is not usable');
    expect(issues[0]?.mode).toBe('once');
    expect(issues[0]?.body).toContain('`gemini-3-flash`');
  });

  it('nothing to report without a problem', () => {
    expect(issuesFor(quiet, geminiOff('gemini-flash-latest'))).toEqual([]);
  });
});
