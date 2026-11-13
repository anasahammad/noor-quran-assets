// Pure decision logic for the moon-sighting Action: reading a committee decision out of Bangla
// news text, checking it is plausible for this evening, and deciding what to do with the
// decisions found. No network, no file system.

import { dayOfKey, keyOfDay } from '../../app/src/lib/hijri/calendar.ts';
import {
  hijriMonthsIn,
  hijriYearsIn,
  isForeign,
  saysNotSeen,
  saysSeen,
  startCluesIn,
  toAsciiDigits,
} from './bangla.ts';

export { toAsciiDigits };

export type Decision = {
  // Crescent of `month` seen this evening (true) or not seen / 30 days completed (false).
  seen: boolean;
  month: number;
  hijriYear: number | null;
  // First day of `month` ("YYYY-MM-DD").
  startDate: string;
  // The article (or notice) URL.
  source: string;
  // The text is about this evening's committee meeting.
  sameEvening: boolean;
  // The publisher, for counting independent sources (Google News items name it; otherwise the
  // URL's host).
  publisher?: string;
  // How the start was found: a stated date/weekday, or inferred from seen / not seen.
  basis?: 'stated' | 'inferred' | 'notice' | 'gemini';
};

// The sighting evening being decided: the 29th of the month before `expected`.
export type Evening = {
  eveningKey: string;
  expected: { year: number; month: number };
  utcOffsetMinutes: number;
  // The run's time (or --now): anything published later is ignored, so a simulated run only
  // sees what existed then.
  nowMs: number;
};

// The committee decides after maghrib: an article from earlier that day is a preview.
const EARLIEST_DECISION_MINUTES = 17 * 60;
// The two possible starts: the day after the 29th (seen) or after the 30th (not seen).
export const possibleStarts = (eveningKey: string) => {
  const evening = dayOfKey(eveningKey);
  return [keyOfDay(evening + 1), keyOfDay(evening + 2)] as const;
};

export type Reading =
  | { kind: 'decision'; decision: Decision }
  // About the moon but not usable, and why (logged per article).
  | { kind: 'ignored'; reason: string }
  // Nothing about a decision (a preview, a meeting announcement…).
  | { kind: 'none' };

const localDayAndMinutes = (ms: number, utcOffsetMinutes: number) => {
  const local = ms + utcOffsetMinutes * 60_000;
  const day = Math.floor(local / 86_400_000);
  return { day, minutes: (local - day * 86_400_000) / 60_000 };
};

// Resolves stated start clues against the evening: dates in the evening's year (or the next
// one), weekdays to whichever of the two possible starts falls on that weekday.
function statedStarts(text: string, eveningKey: string): string[] {
  const clues = startCluesIn(text);
  const evening = dayOfKey(eveningKey);
  const [year = 0, eveningMonth = 1] = eveningKey.split('-').map(Number);
  const starts = new Set<string>();
  for (const { day, month } of clues.dates) {
    const y = month < eveningMonth ? year + 1 : year;
    starts.add(`${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  for (const weekday of clues.weekdays) {
    const match = [evening + 1, evening + 2].find((d) => new Date(d * 86_400_000).getUTCDay() === weekday);
    // A weekday that is neither possible start: keep it visible as an implausible start.
    starts.add(match === undefined ? `weekday ${weekday}` : keyOfDay(match));
  }
  if (clues.tomorrow) starts.add(keyOfDay(evening + 1));
  return [...starts];
}

// The one start date a text states ("১৩ অক্টোবর থেকে … গণনা শুরু"), or null (none, or several).
export function statedStartIn(text: string, eveningKey: string): string | null {
  const starts = statedStarts(text, eveningKey).filter((s) => !s.startsWith('weekday'));
  return starts.length === 1 ? (starts[0] ?? null) : null;
}

// One article's decision for this evening, or why it is not one. `publishedMs`: when the
// article (or feed item) was published, if known.
export function readDecision(
  text: string,
  source: string,
  evening: Evening,
  publishedMs: number | null,
  publisher?: string,
): Reading {
  const { eveningKey, expected } = evening;
  const seen = saysSeen(text);
  const notSeen = saysNotSeen(text);
  const stated = statedStarts(text, eveningKey);
  if (!seen && !notSeen && stated.length === 0) return { kind: 'none' };
  const months = hijriMonthsIn(text);
  if (months.length === 0) {
    return seen || notSeen ? { kind: 'ignored', reason: 'names no Hijri month' } : { kind: 'none' };
  }
  if (isForeign(text)) return { kind: 'ignored', reason: "another country's sighting" };
  const previous = expected.month === 1 ? 12 : expected.month - 1;
  // The month the decision is about: the expected one when named; the ending month with
  // "30 days complete" also means the expected one is next.
  let month: number;
  if (months.includes(expected.month)) month = expected.month;
  else if (months.length === 1 && months[0] === previous && notSeen) month = expected.month;
  else {
    return {
      kind: 'ignored',
      reason: `about month ${months.join('/')}, expected ${expected.month}`,
    };
  }
  const years = [...new Set(hijriYearsIn(text))];
  if (years.length > 0 && !years.includes(expected.year)) {
    return {
      kind: 'ignored',
      reason: `Hijri year ${years.join('/')}, expected ${expected.year}`,
    };
  }
  if (publishedMs !== null && publishedMs > evening.nowMs) {
    return { kind: 'ignored', reason: 'published after the time of this run' };
  }
  const evDay = dayOfKey(eveningKey);
  const published =
    publishedMs === null ? null : localDayAndMinutes(publishedMs, evening.utcOffsetMinutes);
  if (
    published &&
    (published.day < evDay ||
      (published.day === evDay && published.minutes < EARLIEST_DECISION_MINUTES))
  ) {
    return { kind: 'ignored', reason: 'published before the committee met' };
  }

  const [ifSeen, ifNotSeen] = possibleStarts(eveningKey);
  const plausible = stated.filter((s) => s === ifSeen || s === ifNotSeen);
  let startDate: string;
  let basis: 'stated' | 'inferred';
  if (stated.length > 0) {
    if (plausible.length !== 1 || plausible.length !== stated.length) {
      return {
        kind: 'ignored',
        reason: `states a start of ${stated.join(' / ')}, possible are ${ifSeen} and ${ifNotSeen}`,
      };
    }
    startDate = plausible[0] ?? '';
    basis = 'stated';
    if ((seen && startDate !== ifSeen) || (notSeen && startDate !== ifNotSeen)) {
      return { kind: 'ignored', reason: `says ${seen ? 'seen' : 'not seen'} but starts ${startDate}` };
    }
  } else {
    if (seen === notSeen) return { kind: 'ignored', reason: 'says both seen and not seen' };
    // "দেখা গেছে" a day or two later is loose talk ("the month has begun"): an inferred start
    // counts only from an article of the evening itself.
    if (!published || published.day !== evDay) {
      return {
        kind: 'ignored',
        reason: published
          ? 'no stated start, and not published on the evening itself'
          : 'no stated start, and no publication time',
      };
    }
    startDate = seen ? ifSeen : ifNotSeen;
    basis = 'inferred';
  }
  return {
    kind: 'decision',
    decision: {
      seen: startDate === ifSeen,
      month,
      hijriYear: years[0] ?? null,
      startDate,
      source,
      sameEvening: true,
      publisher: publisher ?? domainOf(source),
      basis,
    },
  };
}

// Is a decision (from any source, e.g. Gemini) possible for this evening? null when it is,
// else why not.
export function implausibility(decision: Decision, evening: Evening): string | null {
  const [ifSeen, ifNotSeen] = possibleStarts(evening.eveningKey);
  if (decision.month !== evening.expected.month) {
    return `about month ${decision.month}, expected ${evening.expected.month}`;
  }
  if (decision.hijriYear !== null && decision.hijriYear !== evening.expected.year) {
    return `Hijri year ${decision.hijriYear}, expected ${evening.expected.year}`;
  }
  if (decision.startDate !== ifSeen && decision.startDate !== ifNotSeen) {
    return `start ${decision.startDate}, possible are ${ifSeen} and ${ifNotSeen}`;
  }
  if ((decision.startDate === ifSeen) !== decision.seen) {
    return `says ${decision.seen ? 'seen' : 'not seen'} but starts ${decision.startDate}`;
  }
  return null;
}

export type Outcome =
  | { action: 'none'; reason: string }
  | { action: 'commit'; monthKey: string; startDate: string; sources: string[] }
  | { action: 'issue'; reason: string; suggested: { monthKey: string; startDate: string } | null };

// Second-level suffixes under which the registrable domain has three labels.
const SECOND_LEVEL = /^(?:com|gov|org|net|edu|ac|co|info|mil)\.[a-z]{2}$/;

// The publisher behind a URL or host: its registrable domain, so bangla.bdnews24.com and
// bdnews24.com, or bn.observerbd.com and www.observerbd.com, are one source, not two.
export const domainOf = (source: string) => {
  let host: string;
  try {
    host = new URL(source).hostname;
  } catch {
    host = source;
  }
  const labels = host.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.test(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
};

// The news decision for the expected month: confident only when at least two independent
// publishers agree (each publisher's own articles must agree too) and none disagrees. Every
// decision passed in has already passed the plausibility check.
export function decide(input: {
  decisions: readonly Decision[];
  expected: { year: number; month: number };
}): Outcome {
  const { expected } = input;
  const monthKey = `${expected.year}-${String(expected.month).padStart(2, '0')}`;
  const tonight = input.decisions.filter((d) => d.sameEvening && d.month === expected.month);
  if (tonight.length === 0) return { action: 'none', reason: 'no decision from this evening yet' };

  const byPublisher = new Map<string, Decision[]>();
  for (const decision of tonight) {
    const key = decision.publisher ?? domainOf(decision.source);
    byPublisher.set(key, [...(byPublisher.get(key) ?? []), decision]);
  }
  const starts = new Set(tonight.map((d) => d.startDate));
  if (starts.size > 1) {
    return {
      action: 'issue',
      reason: `sources disagree (${[...starts].sort().join(' vs ')})`,
      suggested: null,
    };
  }
  const startDate = tonight[0]?.startDate ?? '';
  if (byPublisher.size >= 2) {
    return {
      action: 'commit',
      monthKey,
      startDate,
      sources: [...byPublisher.values()].map((ds) => ds[0]?.source ?? ''),
    };
  }
  return {
    action: 'issue',
    reason: 'only one independent source',
    suggested: { monthKey, startDate },
  };
}

// What to do with this evening's IFB notice for the expected month: it is enough on its own,
// unless its PDF states a different start date.
export function decideFromNotice(input: {
  notice: Decision;
  pdfStart: string | null;
  expected: { year: number; month: number };
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
  return { action: 'commit', monthKey, startDate: notice.startDate, sources: [notice.source] };
}
