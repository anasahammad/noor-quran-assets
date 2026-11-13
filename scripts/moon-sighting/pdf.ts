// Best-effort text of a PDF, enough to find "… থেকে … মাস গণনা শুরু হবে" in an IFB notice.
// Scanned notices (a page image, no fonts) have no text: the caller then skips the check.
// Text is read from FlateDecode/plain content streams through the fonts' ToUnicode maps.

import { inflateSync } from 'node:zlib';

export type PdfText = { kind: 'scanned' } | { kind: 'text'; text: string };

function streamsOf(raw: string): string[] {
  const streams: string[] = [];
  // A linear scan: "stream" after a dictionary ("… >>"), then its data up to "endstream".
  for (let pos = 0; ;) {
    const at = raw.indexOf('stream', pos);
    if (at === -1) break;
    const head = raw.slice(Math.max(0, at - 2000), at);
    const keyword = /^stream\r?\n/.exec(raw.slice(at, at + 8));
    if (!keyword || !/>>\s*$/.test(head)) {
      pos = at + 6;
      continue;
    }
    const dict = head.slice(head.lastIndexOf('obj') + 3);
    const start = at + keyword[0].length;
    const end = raw.indexOf('endstream', start);
    if (end === -1) break;
    pos = end + 9;
    const data = raw.slice(start, end).replace(/\r?\n$/, '');
    if (/\/Subtype\s*\/Image/.test(dict)) continue;
    if (/\/FlateDecode/.test(dict)) {
      try {
        streams.push(inflateSync(Buffer.from(data, 'latin1')).toString('latin1'));
      } catch {
        // A stream we cannot inflate (another filter, or damaged): ignored.
      }
    } else if (!/\/Filter/.test(dict)) {
      streams.push(data);
    }
  }
  return streams;
}

const fromUtf16Hex = (hex: string) => {
  let text = '';
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return text;
};

// All ToUnicode entries, merged: code (hex, upper case) → text.
function unicodeMap(streams: readonly string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const cmap of streams.filter((s) => s.includes('begincmap'))) {
    for (const [, block = ''] of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const [, code = '', text = ''] of block.matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
      )) {
        map.set(code.toUpperCase(), fromUtf16Hex(text));
      }
    }
    for (const [, block = ''] of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const [, lo = '', hi = '', dst = ''] of block.matchAll(
        /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g,
      )) {
        const first = parseInt(lo, 16);
        const last = Math.min(parseInt(hi, 16), first + 0xffff);
        const base = parseInt(dst.slice(-4), 16);
        const prefix = fromUtf16Hex(dst.slice(0, -4));
        for (let code = first; code <= last; code++) {
          map.set(
            code.toString(16).toUpperCase().padStart(lo.length, '0'),
            prefix + String.fromCharCode(base + code - first),
          );
        }
      }
    }
  }
  return map;
}

function decodeCodes(hex: string, map: Map<string, string>): string {
  let text = '';
  for (let i = 0; i < hex.length;) {
    const four = map.get(hex.slice(i, i + 4));
    if (four !== undefined && i + 4 <= hex.length) {
      text += four;
      i += 4;
      continue;
    }
    const two = hex.slice(i, i + 2);
    text += map.get(two) ?? String.fromCharCode(parseInt(two, 16));
    i += 2;
  }
  return text;
}

const literalHex = (literal: string) =>
  literal
    .replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, escape: string) => {
      const named: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
      return /^[0-7]/.test(escape)
        ? String.fromCharCode(parseInt(escape, 8))
        : (named[escape] ?? escape);
    })
    .split('')
    .map((char) => char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
    .join('');

export function pdfText(bytes: Uint8Array): PdfText {
  const raw = Buffer.from(bytes).toString('latin1');
  const streams = streamsOf(raw);
  // Fonts may sit in the file or inside compressed object streams.
  if (!/\/Font\b/.test(raw) && !streams.some((s) => /\/Font\b/.test(s))) return { kind: 'scanned' };
  const map = unicodeMap(streams);
  const lines: string[] = [];
  for (const content of streams) {
    for (const [, block = ''] of content.matchAll(/\bBT\b([\s\S]*?)\bET\b/g)) {
      let line = '';
      for (const [, hex, literal] of block.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
        const codes =
          hex !== undefined ? hex.replace(/\s/g, '').toUpperCase() : literalHex(literal ?? '');
        line += decodeCodes(codes, map);
      }
      if (line.trim()) lines.push(line);
    }
  }
  return { kind: 'text', text: lines.join('\n') };
}
