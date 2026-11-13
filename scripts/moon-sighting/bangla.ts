// Bangla text matching for the moon-sighting check. The words themselves (month names in every
// spelling, the generic phrases) live in bangla-terms.json; this file folds text so that the
// many ways of typing the same Bangla compare equal, and compiles the terms.

import { readFileSync } from 'node:fs';

type Terms = {
  hijriMonths: Record<string, string[]>;
  committee: string[];
  seen: string[];
  notSeen: string[];
  foreign: string[];
  bangladesh: string[];
  monthStart: string[];
  hijriYear: string[];
  tomorrow: string[];
  weekdays: Record<string, string[]>;
  gregorianMonths: Record<string, string[]>;
};

export const TERMS = JSON.parse(
  readFileSync(new URL('./bangla-terms.json', import.meta.url), 'utf8'),
) as Terms;

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';
export const toAsciiDigits = (text: string) =>
  text.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)));

// Folding shared by text and patterns: NFC (য়/ড়/ঢ় typed as one code point or as য+় compare
// equal), no zero-width (non-)joiners, no চন্দ্রবিন্দু, long ী/ূ as short ি/ু, ASCII digits.
const foldLetters = (s: string) =>
  toAsciiDigits(
    s
      .normalize('NFC')
      .replace(/[‌‍]/g, '')
      .replace(/ঁ/g, '')
      .replace(/ী/g, 'ি')
      .replace(/ূ/g, 'ু'),
  );

// Text only: also drops apostrophes (শা'বান) and turns hyphens and dashes into spaces.
export const fold = (text: string) =>
  foldLetters(text)
    .replace(/['’‘`]/g, '')
    .replace(/[-‐‑–—]/g, ' ')
    .replace(/\s+/g, ' ');

const compile = (patterns: readonly string[]) =>
  new RegExp(patterns.map((p) => `(?:${foldLetters(p)})`).join('|'));
const compileMap = (map: Record<string, string[]>) =>
  Object.entries(map).map(([key, patterns]) => [Number(key), compile(patterns)] as const);

export const HIJRI_MONTH_PATTERNS = compileMap(TERMS.hijriMonths);
export const COMMITTEE = compile(TERMS.committee);
export const SEEN = compile(TERMS.seen);
export const NOT_SEEN = compile(TERMS.notSeen);
const FOREIGN = compile(TERMS.foreign);
const BANGLADESH = compile(TERMS.bangladesh);
const MONTH_START = compile(TERMS.monthStart);
const HIJRI_YEAR = new RegExp(TERMS.hijriYear.map((p) => `(?:${foldLetters(p)})`).join('|'), 'g');
const TOMORROW = compile(TERMS.tomorrow);
const WEEKDAYS = compileMap(TERMS.weekdays);
const GREGORIAN = compileMap(TERMS.gregorianMonths);
// "১২ নভেম্বর": a day number, then a Gregorian month name not followed by another letter.
const GREGORIAN_DATE = new RegExp(
  `(?:^|\\D)(\\d{1,2})\\s*(${Object.values(TERMS.gregorianMonths)
    .flat()
    .map(foldLetters)
    .join('|')})(?![\\u0980-\\u09ff])`,
  'g',
);

const isFolded = (text: string) => text === fold(text);
const folded = (text: string) => (isFolded(text) ? text : fold(text));

// All Hijri months the text names (1-12), in month order.
export function hijriMonthsIn(text: string): number[] {
  const t = folded(text);
  return HIJRI_MONTH_PATTERNS.filter(([, re]) => re.test(t)).map(([m]) => m);
}

// The one Hijri month a committee decision is about, or null: "<মাস> মাসের চাঁদ" first, then the
// only month named. (For news text with several months, see readDecision in decision.ts.)
export function hijriMonthIn(text: string): number | null {
  const t = folded(text);
  for (const re of [/(\S+(?: \S+)?) ?মাসের ?চাদ/, /(\S+(?: \S+)?)র ?চাদ/]) {
    const phrase = re.exec(t)?.[1];
    if (!phrase) continue;
    const named = hijriMonthsIn(phrase);
    if (named.length === 1) return named[0] ?? null;
  }
  const all = hijriMonthsIn(t);
  return all.length === 1 ? (all[0] ?? null) : null;
}

export const saysSeen = (text: string) => SEEN.test(folded(text));
export const saysNotSeen = (text: string) => NOT_SEEN.test(folded(text));
export const namesCommittee = (text: string) => COMMITTEE.test(folded(text));

// About another country's sighting (and not Bangladesh's).
export const isForeign = (text: string) => {
  const t = folded(text);
  return FOREIGN.test(t) && !BANGLADESH.test(t);
};

export function hijriYearsIn(text: string): number[] {
  const t = folded(text);
  return [...t.matchAll(HIJRI_YEAR)]
    .map((m) => Number(m.slice(1).find((g) => g !== undefined)))
    .filter((y) => y >= 1300 && y <= 1600);
}

// A stated month start, as clues (resolved against the evening by the caller): Gregorian dates
// ("১২ নভেম্বর"), weekdays ("বৃহস্পতিবার") and "আগামীকাল", each only from a clause that talks
// about the start ("শুরু", "গণনা").
export type StartClues = {
  dates: { day: number; month: number }[];
  weekdays: number[];
  tomorrow: boolean;
};

export function startCluesIn(text: string): StartClues {
  const clues: StartClues = { dates: [], weekdays: [], tomorrow: false };
  // Parentheses do not end a clause: "আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে … শুরু".
  for (const clause of folded(text).replace(/[()]/g, ' ').split(/[।,;:!?\n|]/)) {
    if (!MONTH_START.test(clause)) continue;
    for (const match of clause.matchAll(GREGORIAN_DATE)) {
      const month = GREGORIAN.find(([, re]) => re.test(match[2] ?? ''))?.[0];
      if (month) clues.dates.push({ day: Number(match[1]), month });
    }
    for (const [weekday, re] of WEEKDAYS) if (re.test(clause)) clues.weekdays.push(weekday);
    if (TOMORROW.test(clause)) clues.tomorrow = true;
  }
  return clues;
}
