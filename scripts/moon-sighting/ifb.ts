// The Islamic Foundation's notices page, the primary source: the National Moon Sighting
// Committee's decision is published there as a press release row, newest first, e.g. (11-10-2026)
//   "প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউল
//    আউয়াল মাসের চাঁদ দেখা যায়নি"
// with the signed notice as a PDF (so far scanned images, so usually the title is all we read).

import { dayOfKey, keyOfDay } from '../../app/src/lib/hijri/calendar.ts';
import { hijriMonthIn, namesCommittee, saysNotSeen, saysSeen, toAsciiDigits } from './bangla.ts';
import { statedStartIn, type Decision } from './decision.ts';
import { failureOf, type Fetcher } from './newspapers.ts';
import { pdfText } from './pdf.ts';

export const IFB_NOTICES_URL = 'https://islamicfoundation.gov.bd/pages/notices';
// The notice can be pushed down by a day's office orders; two pages (20 rows) cover that.
const PAGES = 2;

export type NoticeRow = {
  title: string;
  // Publication day ("YYYY-MM-DD"), from the row's Bangla DD-MM-YYYY.
  dateKey: string;
  pdfUrl: string | null;
  detailUrl: string | null;
};

const cell = (row: string, column: string) =>
  new RegExp(`<td[^>]*data-column="${column}"[^>]*>([\\s\\S]*?)</td>`).exec(row)?.[1] ?? '';
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function parseNoticeRows(html: string, pageUrl: string): NoticeRow[] {
  const rows: NoticeRow[] = [];
  for (const [, row = ''] of html.matchAll(/<tr class="table-tr">([\s\S]*?)<\/tr>/g)) {
    if (!row.includes('class="table-td"')) continue;
    const title = textOf(cell(row, 'title'));
    const date = /(\d{2})-(\d{2})-(\d{4})/.exec(toAsciiDigits(textOf(cell(row, 'publish_date'))));
    if (!title || !date) continue;
    const pdf = /href="([^"]+\.pdf)"/i.exec(cell(row, 'files'))?.[1] ?? null;
    const detail = /href="(\/pages\/notices\/[^"]+)"/.exec(row)?.[1] ?? null;
    rows.push({
      title,
      dateKey: `${date[3]}-${date[2]}-${date[1]}`,
      pdfUrl: pdf ? new URL(pdf, pageUrl).toString() : null,
      detailUrl: detail ? new URL(detail, pageUrl).toString() : null,
    });
  }
  return rows;
}

// A committee decision row: names the committee, a Hijri month, and seen or not seen.
export const isCommitteeNotice = (row: NoticeRow) =>
  namesCommittee(row.title) &&
  hijriMonthIn(row.title) !== null &&
  saysSeen(row.title) !== saysNotSeen(row.title);

// The decision of a committee notice for the sighting evening, or null when the notice is not
// about that evening and month. The notice may be dated the evening itself or the next day
// (Rabi al-Thani 1448: seen on 12 Sep, notice dated 13-09-2026), so the start is counted from
// the evening: the day after when seen, two days after when not seen (30 days complete).
export function noticeDecision(
  row: NoticeRow,
  eveningKey: string,
  expected: { year: number; month: number },
): Decision | null {
  if (!isCommitteeNotice(row)) return null;
  const evening = dayOfKey(eveningKey);
  const dated = dayOfKey(row.dateKey);
  if (dated !== evening && dated !== evening + 1) return null;
  const month = hijriMonthIn(row.title);
  if (month !== expected.month) return null;
  const seen = saysSeen(row.title);
  return {
    seen,
    month,
    // Titles do not state the year; the expected month's notice from this evening is it.
    hijriYear: expected.year,
    startDate: keyOfDay(evening + (seen ? 1 : 2)),
    source: row.pdfUrl ?? row.detailUrl ?? IFB_NOTICES_URL,
    sameEvening: true,
    publisher: 'islamicfoundation.gov.bd',
    basis: 'notice',
  };
}

export type IfbNotice = {
  row: NoticeRow;
  decision: Decision;
  // The start date the PDF states: null when it is scanned, unreadable, or does not say.
  pdfStart: string | null;
};

// This evening's notice from pages 1–2, logging what was found either way.
export async function readIfbNotice(input: {
  fetchText: Fetcher;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  eveningKey: string;
  expected: { year: number; month: number };
  // Rows dated after this day are ignored (a --now run sees only what existed then).
  todayKey?: string;
  log: (line: string) => void;
  // Each page's status for the issue ("OK, 10 rows" or the error with its cause).
  status?: string[];
}): Promise<IfbNotice | null> {
  const { eveningKey, expected, log } = input;
  const note = (line: string) => {
    log(line);
    input.status?.push(line);
  };
  let latest: NoticeRow | null = null;
  for (let page = 1; page <= PAGES; page++) {
    const url = `${IFB_NOTICES_URL}?page=${page}`;
    let rows: NoticeRow[];
    try {
      rows = parseNoticeRows(await input.fetchText(url), url);
    } catch (error) {
      note(`IFB notices page ${page}: ${failureOf(error)}`);
      continue;
    }
    note(`IFB notices page ${page}: OK, ${rows.length} rows`);
    for (const row of rows) {
      if (!isCommitteeNotice(row)) continue;
      if (input.todayKey && row.dateKey > input.todayKey) continue;
      latest ??= row;
      const decision = noticeDecision(row, eveningKey, expected);
      if (!decision) continue;
      log(`IFB notice: "${row.title}" dated ${row.dateKey}, PDF ${row.pdfUrl ?? '(none)'}`);
      log(`  ${JSON.stringify(decision)}`);
      return { row, decision, pdfStart: await statedStart(row, input) };
    }
  }
  note(
    latest
      ? `IFB: no notice for this evening yet; latest committee notice: "${latest.title}" dated ${latest.dateKey}, PDF ${latest.pdfUrl ?? '(none)'}`
      : `IFB: no committee notice on pages 1-${PAGES}`,
  );
  return null;
}

async function statedStart(
  row: NoticeRow,
  input: {
    fetchBytes?: (url: string) => Promise<Uint8Array>;
    eveningKey: string;
    log: (line: string) => void;
  },
): Promise<string | null> {
  if (!row.pdfUrl || !input.fetchBytes) return null;
  try {
    const pdf = pdfText(await input.fetchBytes(row.pdfUrl));
    if (pdf.kind === 'scanned') {
      input.log('  PDF: scanned image, start date not checked (the title decides)');
      return null;
    }
    const start = statedStartIn(pdf.text, input.eveningKey);
    input.log(
      start
        ? `  PDF: text, states the month starts ${start}`
        : '  PDF: text, no start date readable (the title decides)',
    );
    return start;
  } catch (error) {
    input.log(`  PDF: ${failureOf(error)} (the title decides)`);
    return null;
  }
}
