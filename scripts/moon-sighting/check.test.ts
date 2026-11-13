import { describe, it } from 'node:test';
import { expect, fn } from './testing.ts';
import { issueText, parseNowArg, runCheck } from './check.ts';
import { geminiAsker } from './gemini.ts';
import { decide, readDecision, toAsciiDigits } from './decision.ts';
import { HttpError, moonLinks, publishedMs, type Source } from './newspapers.ts';
import { noticePageHtml, noticeRowHtml, scannedPdf, textPdf } from './testPages.ts';

// The Islamic Foundation's announcement of 11 Oct 2026 (Jumada al-Awwal 1448), as it read.
const NOT_SEEN_OCT_2026 =
  'আজ রবিবার (১১ অক্টোবর) সন্ধ্যায় বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি। ফলে রবিউস সানি মাস ৩০ দিন পূর্ণ হবে। আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে। জাতীয় চাঁদ দেখা কমিটির সভায় এ সিদ্ধান্ত হয়।';
const SEEN_SAME_EVENING =
  'আজ রবিবার (১১ অক্টোবর) সন্ধ্যায় বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা গেছে। আগামীকাল সোমবার (১২ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে।';

const article = (text: string, published = '2026-10-11T19:45:00+06:00') =>
  `<html><head><meta property="article:published_time" content="${published}"></head><body><p>${text}</p></body></html>`;
const list = (href: string) =>
  `<html><body><a href="${href}">জমাদিউল আউয়াল মাসের চাঁদ নিয়ে সিদ্ধান্ত</a><a href="/other">খেলা</a></body></html>`;

const SOURCES: Source[] = [
  { name: 'Islamic Foundation', url: 'https://islamicfoundation.gov.bd/pages/news', kind: 'list' },
  { name: 'BSS', url: 'https://www.bssnews.net/bangla/national', kind: 'list' },
];
const pages = (text: string, second = text) =>
  new Map([
    ['https://islamicfoundation.gov.bd/pages/news', list('/pages/news/moon-1448-05')],
    ['https://islamicfoundation.gov.bd/pages/news/moon-1448-05', article(text)],
    ['https://www.bssnews.net/bangla/national', list('https://www.bssnews.net/bangla/national/1')],
    ['https://www.bssnews.net/bangla/national/1', article(second)],
  ]);
const fetchFrom = (map: Map<string, string>) => async (url: string) => {
  const page = map.get(url);
  if (page === undefined) throw new HttpError(404);
  return page;
};
const NOTICES = 'https://islamicfoundation.gov.bd/pages/notices';
const PDF =
  'https://objectstorage.ap-dcc-gazipur-1.oraclecloud15.com/n/axvjbnqprylg/b/V2Ministry/o/office-islamicfoundation/2026/9/caf5b728-f0bb-4e26-b306-e0fad4e6af50.pdf';
// The row as it appeared on the notices page (page 2 by early November).
const NOT_SEEN_ROW = noticeRowHtml(
  'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি',
  '১১-১০-২০২৬',
  PDF,
);
const OFFICE_ROW = noticeRowHtml('অফিস আদেশঃ ১০১, তারিখঃ ১১-১০-২০২৬', '১১-১০-২০২৬', null);
const withNotices = (map: Map<string, string>, page1: string[], page2: string[] = []) =>
  new Map([
    ...map,
    [`${NOTICES}?page=1`, noticePageHtml(page1)],
    [`${NOTICES}?page=2`, noticePageHtml(page2)],
  ]);
const REMOTE = { schema: 1, hijriOffset: { BD: 0 } };
// 11 Oct 2026, 20:30 in Dhaka: the evening of 29 Rabi al-Thani 1448.
const EVENING = Date.parse('2026-10-11T20:30:00+06:00');
// The last scheduled run of that evening, when newspapers may decide without an IFB notice.
const LATE_EVENING = Date.parse('2026-10-11T23:35:00+06:00');

describe('readDecision (full articles)', () => {
  const OCT = {
    eveningKey: '2026-10-11',
    expected: { year: 1448, month: 5 },
    utcOffsetMinutes: 360,
    nowMs: Date.parse('2026-10-11T23:35:00+06:00'),
  };
  const at = (iso: string) => Date.parse(iso);

  it('reads the October 2026 announcement: not seen, 30 days, start 13 Oct (stated)', () => {
    expect(readDecision(NOT_SEEN_OCT_2026, 'https://if.gov.bd/1', OCT, null)).toEqual({
      kind: 'decision',
      decision: {
        seen: false,
        month: 5,
        hijriYear: 1448,
        startDate: '2026-10-13',
        source: 'https://if.gov.bd/1',
        sameEvening: true,
        publisher: 'if.gov.bd',
        basis: 'stated',
      },
    });
  });

  it('a sighting starts the month tomorrow', () => {
    expect(readDecision(SEEN_SAME_EVENING, 's', OCT, null)).toMatchObject({
      kind: 'decision',
      decision: { seen: true, startDate: '2026-10-12' },
    });
  });

  it('is not a decision when the text says both, neither, or names no month', () => {
    expect(readDecision('চাঁদ দেখা গেছে, চাঁদ দেখা যায়নি', 's', OCT, null)).toMatchObject({
      kind: 'ignored',
    });
    expect(readDecision('কমিটির সভা সন্ধ্যায় বসবে', 's', OCT, null)).toEqual({ kind: 'none' });
    expect(readDecision('আজ চাঁদ দেখা গেছে', 's', OCT, at('2026-10-11T20:00:00+06:00'))).toEqual({
      kind: 'ignored',
      reason: 'names no Hijri month',
    });
  });

  it("an older article is not this evening's decision", () => {
    const old = NOT_SEEN_OCT_2026.replace(/১১ অক্টোবর/, '১১ সেপ্টেম্বর').replace(
      /১৩ অক্টোবর/,
      '১৩ সেপ্টেম্বর',
    );
    expect(readDecision(old, 's', OCT, at('2026-09-11T20:00:00+06:00'))).toMatchObject({
      kind: 'ignored',
    });
  });

  it('converts Bangla digits', () => {
    expect(toAsciiDigits('১৪৪৮ হিজরি')).toBe('1448 হিজরি');
  });
});

describe('decide (news, after the plausibility check)', () => {
  const base = {
    seen: false,
    month: 5,
    hijriYear: 1448,
    startDate: '2026-10-13',
    sameEvening: true,
  };
  const expected = { year: 1448, month: 5 };

  it('two independent publishers that agree: commit (also when it matches the calculation)', () => {
    expect(
      decide({
        decisions: [
          { ...base, source: 'https://a.bd/1' },
          { ...base, source: 'https://b.bd/2' },
        ],
        expected,
      }),
    ).toEqual({
      action: 'commit',
      monthKey: '1448-05',
      startDate: '2026-10-13',
      sources: ['https://a.bd/1', 'https://b.bd/2'],
    });
  });

  it('publishers named by an aggregator count separately; one site twice does not', () => {
    const google = 'https://news.google.com/rss/articles/';
    expect(
      decide({
        decisions: [
          { ...base, source: `${google}1`, publisher: 'dhakapost.com' },
          { ...base, source: `${google}2`, publisher: 'jagonews24.com' },
        ],
        expected,
      }),
    ).toMatchObject({ action: 'commit' });
    expect(
      decide({
        decisions: [
          { ...base, source: 'https://a.bd/1' },
          { ...base, source: 'https://a.bd/2' },
        ],
        expected,
      }),
    ).toMatchObject({
      action: 'issue',
      reason: 'only one independent source',
      suggested: { monthKey: '1448-05' },
    });
  });

  it('sources that disagree: an issue', () => {
    expect(
      decide({
        decisions: [
          { ...base, source: 'https://a.bd/1' },
          { ...base, seen: true, startDate: '2026-10-12', source: 'https://b.bd/1' },
          { ...base, source: 'https://c.bd/1' },
        ],
        expected,
      }),
    ).toMatchObject({ action: 'issue', reason: 'sources disagree (2026-10-12 vs 2026-10-13)' });
  });

  it('nothing from this evening yet: wait for the next run', () => {
    expect(
      decide({ decisions: [{ ...base, sameEvening: false, source: 'https://a.bd/1' }], expected }),
    ).toMatchObject({ action: 'none' });
  });
});

describe('runCheck: IFB notice first (replay, dry)', () => {
  it('replays the 11-10-2026 row (page 2): start 13 Oct, matches our calendar, action none', async () => {
    const lines: string[] = [];
    const result = await runCheck({
      nowMs: EVENING,
      remoteJson: REMOTE,
      sources: [],
      fetchText: fetchFrom(withNotices(new Map(), [OFFICE_ROW], [NOT_SEEN_ROW])),
      fetchBytes: async () => scannedPdf(),
      log: (line) => lines.push(line),
    });
    expect(result.eveningKey).toBe('2026-10-11');
    expect(result.decisions).toMatchObject([
      {
        seen: false,
        month: 5,
        hijriYear: 1448,
        startDate: '2026-10-13',
        source: PDF,
        sameEvening: true,
      },
    ]);
    expect(result.outcome).toEqual({
      action: 'none',
      reason: 'decision matches the calculation',
    });
    expect(result.nextRemote).toBeNull();
    expect(lines).toContain('IFB notices page 1: OK, 1 rows');
    expect(lines).toContain(
      `IFB notice: "প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি" dated 2026-10-11, PDF ${PDF}`,
    );
    expect(lines).toContain('  PDF: scanned image, start date not checked (the title decides)');
  });

  it('a "দেখা গেছে" notice alone commits the next day as the start', async () => {
    const seenRow = noticeRowHtml(
      'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা গেছে',
      '১১-১০-২০২৬',
      PDF,
    );
    const result = await runCheck({
      nowMs: EVENING,
      remoteJson: REMOTE,
      sources: [],
      fetchText: fetchFrom(withNotices(new Map(), [seenRow])),
    });
    expect(result.outcome).toEqual({
      action: 'commit',
      monthKey: '1448-05',
      startDate: '2026-10-12',
      sources: [PDF],
    });
    expect(result.nextRemote).toEqual({
      schema: 1,
      hijriOffset: { BD: 0 },
      monthStarts: { BD: { '1448-05': '2026-10-12' } },
    });
    expect(issueText(result)?.title).toBe(
      'Auto-updated Jumada al-Awwal 1448: 2026-10-12 (IFB notice)',
    );
  });

  it('a notice dated the next day still counts from the sighting evening', async () => {
    // Evening of 29 Jumada al-Awwal 1448 = 10 Nov; the notice is dated 11-11; run on the 11th.
    const row = noticeRowHtml(
      'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউস সানি মাসের চাঁদ দেখা গেছে',
      '১১-১১-২০২৬',
      PDF,
    );
    const result = await runCheck({
      nowMs: Date.parse('2026-11-11T19:00:00+06:00'),
      remoteJson: REMOTE,
      sources: [],
      fetchText: fetchFrom(withNotices(new Map(), [row])),
    });
    expect(result.eveningKey).toBe('2026-11-10');
    expect(result.outcome).toMatchObject({
      action: 'commit',
      monthKey: '1448-06',
      startDate: '2026-11-11',
    });
  });

  it('a text PDF that states another start date: an issue, no commit', async () => {
    const seenRow = noticeRowHtml(
      'জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: জমাদিউল আউয়াল মাসের চাঁদ দেখা গিয়েছে',
      '১১-১০-২০২৬',
      PDF,
    );
    const result = await runCheck({
      nowMs: EVENING,
      remoteJson: REMOTE,
      sources: [],
      fetchText: fetchFrom(withNotices(new Map(), [seenRow])),
      fetchBytes: async () =>
        textPdf('আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে।'),
    });
    expect(result.outcome).toMatchObject({ action: 'issue', suggested: null });
    expect(result.nextRemote).toBeNull();
  });

  it('exits at once on an ordinary evening', async () => {
    const fetchText = fn();
    const result = await runCheck({
      nowMs: Date.parse('2026-11-05T20:00:00+06:00'),
      remoteJson: REMOTE,
      sources: SOURCES,
      fetchText,
    });
    expect(result.outcome.action).toBe('skip');
    expect(fetchText).not.toHaveBeenCalled();
  });
});

describe('runCheck: newspaper fallback', () => {
  it('before 23:30 newspapers are read and logged but do not decide', async () => {
    const lines: string[] = [];
    const result = await runCheck({
      nowMs: EVENING,
      remoteJson: REMOTE,
      sources: SOURCES,
      fetchText: fetchFrom(withNotices(pages(SEEN_SAME_EVENING), [OFFICE_ROW])),
      log: (line) => lines.push(line),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.outcome).toMatchObject({ action: 'none' });
    expect(lines).toContain('IFB: no committee notice on pages 1-2');
    expect(lines).toContain('Source BSS: OK, 1 moon item, 1 with a decision (bssnews.net)');
  });

  it('replays 11 Oct 2026 at 23:35 without an IFB notice: matches, nothing to do', async () => {
    const result = await runCheck({
      nowMs: LATE_EVENING,
      remoteJson: REMOTE,
      sources: SOURCES,
      fetchText: fetchFrom(withNotices(pages(NOT_SEEN_OCT_2026), [])),
    });
    expect(result.decisions).toHaveLength(2);
    expect(result.outcome).toEqual({ action: 'none', reason: 'decision matches the calculation' });
  });

  it('two newspapers that differ from the calculation at 23:35: only monthStarts changes', async () => {
    const result = await runCheck({
      nowMs: LATE_EVENING,
      remoteJson: REMOTE,
      sources: SOURCES,
      fetchText: fetchFrom(withNotices(pages(SEEN_SAME_EVENING), [])),
    });
    expect(result.outcome).toMatchObject({
      action: 'commit',
      monthKey: '1448-05',
      startDate: '2026-10-12',
    });
    expect(result.nextRemote).toEqual({
      schema: 1,
      hijriOffset: { BD: 0 },
      monthStarts: { BD: { '1448-05': '2026-10-12' } },
    });
    expect(issueText(result)?.title).toBe(
      'Auto-updated Jumada al-Awwal 1448: 2026-10-12 (2 sources)',
    );
  });

  it('asks Gemini only when the patterns cannot settle an article', async () => {
    const unclear = 'জাতীয় চাঁদ দেখা কমিটি সন্ধ্যায় বৈঠকে বসে। বিস্তারিত আসছে।';
    const askGemini = fn(async (_text: string, eveningKey: string, url: string) => ({
      seen: false,
      month: 5,
      hijriYear: 1448,
      startDate: '2026-10-13',
      source: url,
      sameEvening: eveningKey === '2026-10-11',
    }));
    const result = await runCheck({
      nowMs: LATE_EVENING,
      remoteJson: REMOTE,
      sources: SOURCES,
      fetchText: fetchFrom(withNotices(pages(unclear, NOT_SEEN_OCT_2026), [])),
      askGemini,
    });
    expect(askGemini).toHaveBeenCalledTimes(1);
    expect(result.decisions).toHaveLength(2);
    expect(result.outcome.action).toBe('none');
  });
});

describe('geminiAsker', () => {
  const reply = (answer: object) =>
    fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }],
      }),
    })) as unknown as typeof fetch;

  it('accepts a consistent, conclusive answer', async () => {
    const ask = geminiAsker(
      'key',
      reply({
        conclusive: true,
        seen: false,
        month: 5,
        hijriYear: 1448,
        startDate: '2026-10-13',
        meetingDate: '2026-10-11',
        source: 'x',
      }),
    );
    expect(await ask('…', '2026-10-11', 'https://a.bd/1')).toMatchObject({
      startDate: '2026-10-13',
      sameEvening: true,
    });
  });

  it('drops an answer whose start does not follow from the sighting', async () => {
    const ask = geminiAsker(
      'key',
      reply({
        conclusive: true,
        seen: true,
        month: 5,
        hijriYear: 1448,
        startDate: '2026-10-13',
        meetingDate: '2026-10-11',
        source: 'x',
      }),
    );
    expect(await ask('…', '2026-10-11', 'https://a.bd/1')).toBeNull();
  });
});

describe('page helpers', () => {
  it('finds moon articles (headline kept) and their publication time', () => {
    expect(moonLinks(list('/a/1'), 'https://x.bd/news')).toEqual([
      {
        url: 'https://x.bd/a/1',
        summary: { text: 'জমাদিউল আউয়াল মাসের চাঁদ নিয়ে সিদ্ধান্ত', publishedMs: null },
      },
    ]);
    expect(publishedMs(article('x', '2026-10-11T19:45:00+06:00'))).toBe(
      Date.parse('2026-10-11T13:45:00Z'),
    );
    expect(publishedMs('<html></html>')).toBeNull();
  });
});

describe('--now (strict)', () => {
  it('accepts an ISO date-time with an offset, ignoring surrounding spaces', () => {
    const expected = Date.parse('2026-11-10T14:00:00Z');
    expect(parseNowArg('2026-11-10T20:00:00+06:00')).toBe(expected);
    expect(parseNowArg('  2026-11-10T20:00:00+06:00')).toBe(expected);
    expect(parseNowArg('2026-11-10T20:00:00+06:00 \n')).toBe(expected);
    expect(parseNowArg('2026-11-10T14:00Z')).toBe(expected);
  });

  [
    'tomorrow',
    '',
    '2026-11-10',
    '2026-11-10 20:00:00+06:00',
    '2026-11-10T20:00:00',
    '10/11/2026 20:00',
    '2026-02-30T20:00:00+06:00',
    '2026-11-10T25:00:00+06:00',
  ].forEach((raw) =>
    it(`fails on ${JSON.stringify(raw)} instead of guessing`, () => {
      expect(() => parseNowArg(raw)).toThrow(/--now/);
    }),
  );
});

describe('runCheck dates', () => {
  it('2026-11-10T20:00:00+06:00 is the evening of 29 Jumada al-Awwal 1448', async () => {
    const lines: string[] = [];
    const result = await runCheck({
      nowMs: parseNowArg('  2026-11-10T20:00:00+06:00'),
      remoteJson: REMOTE,
      sources: [],
      fetchText: fn(),
      log: (line) => lines.push(line),
    });
    expect(result.eveningKey).toBe('2026-11-10');
    expect(lines[0]).toBe(
      'Now 2026-11-10T14:00:00.000Z = 2026-11-10 in Dhaka = 29 Jumada al-Awwal 1448 (daytime date)',
    );
    expect(lines[1]).toBe(
      'Sighting evening 2026-11-10 = 29 Jumada al-Awwal 1448; 1448-06 calculated 2026-11-12',
    );
  });

  it("today's real date gives a real Hijri date (no fallback)", async () => {
    const lines: string[] = [];
    await runCheck({
      nowMs: Date.now(),
      remoteJson: REMOTE,
      sources: [],
      fetchText: async () => '',
      log: (line) => lines.push(line),
    });
    expect(lines[0]).toMatch(
      /^Now .+ = \d{4}-\d{2}-\d{2} in Dhaka = \d{1,2} [A-Za-z -]+ \d{4} \(daytime date\)$/,
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
