// Pure decision logic for the moon-sighting Action (scripts/moon-sighting/check.ts): reading a
// committee decision out of Bangla news text, and deciding what to do with the decisions found.
// No network, no file system: unit-tested (decision.test.ts).

import { dayOfKey, keyOfDay } from '../../app/src/lib/hijri/calendar.ts';

export type Decision = {
  // Crescent of `month` seen this evening (true) or not seen / 30 days completed (false).
  seen: boolean;
  month: number;
  hijriYear: number | null;
  // First day of `month` ("YYYY-MM-DD").
  startDate: string;
  source: string;
  // The text is about this evening's committee meeting (published today, or names today).
  sameEvening: boolean;
};

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
export const toAsciiDigits = (text: string) =>
  text.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)));

// Bangla spellings used by the Islamic Foundation and the press.
const HIJRI_MONTHS: readonly (readonly [number, RegExp])[] = [
  [1, /মু?হা?র(?:্|)রা?ম|মহররম/],
  [2, /সফর/],
  [3, /রবিউল\s*আ(?:উ|ও)য়াল/],
  [4, /রবিউস\s*সান[িী]|রবিউল\s*আখির/],
  [5, /জ(?:ু|)মাদিউল\s*(?:আ(?:উ|ও)য়াল|উলা)|জুমাদাল\s*উলা/],
  [6, /জ(?:ু|)মাদিউস\s*সান[িী]|জ(?:ু|)মাদিউল\s*আখির|জুমাদাল\s*আখির/],
  [7, /রজব/],
  [8, /শা[’'‘]?বান/],
  [9, /রম[জয]ান/],
  [10, /শাওয়াল|শাওয়াল/],
  [11, /জিল\s*ক(?:্|)[দব]|জিলকদ|জিলক্বদ|জিলকাদ/],
  [12, /জিল\s*হজ(?:্জ)?|জিলহজ/],
];

const GREGORIAN_MONTHS: readonly (readonly [number, RegExp])[] = [
  [1, /জানুয়ারি/],
  [2, /ফেব্রুয়ারি/],
  [3, /মার্চ/],
  [4, /এপ্রিল/],
  [5, /মে/],
  [6, /জুন/],
  [7, /জুলাই/],
  [8, /আগস্ট/],
  [9, /সেপ্টেম্বর/],
  [10, /অক্টোবর/],
  [11, /নভেম্বর/],
  [12, /ডিসেম্বর/],
];

export const SEEN = /চাঁদ\s*দেখা\s*(?:গেছে|গিয়েছে)/;
export const NOT_SEEN = /চাঁদ\s*দেখা\s*যায়নি/;
const THIRTY_DAYS = /৩০\s*দিন\s*পূর্ণ|30\s*দিন\s*পূর্ণ/;

export function hijriMonthIn(text: string): number | null {
  // "<মাস> মাসের চাঁদ" first (the month being sighted), else "<মাস> মাস গণনা শুরু".
  for (const pattern of [
    /(\S+(?:\s+\S+)?)\s*মাসের\s*চাঁদ/,
    /(\S+(?:\s+\S+)?)\s*মাস\s*গণনা\s*শুরু/,
  ]) {
    const match = pattern.exec(text);
    if (!match?.[1]) continue;
    const found = HIJRI_MONTHS.find(([, name]) => name.test(match[1] ?? ''));
    if (found) return found[0];
  }
  return null;
}

function hijriYearIn(text: string): number | null {
  const match = /(\d{4})\s*হিজরি/.exec(toAsciiDigits(text));
  return match?.[1] ? Number(match[1]) : null;
}

// "(১৩ অক্টোবর) থেকে … গণনা শুরু" → that date in the evening's year (or the next one).
export function explicitStartIn(text: string, eveningKey: string): string | null {
  const ascii = toAsciiDigits(text);
  const match = /(\d{1,2})\s*(\S+?)\)?\s*(?:থেকে|হতে)[^।]*গণনা\s*শুরু/.exec(ascii);
  if (!match?.[1] || !match[2]) return null;
  const month = GREGORIAN_MONTHS.find(([, name]) => name.test(match[2] ?? ''))?.[0];
  if (!month) return null;
  const [year = 0, eveningMonth = 1] = eveningKey.split('-').map(Number);
  const y = month < eveningMonth ? year + 1 : year;
  return `${y}-${String(month).padStart(2, '0')}-${String(Number(match[1])).padStart(2, '0')}`;
}

// Does the text name the evening's date ("১১ অক্টোবর") together with "আজ" or "সন্ধ্যায়"?
function namesEvening(text: string, eveningKey: string): boolean {
  const [, month = 1, day = 1] = eveningKey.split('-').map(Number);
  const monthName = GREGORIAN_MONTHS.find(([m]) => m === month)?.[1];
  if (!monthName) return false;
  const ascii = toAsciiDigits(text);
  const dated = new RegExp(`(^|\\D)${day}\\s*${monthName.source}`).test(ascii);
  return dated && /আজ|সন্ধ্যা/.test(text);
}

// One source's decision from its text, or null when the text does not settle it (then Gemini
// may be asked). `publishedKey`: the article's publication day (from its metadata), if known.
export function extractDecision(
  text: string,
  source: string,
  eveningKey: string,
  publishedKey: string | null,
): Decision | null {
  const seen = SEEN.test(text);
  const notSeen = NOT_SEEN.test(text) || THIRTY_DAYS.test(text);
  if (seen === notSeen) return null;
  const month = hijriMonthIn(text);
  if (month === null) return null;
  const evening = dayOfKey(eveningKey);
  const startDate = keyOfDay(evening + (seen ? 1 : 2));
  const explicit = explicitStartIn(text, eveningKey);
  // A stated start that disagrees with the sighting is not a clear decision.
  if (explicit !== null && explicit !== startDate) return null;
  return {
    seen,
    month,
    hijriYear: hijriYearIn(text),
    startDate,
    source,
    sameEvening: publishedKey === eveningKey || namesEvening(text, eveningKey),
  };
}

export type Outcome =
  | { action: 'none'; reason: string }
  | { action: 'commit'; monthKey: string; startDate: string; sources: string[] }
  | { action: 'issue'; reason: string; suggested: { monthKey: string; startDate: string } | null };

const domainOf = (source: string) => {
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
};

// What to do with the decisions found for the month expected to start next.
export function decide(input: {
  decisions: readonly Decision[];
  expected: { year: number; month: number };
  calculatedStart: string;
}): Outcome {
  const { expected } = input;
  const monthKey = `${expected.year}-${String(expected.month).padStart(2, '0')}`;
  const tonight = input.decisions.filter((d) => d.sameEvening);
  if (tonight.length === 0) return { action: 'none', reason: 'no decision from this evening yet' };

  // Independent sources: one decision per domain.
  const byDomain = new Map<string, Decision>();
  for (const decision of tonight) byDomain.set(domainOf(decision.source), decision);
  const distinct = [...byDomain.values()];
  const starts = new Set(distinct.map((d) => d.startDate));
  const matchesMonth = (d: Decision) =>
    d.month === expected.month && (d.hijriYear === null || d.hijriYear === expected.year);

  if (starts.size === 1 && distinct.every(matchesMonth)) {
    const startDate = distinct[0]?.startDate ?? '';
    if (startDate === input.calculatedStart) {
      return { action: 'none', reason: 'decision matches the calculation' };
    }
    const confirmedYear = distinct.some((d) => d.hijriYear === expected.year);
    if (distinct.length >= 2 && confirmedYear) {
      return { action: 'commit', monthKey, startDate, sources: distinct.map((d) => d.source) };
    }
    return {
      action: 'issue',
      reason:
        distinct.length < 2
          ? 'only one source differs from the calculation'
          : 'the Hijri year is not stated by any source',
      suggested: { monthKey, startDate },
    };
  }
  return {
    action: 'issue',
    reason: starts.size > 1 ? 'sources disagree' : 'month or Hijri year does not match',
    suggested: null,
  };
}

// What to do with this evening's IFB notice for the expected month: it is enough on its own,
// unless its PDF states a different start date.
export function decideFromNotice(input: {
  notice: Decision;
  pdfStart: string | null;
  expected: { year: number; month: number };
  calculatedStart: string;
}): Outcome {
  const { notice, expected } = input;
  const monthKey = `${expected.year}-${String(expected.month).padStart(2, '0')}`;
  if (input.pdfStart !== null && input.pdfStart !== notice.startDate) {
    return {
      action: 'issue',
      reason: `the IFB notice title gives ${notice.startDate} but its PDF says ${input.pdfStart}`,
      suggested: null,
    };
  }
  if (notice.startDate === input.calculatedStart) {
    return { action: 'none', reason: 'IFB notice matches the calculation' };
  }
  return { action: 'commit', monthKey, startDate: notice.startDate, sources: [notice.source] };
}

// The JSON to commit: only monthStarts[country][monthKey] changes.
export function withMonthStart(
  remote: Record<string, unknown>,
  country: string,
  monthKey: string,
  startDate: string,
): Record<string, unknown> {
  const all =
    typeof remote.monthStarts === 'object' && remote.monthStarts !== null
      ? (remote.monthStarts as Record<string, Record<string, string>>)
      : {};
  return {
    ...remote,
    monthStarts: { ...all, [country]: { ...(all[country] ?? {}), [monthKey]: startDate } },
  };
}
