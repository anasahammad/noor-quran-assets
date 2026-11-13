// Test only: loaded with `node --import` in cli.test.ts so the real check.ts runs end to end
// without network. MOCK_FETCH_PAGES is a JSON file: { "<url>": { "status": 200, "body": "…" }
// | { "error": "<code>", "message": "…" } }. Unknown URLs answer 404. Each URL fetched is
// appended to MOCK_FETCH_LOG (one per line), if set.
import { appendFileSync, readFileSync } from 'node:fs';

type Page = { status?: number; body?: string } | { error: string; message?: string };

const pagesPath = process.env.MOCK_FETCH_PAGES;
if (!pagesPath) throw new Error('mock-fetch: MOCK_FETCH_PAGES is not set');
const pages = JSON.parse(readFileSync(pagesPath, 'utf8')) as Record<string, Page>;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (process.env.MOCK_FETCH_LOG) appendFileSync(process.env.MOCK_FETCH_LOG, `${url}\n`);
  const page = pages[url];
  if (page && 'error' in page) {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error(page.message ?? page.error), { code: page.error }),
    });
  }
  return new Response(page?.body ?? '', { status: page ? (page.status ?? 200) : 404 });
}) as typeof fetch;
