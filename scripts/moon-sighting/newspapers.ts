// The news sources: reads the configured sources (HTML list pages, RSS feeds, or single
// articles) and logs one status line per source, so the run log (and the issue) shows which
// sites answered. Only the decision date is read from them; no article text is kept.

import { fold } from './bangla.ts';
import {
  domainOf,
  implausibility,
  readDecision,
  type Decision,
  type Evening,
  type Reading,
} from './decision.ts';

export type Source = {
  name: string;
  url: string;
  kind: 'list' | 'rss' | 'article';
  // false: use only the feed item (title + summary), never fetch the article page. For
  // aggregators (Google News links are redirects), whose items name their publisher.
  articles?: boolean;
  // Most items/links read per source (default 5; feeds whose items are not fetched: 40).
  limit?: number;
};

// A failed HTTP response; `status` tells a blocked site (403/429/503) from a broken URL.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

export type Fetcher = (url: string) => Promise<string>;
export type GeminiAsker = (
  text: string,
  eveningKey: string,
  url: string,
) => Promise<Decision | null>;

// Plain text of an HTML page (scripts, styles and tags removed, common entities decoded).
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// When an article was published (ms), from its metadata, if any.
export function publishedMs(html: string): number | null {
  const match =
    /article:published_time"\s+content="([^"]+)"/i.exec(html) ??
    /content="([^"]+)"\s+property="article:published_time"/i.exec(html) ??
    /"datePublished"\s*:\s*"([^"]+)"/i.exec(html) ??
    /<time[^>]+datetime="([^"]+)"/i.exec(html);
  const ms = match?.[1] ? Date.parse(match[1]) : NaN;
  return Number.isNaN(ms) ? null : ms;
}

// The moon ("চাঁদ"), not "চাঁদা" (extortion, a frequent headline word).
export const mentionsMoon = (text: string) => /চাদ(?!া)/.test(fold(text));

// An article to read. `summary`: what the feed or list page already says (title, lead,
// publication time, publisher), used alone when the article page is not fetched or blocked.
export type Article = {
  url: string;
  summary?: { text: string; publishedMs: number | null; publisher?: string };
};

// Article links from a list page whose link text mentions the moon, with the link text as a
// headline-only summary.
export function moonLinks(html: string, baseUrl: string, limit = 5): Article[] {
  const links: Article[] = [];
  for (const match of html.matchAll(/<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href = '', inner = ''] = match;
    const text = htmlText(inner);
    if (!mentionsMoon(text)) continue;
    const url = new URL(href, baseUrl).toString();
    if (links.some((a) => a.url === url)) continue;
    links.push({ url, summary: { text, publishedMs: null } });
    if (links.length >= limit) break;
  }
  return links;
}

const decodeXml = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');

// Items of an RSS feed whose title mentions the moon, with title + lead as a summary. An item
// with <source url="…"> (Google News) is attributed to that publisher, and its " - Publisher"
// title suffix is dropped.
export function rssMoonItems(xml: string, limit = 5): Article[] {
  const field = (item: string, tag: string) =>
    (new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(item)?.[1] ?? '')
      .replace(/^\s*<!\[CDATA\[/, '')
      .replace(/\]\]>\s*$/, '')
      .trim();
  const items: Article[] = [];
  for (const [, item = ''] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    let title = decodeXml(field(item, 'title'));
    const link = decodeXml(field(item, 'link'));
    if (!mentionsMoon(title) || !/^https?:\/\//.test(link)) continue;
    if (items.some((a) => a.url === link)) continue;
    const sourceTag = /<source\b[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/i.exec(item);
    const publisher = sourceTag?.[1] ? domainOf(decodeXml(sourceTag[1])) : undefined;
    const publisherName = sourceTag?.[2] ? decodeXml(sourceTag[2]).trim() : '';
    if (publisherName && title.endsWith(` - ${publisherName}`)) {
      title = title.slice(0, -` - ${publisherName}`.length);
    }
    // Google News descriptions only repeat the title as a link; skip them then.
    const description = publisher ? '' : htmlText(decodeXml(field(item, 'description')));
    const ms = Date.parse(field(item, 'pubDate') || field(item, 'dc:date'));
    items.push({
      url: link,
      summary: {
        text: description ? `${htmlText(title)}। ${description}` : htmlText(title),
        publishedMs: Number.isNaN(ms) ? null : ms,
        publisher,
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}

// Node's fetch only says "fetch failed"; the reason is in `cause` (sometimes nested, e.g.
// AggregateError or undici's ConnectTimeoutError). Codes and messages of the whole chain.
export function causeChain(error: unknown): { code: string | null; message: string }[] {
  const chain: { code: string | null; message: string }[] = [];
  let current: unknown = (error as { cause?: unknown } | null)?.cause;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, message, errors } = current as {
      code?: unknown;
      message?: unknown;
      errors?: unknown;
    };
    chain.push({
      code: typeof code === 'string' ? code : null,
      message: typeof message === 'string' ? message : String(current),
    });
    current =
      (current as { cause?: unknown }).cause ?? (Array.isArray(errors) ? errors[0] : undefined);
  }
  return chain;
}

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
// What blocking a foreign IP (the GitHub runner) usually looks like: the connection is dropped,
// refused or never answered.
const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export type FailureKind = 'blocked' | 'http' | 'timeout' | 'tls' | 'dns' | 'network' | 'other';

export function failureKind(error: unknown): FailureKind {
  if (error instanceof HttpError) {
    return [401, 403, 429, 451, 503].includes(error.status) ? 'blocked' : 'http';
  }
  const { name } = error as Error;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const codes = causeChain(error).map((c) => c.code);
  if (codes.some((c) => c !== null && (TLS_CODES.has(c) || c.startsWith('ERR_TLS')))) return 'tls';
  if (codes.some((c) => c !== null && DNS_CODES.has(c))) return 'dns';
  if (codes.some((c) => c !== null && NETWORK_CODES.has(c))) return 'network';
  return 'other';
}

const HINTS: Partial<Record<FailureKind, string>> = {
  tls: 'certificate chain problem: the site does not send a certificate Node needs; add it to certs/ and NODE_EXTRA_CA_CERTS (never turn verification off)',
  dns: 'DNS lookup failed',
  network:
    'connection dropped/refused/timed out: most likely the site blocks the runner (foreign IP); not fixable here, the news sources must cover it',
};

// "blocked (HTTP 403)", "HTTP 404", "timeout", or the error with its cause chain and a hint,
// for the log and the issue, e.g.
//   "fetch failed; cause: UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate
//    [certificate chain problem: …]"
export function failureOf(error: unknown): string {
  const kind = failureKind(error);
  if (error instanceof HttpError) {
    return kind === 'blocked' ? `blocked (HTTP ${error.status})` : `HTTP ${error.status}`;
  }
  if (kind === 'timeout') return 'timeout';
  const { message } = error as Error;
  const causes = causeChain(error)
    .map((c) => (c.code ? `${c.code}: ${c.message}` : c.message))
    .join(' <- ');
  const hint = HINTS[kind];
  return `error (${message}${causes ? `; cause: ${causes}` : ''})${hint ? ` [${hint}]` : ''}`;
}

// Readings that the Bangla patterns could not settle, worth asking Gemini about.
const UNSETTLED = new Set(['names no Hijri month', 'says both seen and not seen']);

export type SourceStatus = { name: string; status: string };

export async function readNewspapers(input: {
  sources: readonly Source[];
  fetchText: Fetcher;
  askGemini?: GeminiAsker;
  evening: Evening;
  log: (line: string) => void;
  // One line per source for the issue.
  status?: SourceStatus[];
}): Promise<Decision[]> {
  const { evening, log } = input;
  const decisions: Decision[] = [];
  const report = (source: Source, status: string) => {
    log(`Source ${source.name}: ${status}`);
    input.status?.push({ name: source.name, status });
  };
  for (const source of input.sources) {
    const fetchArticles = source.articles !== false;
    const limit = source.limit ?? (fetchArticles ? 5 : 40);
    let articles: Article[];
    try {
      if (source.kind === 'article') articles = [{ url: source.url }];
      else {
        const page = await input.fetchText(source.url);
        articles =
          source.kind === 'rss' ? rssMoonItems(page, limit) : moonLinks(page, source.url, limit);
      }
    } catch (error) {
      report(source, failureOf(error));
      continue;
    }
    if (articles.length === 0) {
      report(source, 'OK, no article about the moon');
      continue;
    }
    const found: Decision[] = [];
    const notes: string[] = [];
    for (const { url, summary } of articles) {
      let text: string;
      let published: number | null;
      let fromPage = false;
      if (!fetchArticles && summary) {
        ({ text, publishedMs: published } = summary);
      } else {
        try {
          const html = await input.fetchText(url);
          text = htmlText(html);
          published = publishedMs(html) ?? summary?.publishedMs ?? null;
          fromPage = true;
        } catch (error) {
          if (!summary) {
            notes.push(`${url}: ${failureOf(error)}`);
            continue;
          }
          notes.push(`${url}: ${failureOf(error)}, read the ${source.kind === 'rss' ? "feed's summary" : 'headline'} instead`);
          ({ text, publishedMs: published } = summary);
        }
      }
      const publisher = summary?.publisher;
      let reading: Reading = readDecision(text, url, evening, published, publisher);
      const unsettled =
        reading.kind === 'none' || (reading.kind === 'ignored' && UNSETTLED.has(reading.reason));
      if (unsettled && fromPage && input.askGemini && mentionsMoon(text)) {
        try {
          const answer = await input.askGemini(text, evening.eveningKey, url);
          if (answer) {
            const decision = { ...answer, publisher: publisher ?? domainOf(url), basis: 'gemini' as const };
            const problem =
              published !== null && published > evening.nowMs
                ? 'published after the time of this run'
                : implausibility(decision, evening);
            reading = problem
              ? { kind: 'ignored', reason: `Gemini: ${problem}` }
              : { kind: 'decision', decision };
          }
        } catch (error) {
          notes.push(`${url}: ${failureOf(error)}`);
        }
      }
      const label = summary?.text && !fromPage ? `"${summary.text.slice(0, 90)}"` : url;
      if (reading.kind === 'decision') found.push(reading.decision);
      else if (reading.kind === 'ignored') notes.push(`${label}: ignored, ${reading.reason}`);
    }
    const count = `${articles.length} moon item${articles.length === 1 ? '' : 's'}`;
    const publishers = new Set(found.map((d) => d.publisher ?? domainOf(d.source)));
    report(
      source,
      found.length > 0
        ? `OK, ${count}, ${found.length} with a decision (${[...publishers].join(', ')})`
        : `OK, ${count}, no decision for this evening in them`,
    );
    for (const note of notes) log(`  ${note}`);
    for (const decision of found) {
      log(`  ${decision.publisher}: ${decision.seen ? 'seen' : 'not seen'}, starts ${decision.startDate} (${decision.basis}) ${decision.source}`);
    }
    decisions.push(...found);
  }
  return decisions;
}
