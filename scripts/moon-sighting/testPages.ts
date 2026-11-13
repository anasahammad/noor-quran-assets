// Test fixtures: the IFB notices page markup (as served in Nov 2026) and tiny PDFs.

export const noticeRowHtml = (title: string, banglaDate: string, pdfUrl: string | null) =>
  `<tr class="table-tr"> <td class="table-td" data-column="id">১</td> <!-- <td class="table-td">${title}</td>--> <!-- <td class="table-td">10/11/2026</td>--> <td class="table-td" data-column="title"> ${title} </td> <td class="table-td" data-column="files"> ${pdfUrl ? `<a class="table-td-icon" href="${pdfUrl}" target="_blank"> <i class="ph ph-file-pdf file-icon"></i> </a>` : ''} </td> <td class="table-td" data-column="image"> </td> <td class="table-td" data-column="publish_date"> <span>${banglaDate}</span> </td> <td class="table-td centered print-none"> <a href="/pages/notices/notice-${banglaDate}">দেখুন</a> </td> </tr>`;

export const noticePageHtml = (rows: readonly string[]) =>
  `<table id="noticeTable" class="notice-table"> <thead class="table-thead"> <tr class="table-tr"> <th class="table-th" data-column="id">নং</th> <th class="table-th sortable" data-column="title" data-type="text">শিরোনাম</th> </tr> </thead> <tbody class="table-tbody"> <tr class="table-tr toggle-hidden"> <th class="table-th"></th> </tr> ${rows.join(' ')} </tbody> </table>`;

// A minimal PDF with one uncompressed content stream; `text` is written as UTF-16 codes that an
// identity ToUnicode map turns back into the text (how Bangla text PDFs carry their text).
export function textPdf(text: string): Uint8Array {
  const hex = [...text]
    .map((c) => (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0'))
    .join('');
  const cmap =
    '/CIDInit /ProcSet findresource begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0000> <FFFF> <0000> endbfrange endcmap';
  const content = `BT /F1 12 Tf 72 700 Td <${hex}> Tj ET`;
  return new TextEncoder().encode(
    `%PDF-1.4\n1 0 obj << /Type /Font /Subtype /Type0 /ToUnicode 2 0 R >> endobj\n2 0 obj << /Length ${cmap.length} >>\nstream\n${cmap}\nendstream endobj\n3 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream endobj\n%%EOF`,
  );
}

// A scanned notice: one page image, no fonts.
export const scannedPdf = () =>
  new TextEncoder().encode(
    '%PDF-1.4\n1 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /Length 3 >>\nstream\n\u0000\u0000\u0000\nendstream endobj\n%%EOF',
  );
