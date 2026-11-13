import { describe, it } from 'node:test';
import { expect, fn } from './testing.ts';
import { isCommitteeNotice, noticeDecision, parseNoticeRows } from './ifb.ts';
import { HttpError, failureOf, readNewspapers, rssMoonItems } from './newspapers.ts';
import { pdfText } from './pdf.ts';
import { noticePageHtml, noticeRowHtml, scannedPdf, textPdf } from './testPages.ts';

const PAGE = 'https://islamicfoundation.gov.bd/pages/notices?page=2';
const PDF = 'https://objectstorage.example/office-islamicfoundation/2026/9/caf5b728.pdf';
const NOT_SEEN_TITLE =
  'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি';
// The Rabi al-Thani 1448 notice: crescent seen on 12 Sep, notice dated 13-09-2026.
const SEEN_NEXT_DAY_TITLE =
  'প্রেস বিজ্ঞপ্তি: জাতীয় চাঁদ দেখা কমিটির সভায় সিদ্ধান্ত: বাংলাদেশের আকাশে পবিত্র রবিউস সানি মাসের চাঁদ দেখা গেছে আগামী ২৩ সেপ্টেম্বর বুধবার পবিত্র ফাতেহা-ই-ইয়াজদাহম উদযাপিত হবে';
const row = (title: string, dateKey: string) => ({
  title,
  dateKey,
  pdfUrl: PDF,
  detailUrl: null,
});

describe('IFB notices page', () => {
  it('parses rows: title, Bangla DD-MM-YYYY date, PDF and detail links', () => {
    const html = noticePageHtml([
      noticeRowHtml('অফিস আদেশঃ ১০১, তারিখঃ ০৪-১১-২০২৬', '০৪-১১-২০২৬', null),
      noticeRowHtml(NOT_SEEN_TITLE, '১১-১০-২০২৬', PDF),
    ]);
    expect(parseNoticeRows(html, PAGE)).toEqual([
      {
        title: 'অফিস আদেশঃ ১০১, তারিখঃ ০৪-১১-২০২৬',
        dateKey: '2026-11-04',
        pdfUrl: null,
        detailUrl: expect.stringMatching(/^https:\/\/islamicfoundation\.gov\.bd\/pages\/notices\//),
      },
      expect.objectContaining({ title: NOT_SEEN_TITLE, dateKey: '2026-10-11', pdfUrl: PDF }),
    ]);
  });

  it('knows committee notices, with spelling variants', () => {
    expect(isCommitteeNotice(row(NOT_SEEN_TITLE, '2026-10-11'))).toBe(true);
    expect(isCommitteeNotice(row(SEEN_NEXT_DAY_TITLE, '2026-09-13'))).toBe(true);
    expect(
      isCommitteeNotice(
        row('জাতীয় চাঁদ দেখা কমিটির সিদ্ধান্ত: জুমাদাল উলা মাসের চাঁদ দেখা গিয়েছে', '2026-10-11'),
      ),
    ).toBe(true);
    expect(isCommitteeNotice(row('অফিস আদেশঃ ১০১', '2026-11-04'))).toBe(false);
    expect(isCommitteeNotice(row('জাতীয় চাঁদ দেখা কমিটির সভা আগামীকাল', '2026-10-10'))).toBe(
      false,
    );
  });

  it('not seen: the month starts two days after the evening (30 days complete)', () => {
    expect(
      noticeDecision(row(NOT_SEEN_TITLE, '2026-10-11'), '2026-10-11', { year: 1448, month: 5 }),
    ).toEqual({
      seen: false,
      month: 5,
      hijriYear: 1448,
      startDate: '2026-10-13',
      source: PDF,
      sameEvening: true,
    });
  });

  it('seen, notice dated the next day: the month starts the day after the evening', () => {
    expect(
      noticeDecision(row(SEEN_NEXT_DAY_TITLE, '2026-09-13'), '2026-09-12', {
        year: 1448,
        month: 4,
      }),
    ).toMatchObject({ seen: true, month: 4, startDate: '2026-09-13' });
  });

  it('ignores a notice for another month, or from another evening', () => {
    const expected = { year: 1448, month: 5 };
    expect(noticeDecision(row(NOT_SEEN_TITLE, '2026-10-11'), '2026-11-10', expected)).toBeNull();
    expect(noticeDecision(row(NOT_SEEN_TITLE, '2026-10-13'), '2026-10-11', expected)).toBeNull();
    expect(
      noticeDecision(row(NOT_SEEN_TITLE, '2026-10-11'), '2026-10-11', { year: 1448, month: 6 }),
    ).toBeNull();
  });
});

describe('pdfText', () => {
  it('tells a scanned notice from a text one', () => {
    expect(pdfText(scannedPdf())).toEqual({ kind: 'scanned' });
  });

  it('reads Bangla text through the ToUnicode map', () => {
    const text = 'আগামী মঙ্গলবার (১৩ অক্টোবর) থেকে জমাদিউল আউয়াল মাস গণনা শুরু হবে।';
    expect(pdfText(textPdf(text))).toEqual({ kind: 'text', text });
  });
});

describe('newspapers', () => {
  const RSS = `<rss><channel><title>Feed</title>
    <item><title><![CDATA[জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি]]></title><link>https://www.jagonews24.com/religion/1</link><pubDate>Sun, 11 Oct 2026 14:10:00 GMT</pubDate><description><![CDATA[আজ বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি।]]></description></item>
    <item><title>খেলার খবর</title><link>https://www.jagonews24.com/sports/2</link></item>
  </channel></rss>`;

  it('finds moon items in an RSS feed, with title and lead as a summary', () => {
    expect(rssMoonItems(RSS, 360)).toEqual([
      {
        url: 'https://www.jagonews24.com/religion/1',
        summary: {
          text: 'জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি। আজ বাংলাদেশের আকাশে ১৪৪৮ হিজরি সনের জমাদিউল আউয়াল মাসের চাঁদ দেখা যায়নি।',
          publishedKey: '2026-10-11',
        },
      },
    ]);
  });

  it('names failures for the log', () => {
    expect(failureOf(new HttpError(403))).toBe('blocked (HTTP 403)');
    expect(failureOf(new HttpError(404))).toBe('HTTP 404');
    expect(failureOf(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe('timeout');
  });

  it('logs one status per source and reads a blocked RSS article from its summary', async () => {
    const lines: string[] = [];
    const pages: Record<string, string> = {
      'https://www.jagonews24.com/rss/rss.xml': RSS,
      'https://www.dhakapost.com/religion': '<a href="/x">খেলা</a>',
    };
    const decisions = await readNewspapers({
      sources: [
        { name: 'BSS', url: 'https://www.bssnews.net/bangla/national', kind: 'list' },
        { name: 'Dhaka Post', url: 'https://www.dhakapost.com/religion', kind: 'list' },
        { name: 'Jago News', url: 'https://www.jagonews24.com/rss/rss.xml', kind: 'rss' },
      ],
      fetchText: async (url) => {
        if (url.includes('bssnews')) throw new HttpError(403);
        const page = pages[url];
        if (page === undefined) throw new HttpError(403);
        return page;
      },
      eveningKey: '2026-10-11',
      utcOffsetMinutes: 360,
      log: (line) => lines.push(line),
    });
    expect(lines.slice(0, 4)).toEqual([
      'Source BSS: blocked (HTTP 403)',
      'Source Dhaka Post: OK, no article about the moon',
      'Source Jago News: OK, 1 moon article, 1 with a decision',
      "  https://www.jagonews24.com/religion/1: blocked (HTTP 403), read the feed's summary instead",
    ]);
    expect(decisions).toEqual([
      expect.objectContaining({
        seen: false,
        month: 5,
        startDate: '2026-10-13',
        sameEvening: true,
      }),
    ]);
  });
});
