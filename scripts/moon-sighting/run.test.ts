import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { bd } from '../../app/src/config/countries/bd.ts';
import { parseNowArg } from './check.ts';
import { geminiOff } from './gemini.ts';
import { HttpError, type Source } from './newspapers.ts';
import { commitTitle, issuesFor, runCheck, type RunDeps } from './run.ts';
import { noticePageHtml, noticeRowHtml, scannedPdf, textPdf } from './testPages.ts';
import { expect, fn } from './testing.ts';

// The app's BD calendar with the official anchors up to 1448-05 (13 Oct 2026) only, so new
// anchors added to the app later do not change these tests. 1448-06 is then calculated: its
// sighting evening is 10 Nov 2026 (29 Jumada al-Awwal 1448).
const CONFIG = {
  ...bd.hijri,
  anchors: Object.fromEntries(
    Object.entries(bd.hijri.anchors).filter(([key]) => key <= '1448-05'),
  ),
};
// config/remote.json on main before the hand fix (1448-05 only).
const REMOTE = {
  schema: 2,
  hijriOffset: { BD: 0 },
  monthStarts: { BD: { '1448-05': '2026-10-13' } },
};
// After the hand fix (what main has now).
const REMOTE_FIXED = {
  schema: 2,
  hijriOffset: { BD: 0 },
  monthStarts: { BD: { '1448-05': '2026-10-13', '1448-06': '2026-11-12' } },
};

const NOTICES = 'https://islamicfoundation.gov.bd/pages/notices';
const PDF = 'https://objectstorage.example/office-islamicfoundation/2026/10/notice.pdf';
const NOT_SEEN_TITLE =
  'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউস সানি মাসের চাঁদ দেখা যায়নি';
const OFFICE_ROW = noticeRowHtml('অফিস আদেশঃ ১০৯, তারিখঃ ১০-১১-২০২৬', '১০-১১-২০২৬', null);
const GOOGLE: Source = {
  name: 'Google News',
  url: 'https://news.google.com/rss/search?q=x',
  kind: 'rss',
  articles: false,
};
const GOOGLE_FEED = readFileSync(
  new URL('./fixtures/google-news-2026-11-10.xml', import.meta.url),
  'utf8',
);

// What Node's fetch throws when the TLS chain or the connection fails.
const fetchFailed = (code: string, message: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });

type Pages = Record<string, string | Error>;
const fetcher = (pages: Pages) => {
  const calls: string[] = [];
  const fetchText = async (url: string) => {
    calls.push(url);
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (page === undefined) throw new HttpError(404);
    return page;
  };
  return { fetchText, calls };
};
const notices = (page1: string[], page2: string[] = []): Pages => ({
  [`${NOTICES}?page=1`]: noticePageHtml(page1),
  [`${NOTICES}?page=2`]: noticePageHtml(page2),
});
const ifbDown = (): Pages => ({
  [`${NOTICES}?page=1`]: fetchFailed('ECONNRESET', 'read ECONNRESET'),
  [`${NOTICES}?page=2`]: fetchFailed('ECONNRESET', 'read ECONNRESET'),
});
const run = (now: string, pages: Pages, extra: Partial<RunDeps> = {}) => {
  const { fetchText, calls } = fetcher(pages);
  const lines: string[] = [];
  return runCheck({
    nowMs: parseNowArg(now),
    hijriConfig: CONFIG,
    remoteJson: REMOTE,
    sources: [],
    fetchText,
    fetchBytes: async () => scannedPdf(),
    log: (line) => lines.push(line),
    ...extra,
  }).then((result) => ({ result, calls, lines }));
};

describe('the 10 Nov 2026 evening (1448-06)', () => {
  it('IFB notice "জমাদিউস সানি মাসের চাঁদ দেখা যায়নি": 1448-06 = 2026-11-12, existing entries kept', async () => {
    const { result } = await run(
      '2026-11-10T21:30:00+06:00',
      notices([OFFICE_ROW, noticeRowHtml(NOT_SEEN_TITLE, '১০-১১-২০২৬', PDF)]),
    );
    expect(result.commits).toEqual([
      { monthKey: '1448-06', startDate: '2026-11-12', sources: [PDF] },
    ]);
    // Written although it equals the calculation: the month is then recorded, never re-checked.
    expect(result.months[0]?.calculated).toBe('2026-11-12');
    expect(result.nextRemote).toEqual(REMOTE_FIXED);
    expect(commitTitle(result)).toBe(
      'moon-sighting: 1448-06 (Jumada al-Akhirah) starts 2026-11-12 (IFB notice)',
    );
    expect(issuesFor(result).map((i) => [i.title, i.mode])).toEqual([
      ['Moon sighting: Jumada al-Akhirah 1448 (1448-06) starts 2026-11-12 (recorded)', 'once'],
    ]);
  });

  it('a schema 1 remote.json is written back as schema 2', async () => {
    const { result } = await run(
      '2026-11-10T21:30:00+06:00',
      notices([noticeRowHtml(NOT_SEEN_TITLE, '১০-১১-২০২৬', PDF)]),
      { remoteJson: { schema: 1, hijriOffset: { BD: 0 } } },
    );
    expect(result.nextRemote).toMatchObject({
      schema: 2,
      monthStarts: { BD: { '1448-06': '2026-11-12' } },
    });
    expect(Object.keys(result.nextRemote ?? {})).toEqual(['schema', 'hijriOffset', 'monthStarts']);
  });

  it('IFB unreachable (its error cause is reported): the news path finds 2026-11-12', async () => {
    const { result } = await run(
      '2026-11-10T21:30:00+06:00',
      { ...ifbDown(), [GOOGLE.url]: GOOGLE_FEED },
      { sources: [GOOGLE] },
    );
    expect(result.commits).toMatchObject([{ monthKey: '1448-06', startDate: '2026-11-12' }]);
    expect(result.commits[0]?.sources).toHaveLength(5);
    expect(result.months[0]?.ifbStatus[0]).toMatch(
      /^IFB notices page 1: error \(fetch failed; cause: ECONNRESET: read ECONNRESET\) \[.*blocks the runner/,
    );
    expect(commitTitle(result)).toContain('(5 news sources)');
  });

  it('every source fails: no commit and, once the evening is over, an issue with each status', async () => {
    const sources: Source[] = [
      GOOGLE,
      { name: 'Jago News 24 (RSS)', url: 'https://www.jagonews24.com/rss/rss.xml', kind: 'rss' },
    ];
    const pages = {
      [`${NOTICES}?page=1`]: fetchFailed(
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'unable to verify the first certificate',
      ),
      [`${NOTICES}?page=2`]: fetchFailed(
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'unable to verify the first certificate',
      ),
      [GOOGLE.url]: new HttpError(503),
      'https://www.jagonews24.com/rss/rss.xml': new HttpError(403),
    };
    // 21:30: not over yet, no issue (the 23:30 run tries again).
    const early = await run('2026-11-10T21:30:00+06:00', pages, { sources });
    expect(early.result.commits).toEqual([]);
    expect(early.result.months[0]?.eveningOver).toBe(false);
    expect(issuesFor(early.result)).toEqual([]);
    // 23:35: the evening is over.
    const late = await run('2026-11-10T23:35:00+06:00', pages, { sources });
    const issues = issuesFor(late.result, {
      ...geminiOff('gemini-2.5-flash'),
      state: 'missing',
      problem: 'HTTP 404: not in the models list',
      available: ['gemini-3-flash'],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.title).toBe('Moon sighting: Jumada al-Akhirah 1448 (1448-06) not decided');
    expect(issues[0]?.mode).toBe('update');
    const body = issues[0]?.body ?? '';
    expect(body).toContain('| IFB notices page 1 | error (fetch failed; cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    expect(body).toContain('| Google News | blocked (HTTP 503) |');
    expect(body).toContain('| Jago News 24 (RSS) | blocked (HTTP 403) |');
    expect(body).toContain('**2026-11-11** if the crescent was seen, **2026-11-12** if not');
    expect(body).toContain('## ⚠️ Gemini');
    expect(body).toContain('`gemini-3-flash`');
  });

  it('news alone from one publisher is not enough; disagreeing sources are an issue', async () => {
    const one = `<rss><channel><item><title>জমাদিউস সানির চাঁদ দেখা যায়নি</title><link>https://www.jagonews24.com/r/1</link><pubDate>Tue, 10 Nov 2026 14:00:00 GMT</pubDate></item></channel></rss>`;
    const jago: Source = { name: 'Jago', url: 'https://www.jagonews24.com/rss/rss.xml', kind: 'rss' };
    const single = await run(
      '2026-11-10T23:35:00+06:00',
      { ...ifbDown(), [jago.url]: one },
      { sources: [jago] },
    );
    expect(single.result.commits).toEqual([]);
    expect(single.result.months[0]?.outcome).toMatchObject({
      action: 'issue',
      reason: 'only one independent source',
      suggested: { startDate: '2026-11-12' },
    });
    expect(issuesFor(single.result)[0]?.body).toContain('The sources point to **2026-11-12**');

    const seen = `<rss><channel><item><title>জমাদিউস সানির চাঁদ দেখা গেছে</title><link>https://www.dhakapost.com/r/2</link><pubDate>Tue, 10 Nov 2026 14:30:00 GMT</pubDate></item></channel></rss>`;
    const post: Source = { name: 'Post', url: 'https://www.dhakapost.com/rss/rss.xml', kind: 'rss' };
    const both = await run(
      '2026-11-10T23:35:00+06:00',
      { ...ifbDown(), [jago.url]: one, [post.url]: seen },
      { sources: [jago, post] },
    );
    expect(both.result.commits).toEqual([]);
    expect(both.result.months[0]?.outcome).toMatchObject({
      action: 'issue',
      reason: 'sources disagree (2026-11-11 vs 2026-11-12)',
    });
  });

  it('a text PDF that states another start than the notice title: an issue, no commit', async () => {
    const seenRow = noticeRowHtml(
      'জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: জমাদিউস সানি মাসের চাঁদ দেখা গিয়েছে',
      '১০-১১-২০২৬',
      PDF,
    );
    const { result } = await run('2026-11-10T21:30:00+06:00', notices([seenRow]), {
      fetchBytes: async () =>
        textPdf('আগামী বৃহস্পতিবার (১২ নভেম্বর) থেকে জমাদিউস সানি মাস গণনা শুরু হবে।'),
    });
    expect(result.commits).toEqual([]);
    expect(result.months[0]?.outcome).toMatchObject({ action: 'issue', suggested: null });
  });

  it('a notice dated the next day still counts from the sighting evening ("দেখা গেছে" → 11 Nov)', async () => {
    const row = noticeRowHtml(
      'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউস সানি মাসের চাঁদ দেখা গেছে',
      '১১-১১-২০২৬',
      PDF,
    );
    const { result } = await run('2026-11-11T09:00:00+06:00', notices([row]));
    expect(result.commits).toMatchObject([{ monthKey: '1448-06', startDate: '2026-11-11' }]);
  });

  it('a notice dated after the run time (--now) is not seen yet', async () => {
    const row = noticeRowHtml(NOT_SEEN_TITLE, '১১-১১-২০২৬', PDF);
    const { result } = await run('2026-11-10T21:30:00+06:00', notices([row]));
    expect(result.commits).toEqual([]);
  });
});

describe('catching up (the run on 13 Nov 2026 only said "not a sighting evening")', () => {
  it('13 Nov: 1448-06 is missing, so it is resolved (notice on page 2)', async () => {
    const { result, lines } = await run(
      '2026-11-13T09:00:00+06:00',
      notices([OFFICE_ROW], [noticeRowHtml(NOT_SEEN_TITLE, '১০-১১-২০২৬', PDF)]),
    );
    expect(result.commits).toMatchObject([{ monthKey: '1448-06', startDate: '2026-11-12' }]);
    expect(result.months[0]?.daysSinceEvening).toBe(3);
    expect(lines.some((l) => l.includes('1448-06 (Jumada al-Akhirah 1448): sighting evening 2026-11-10 (3 day(s) ago)'))).toBe(true);
  });

  it('13 Nov: nothing found yet → an issue (updated by every later run)', async () => {
    const { result } = await run('2026-11-13T09:00:00+06:00', ifbDown());
    expect(issuesFor(result).map((i) => [i.title, i.mode])).toEqual([
      ['Moon sighting: Jumada al-Akhirah 1448 (1448-06) not decided', 'update'],
    ]);
  });

  it('17 Nov: still missing after the catch-up days → one "still missing" issue, no fetching', async () => {
    const { result, calls } = await run('2026-11-17T09:00:00+06:00', {});
    expect(calls).toEqual([]);
    expect(result.months[0]?.mode).toBe('missing');
    expect(issuesFor(result).map((i) => [i.title, i.mode])).toEqual([
      ['Moon sighting: Jumada al-Akhirah 1448 (1448-06) still missing after 3 days', 'once'],
    ]);
  });

  it('an ordinary day with every month recorded: no fetch, no issue', async () => {
    const fetchText = fn(async () => '');
    const result = await runCheck({
      nowMs: parseNowArg('2026-11-20T21:30:00+06:00'),
      hijriConfig: CONFIG,
      remoteJson: REMOTE_FIXED,
      sources: [GOOGLE],
      fetchText,
    });
    expect(fetchText).not.toHaveBeenCalled();
    expect(result.months).toEqual([]);
    expect(issuesFor(result)).toEqual([]);
  });

  it('the next sighting evening follows from a start written in the same run', async () => {
    // 1448-06 recorded on 12 Nov → 29 Jumada al-Akhirah = 10 Dec; on 9 Dec nothing is due.
    const { result, calls } = await run('2026-12-09T21:30:00+06:00', {}, { remoteJson: REMOTE_FIXED });
    expect(calls).toEqual([]);
    expect(result.months).toEqual([]);
  });
});

describe('dry run on a month that is already recorded (the test from the PR)', () => {
  it('now = 2026-11-10T15:30:00Z: checks the sources against monthStarts, writes nothing', async () => {
    const { result, lines } = await run(
      '2026-11-10T15:30:00Z',
      { ...ifbDown(), [GOOGLE.url]: GOOGLE_FEED },
      { remoteJson: REMOTE_FIXED, sources: [GOOGLE], dryRun: true },
    );
    expect(result.months).toHaveLength(1);
    expect(result.months[0]).toMatchObject({ mode: 'verify', recorded: '2026-11-12' });
    expect(result.months[0]?.outcome).toMatchObject({ action: 'commit', startDate: '2026-11-12' });
    expect(result.commits).toEqual([]);
    expect(result.nextRemote).toBeNull();
    expect(issuesFor(result)).toEqual([]);
    expect(lines).toContain(
      '1448-06 (Jumada al-Akhirah 1448): the sources confirm 2026-11-12 (5 independent news sources), as recorded.',
    );
  });

  it('a real (not dry) run does not re-check a recorded month', async () => {
    const { result, calls } = await run(
      '2026-11-10T15:30:00Z',
      {},
      { remoteJson: REMOTE_FIXED, sources: [GOOGLE] },
    );
    expect(calls).toEqual([]);
    expect(result.months).toEqual([]);
  });
});

describe('run dates', () => {
  it('2026-11-10T20:00:00+06:00 is 29 Jumada al-Awwal 1448 in Dhaka', async () => {
    const { lines } = await run('  2026-11-10T20:00:00+06:00', ifbDown());
    expect(lines[0]).toBe(
      'Now 2026-11-10T14:00:00.000Z = 2026-11-10 20:00 in Dhaka = 29 Jumada al-Awwal 1448 (daytime date)',
    );
  });

  it("today's real date gives a real Hijri date (no fallback), with the app's own anchors", async () => {
    const lines: string[] = [];
    await runCheck({
      nowMs: Date.now(),
      remoteJson: REMOTE_FIXED,
      sources: [],
      fetchText: async () => '',
      log: (line) => lines.push(line),
    });
    expect(lines[0]).toMatch(
      /^Now .+ = \d{4}-\d{2}-\d{2} \d{2}:\d{2} in Dhaka = \d{1,2} [A-Za-z -]+ \d{4} \(daytime date\)$/,
    );
    expect(lines[0]).not.toMatch(/null|NaN|undefined/);
  });

  it('an invalid time stops the run instead of falling back to an anchor', async () => {
    await expect(
      runCheck({ nowMs: Number.NaN, remoteJson: REMOTE, sources: [], fetchText: fn() }),
    ).rejects.toThrow(/invalid current time/);
    await expect(
      runCheck({
        nowMs: Date.parse('2020-01-01T20:00:00+06:00'),
        remoteJson: REMOTE,
        sources: [],
        fetchText: fn(),
      }),
    ).rejects.toThrow(/before the first official month/);
  });
});
