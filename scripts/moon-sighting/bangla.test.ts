import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  fold,
  hijriMonthIn,
  hijriMonthsIn,
  isForeign,
  namesCommittee,
  saysNotSeen,
  saysSeen,
  startCluesIn,
} from './bangla.ts';
import { decide, readDecision, type Evening } from './decision.ts';
import { readNewspapers, rssMoonItems } from './newspapers.ts';
import { expect } from './testing.ts';

// Every spelling bangla-terms.json must recognise. ("য়" typed as one code point U+09DF in some
// entries and as য + ় in others: both must work.)
const SPELLINGS: Record<number, string[]> = {
  1: ['মহররম', 'মুহাররম', 'মহরম'],
  2: ['সফর', 'ছফর'],
  3: ['রবিউল আউয়াল', 'রবিউল আওয়াল', 'রবিউল-আউয়াল', 'রবি উল আউয়াল'],
  4: ['রবিউস সানি', 'রবিউস সানী', 'রবিউল আখির', 'রবিউল আখের', 'রবিউস ছানি'],
  5: [
    'জমাদিউল আউয়াল',
    'জমাদিউল আউয়াল',
    'জুমাদাল আউয়াল',
    'জমাদিউল আওয়াল',
    'জমাদিউল উলা',
    'জুমাদাল উলা',
    'জুমাদা আল-আউয়াল',
  ],
  6: [
    'জমাদিউস সানি',
    'জমাদিউস সানী',
    'জমাদিউল আখির',
    'জমাদিউল আখের',
    'জুমাদাল আখির',
    'জুমাদাল আখিরাহ',
    'জুমাদাল উখরা',
    'জমাদিউস ছানি',
    'জুমাদা আল-আখিরাহ',
  ],
  7: ['রজব'],
  8: ['শাবান', "শা'বান", 'শা’বান'],
  9: ['রমজান', 'রমযান', 'রামাদান', 'রমাদান'],
  10: ['শাওয়াল', 'শাওয়াল', 'শাউয়াল'],
  11: ['জিলকদ', 'জিলক্বদ', 'জিলকাদ', 'জ্বিলকদ', 'যিলকদ', 'জুলকাদা', 'জিল-কদ', 'জিলক্বাদাহ'],
  12: ['জিলহজ', 'জিলহজ্জ', 'জিলহাজ্জ', 'জ্বিলহজ', 'যিলহজ', 'জুলহিজ্জা', 'জিল হজ'],
};

describe('Hijri month spellings (bangla-terms.json)', () => {
  for (const [month, spellings] of Object.entries(SPELLINGS)) {
    for (const spelling of spellings) {
      it(`${spelling} → ${month}`, () => {
        expect(hijriMonthsIn(`পবিত্র ${spelling} মাসের চাঁদ`)).toEqual([Number(month)]);
      });
    }
  }

  it('the month a decision is about: "<মাস> মাসের চাঁদ", "<মাস>র চাঁদ", or the only one named', () => {
    expect(hijriMonthIn('জমাদিউস সানির চাঁদ দেখা যায়নি')).toBe(6);
    expect(hijriMonthIn('জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি, রবিউস সানি ৩০ দিন পূর্ণ')).toBe(5);
    expect(hijriMonthIn('চাঁদ দেখা যায়নি, জমাদিউস সানি মাস শুরু বৃহস্পতিবার')).toBe(6);
  });

  it('a weekday is not a month (রবিবার ≠ রবিউল)', () => {
    expect(hijriMonthsIn('রবিবার সন্ধ্যায় চাঁদ দেখা কমিটির সভা')).toEqual([]);
  });
});

describe('generic phrases', () => {
  it('committee, seen, not seen (with and without চন্দ্রবিন্দু, joined or split)', () => {
    expect(namesCommittee('জাতীয় চাঁদ দেখা কমিটির সভা')).toBe(true);
    expect(namesCommittee('চাঁদ দেখা সংক্রান্ত জাতীয় কমিটি')).toBe(true);
    expect(saysNotSeen('চাঁদ দেখা যায়নি')).toBe(true);
    expect(saysNotSeen('চাদ দেখা যায় নি')).toBe(true);
    expect(saysNotSeen('চাঁদ দেখা যায়নি')).toBe(true);
    expect(saysNotSeen('রবিউস সানি মাস ৩০ দিন পূর্ণ হবে')).toBe(true);
    expect(saysSeen('চাঁদ দেখা গেছে')).toBe(true);
    expect(saysSeen('চাঁদ দেখা গিয়েছে')).toBe(true);
  });

  it('"if seen" (দেখা গেলে) and "not seen" are not "seen"', () => {
    expect(saysSeen('চাঁদ দেখা গেলে বুধবার থেকে মাস শুরু')).toBe(false);
    expect(saysSeen('চাঁদ দেখা যায়নি')).toBe(false);
  });

  it('another country, unless Bangladesh is named', () => {
    expect(isForeign('সৌদি আরবে জমাদিউস সানির চাঁদ দেখা গেছে')).toBe(true);
    expect(isForeign('সৌদিতে দেখা গেলেও বাংলাদেশের আকাশে চাঁদ দেখা যায়নি')).toBe(false);
  });

  it('folding: NFC, digits, চন্দ্রবিন্দু, long vowels, hyphens', () => {
    expect(fold('চাঁদ ১২ নভেম্বর সানী আল-আখিরাহ')).toBe('চাদ 12 নভেম্বর সানি আল আখিরাহ');
  });

  it('start clues only from a clause about the start', () => {
    expect(startCluesIn('আজ মঙ্গলবার চাঁদ দেখা যায়নি, বৃহস্পতিবার থেকে মাস শুরু')).toEqual({
      dates: [],
      weekdays: [4],
      tomorrow: false,
    });
    expect(startCluesIn('আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে মাস গণনা শুরু হবে').dates).toEqual([
      { day: 13, month: 10 },
    ]);
    // "মে" only as a month name, not inside a word.
    expect(startCluesIn('মেঘের কারণে ১২ মেয়াদে শুরু').dates).toEqual([]);
  });
});

// The 10 Nov 2026 evening: 29 Jumada al-Awwal 1448; Jumada al-Akhirah starts 11 Nov (seen) or
// 12 Nov (not seen). The committee: not seen, 12 Nov.
const NOV_10: Evening = {
  eveningKey: '2026-11-10',
  expected: { year: 1448, month: 6 },
  utcOffsetMinutes: 360,
  nowMs: Date.parse('2026-11-10T23:35:00+06:00'),
};
const dhaka = (time: string, day = '2026-11-10') => Date.parse(`${day}T${time}:00+06:00`);

describe('headlines of the 10 Nov 2026 evening (headline only, no article page)', () => {
  const read = (headline: string, published: number | null) =>
    readDecision(headline, 'https://news.example/1', NOV_10, published);
  const starts12 = { kind: 'decision', decision: { seen: false, month: 6, startDate: '2026-11-12' } };

  for (const [headline, time] of [
    ['চাঁদ দেখা যায়নি, জমাদিউস সানি মাস শুরু বৃহস্পতিবার', '19:36'],
    ['জমাদিউস সানির চাঁদ দেখা যায়নি', '20:03'],
    ['চাঁদ দেখা যায়নি, বৃহস্পতিবার থেকে শুরু জমাদিউস সানি মাস', '20:22'],
    ['জমাদিউস সানির চাঁদ দেখা যায়নি, মাস শুরু বৃহস্পতিবার', '20:23'],
    ['জুমাদাল আখিরাহ মাসের চাঁদ দেখা যায়নি', '20:30'],
    ['১৪৪৮ হিজরির জমাদিউল আখির মাস গণনা শুরু ১২ নভেম্বর', '20:40'],
    ['জমাদিউল আউয়াল মাস ৩০ দিন পূর্ণ হবে', '19:50'],
  ] as const) {
    it(`"${headline}" → 12 Nov`, () => {
      expect(read(headline, dhaka(time))).toMatchObject(starts12);
    });
  }

  it('a stated start counts even without a publication time', () => {
    expect(read('চাঁদ দেখা যায়নি, জমাদিউস সানি মাস শুরু বৃহস্পতিবার', null)).toMatchObject({
      kind: 'decision',
      decision: { startDate: '2026-11-12', basis: 'stated' },
    });
  });

  it('meeting announcements are not decisions', () => {
    expect(read('জাতীয় চাঁদ দেখা কমিটির সভা আজ', dhaka('09:25'))).toEqual({ kind: 'none' });
    expect(read('জুমাদাল আখিরাহ নির্ধারণে চাঁদ দেখা কমিটির সভা', dhaka('17:27'))).toEqual({
      kind: 'none',
    });
  });

  it('ignores a preview from before the meeting ("if seen, Wednesday")', () => {
    expect(read('চাঁদ দেখা গেলে বুধবার থেকে জমাদিউস সানি শুরু', dhaka('15:00'))).toEqual({
      kind: 'ignored',
      reason: 'published before the committee met',
    });
  });

  it('ignores another Hijri year (some sites printed 1446 that week)', () => {
    expect(read('১৪৪৬ হিজরির জমাদিউস সানি মাসের চাঁদ দেখা যায়নি', dhaka('20:40'))).toEqual({
      kind: 'ignored',
      reason: 'Hijri year 1446, expected 1448',
    });
  });

  it('ignores another month', () => {
    expect(read('রজব মাসের চাঁদ দেখা যায়নি', dhaka('20:40'))).toMatchObject({ kind: 'ignored' });
  });

  it('ignores a start that is neither possible date (day after the 29th or the 30th)', () => {
    expect(read('জমাদিউস সানি মাস শুরু ১৪ নভেম্বর', dhaka('20:40'))).toEqual({
      kind: 'ignored',
      reason: 'states a start of 2026-11-14, possible are 2026-11-11 and 2026-11-12',
    });
    expect(read('চাঁদ দেখা যায়নি, জমাদিউস সানি মাস শুরু শনিবার', dhaka('20:40'))).toMatchObject({
      kind: 'ignored',
    });
    expect(read('চাঁদ দেখা গেছে, জমাদিউস সানি মাস শুরু বৃহস্পতিবার', dhaka('20:40'))).toEqual({
      kind: 'ignored',
      reason: 'says seen but starts 2026-11-12',
    });
  });

  it('"দেখা গেছে" a day later (the month has begun) is not taken as a sighting', () => {
    const later = 'জমাদিউস সানির চাঁদ দেখা গেছে, পবিত্র রমজানের বাকি কত দিন?';
    expect(
      readDecision(later, 'u', { ...NOV_10, nowMs: dhaka('23:00', '2026-11-11') }, dhaka('18:34', '2026-11-11')),
    ).toEqual({ kind: 'ignored', reason: 'no stated start, and not published on the evening itself' });
  });

  it('ignores what was published after the run time (--now)', () => {
    expect(
      read('জমাদিউস সানির চাঁদ দেখা যায়নি', dhaka('10:00', '2026-11-11')),
    ).toEqual({ kind: 'ignored', reason: 'published after the time of this run' });
  });

  it("ignores another country's sighting", () => {
    expect(read('সৌদি আরবে জমাদিউস সানির চাঁদ দেখা গেছে', dhaka('20:00'))).toEqual({
      kind: 'ignored',
      reason: "another country's sighting",
    });
  });
});

describe('the Google News feed of that evening (publisher-attributed, headlines only)', () => {
  const xml = readFileSync(
    new URL('./fixtures/google-news-2026-11-10.xml', import.meta.url),
    'utf8',
  );

  it('items name their publisher; the " - Publisher" suffix is dropped; চাঁদা is not the moon', () => {
    const items = rssMoonItems(xml, 40);
    expect(items).toHaveLength(11);
    expect(items[3]?.summary).toEqual({
      text: 'চাঁদ দেখা যায়নি, জমাদিউস সানি মাস শুরু বৃহস্পতিবার',
      publishedMs: Date.parse('2026-11-10T13:36:30Z'),
      publisher: 'dhakapost.com',
    });
  });

  it('five publishers agree on 12 Nov; previews, 1446 and later "seen" items are ignored', async () => {
    const lines: string[] = [];
    const fetched: string[] = [];
    const decisions = await readNewspapers({
      sources: [
        {
          name: 'Google News',
          url: 'https://news.google.com/rss/search?q=x',
          kind: 'rss',
          articles: false,
        },
      ],
      fetchText: async (url) => {
        fetched.push(url);
        return xml;
      },
      evening: { ...NOV_10, nowMs: dhaka('21:30') },
      log: (line) => lines.push(line),
    });
    // Only the feed itself: Google News article links are never fetched.
    expect(fetched).toEqual(['https://news.google.com/rss/search?q=x']);
    expect([...new Set(decisions.map((d) => d.publisher))].sort()).toEqual([
      'boishakhionline.com',
      'channel24bd.tv',
      'dhakapost.com',
      'jagonews24.com',
      'observerbd.com',
    ]);
    expect(new Set(decisions.map((d) => d.startDate))).toEqual(new Set(['2026-11-12']));
    expect(lines.join('\n')).toContain('ignored, Hijri year 1446, expected 1448');
    expect(lines.join('\n')).toContain('ignored, published after the time of this run');
    expect(decide({ decisions, expected: NOV_10.expected })).toMatchObject({
      action: 'commit',
      monthKey: '1448-06',
      startDate: '2026-11-12',
    });
  });
});

describe('independent publishers', () => {
  it('one registrable domain is one publisher', async () => {
    const { domainOf } = await import('./decision.ts');
    expect(domainOf('https://bangla.bdnews24.com/x')).toBe('bdnews24.com');
    expect(domainOf('https://bn.observerbd.com/x')).toBe('observerbd.com');
    expect(domainOf('https://www.observerbd.com')).toBe('observerbd.com');
    expect(domainOf('https://islamicfoundation.gov.bd/pages/notices')).toBe(
      'islamicfoundation.gov.bd',
    );
    expect(domainOf('https://www.bbc.co.uk/bengali')).toBe('bbc.co.uk');
  });
});

describe('sources.json', () => {
  it('is valid and the Google News source never fetches article pages', () => {
    const sources = JSON.parse(
      readFileSync(new URL('./sources.json', import.meta.url), 'utf8'),
    ) as { name: string; url: string; kind: string; articles?: boolean }[];
    for (const source of sources) {
      expect(['list', 'rss', 'article']).toContain(source.kind);
      expect(new URL(source.url).protocol).toBe('https:');
    }
    const google = sources.find((s) => s.url.startsWith('https://news.google.com/'));
    expect(google?.articles).toBe(false);
    expect(decodeURIComponent(new URL(google?.url ?? '').searchParams.get('q') ?? '')).toBe(
      'চাঁদ দেখা কমিটি',
    );
  });
});
