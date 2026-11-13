import { describe, it } from 'node:test';
import { expect, fn } from './testing.ts';
import { parseNowArg } from './check.ts';
import { geminiAsker } from './gemini.ts';
import { decide, readDecision, toAsciiDigits } from './decision.ts';
import { moonLinks, publishedMs } from './newspapers.ts';

// The Islamic Foundation's announcement of 11 Oct 2026 (Jumada al-Awwal 1448), as it read.
const NOT_SEEN_OCT_2026 =
  'আজ রবিবার (১১ অক্টোবর) সন্ধ্যায় বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি। ফলে রবিউস সানি মাস ৩০ দিন পূর্ণ হবে। আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে। জাতীয় চাঁদ দেখা কমিটির সভায় এ সিদ্ধান্ত হয়।';
const SEEN_SAME_EVENING =
  'আজ রবিবার (১১ অক্টোবর) সন্ধ্যায় বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা গেছে। আগামীকাল সোমবার (১২ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে।';

const article = (text: string, published = '2026-10-11T19:45:00+06:00') =>
  `<html><head><meta property="article:published_time" content="${published}"></head><body><p>${text}</p></body></html>`;
const list = (href: string) =>
  `<html><body><a href="${href}">জমাদিউল আউয়াল মাসের চাঁদ নিয়ে সিদ্ধান্ত</a><a href="/other">খেলা</a></body></html>`;

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

