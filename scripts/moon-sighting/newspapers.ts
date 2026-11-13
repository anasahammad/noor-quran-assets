// The newspaper fallback: reads the configured sources (HTML list pages, RSS feeds, or single
// articles) and logs one status line per source, so the run log shows which sites answered.

import { keyOfDay } from '../../app/src/lib/hijri/calendar.ts';
import { extractDecision, type Decision } from './decision.ts';

export type Source = { name: string; url: string; kind: 'list' | 'rss' | 'article' };

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

// The publication day of an article (Dhaka), from its metadata, if any.
export function publishedKey(html: string, utcOffsetMinutes: number): string | null {
  const match =
    /article:published_time"\s+content="([^"]+)"/i.exec(html) ??
    /content="([^"]+)"\s+property="article:published_time"/i.exec(html) ??
    /<time[^>]+datetime="([^"]+)"/i.exec(html);
  const ms = match?.[1] ? Date.parse(match[1]) : NaN;
  if (Number.isNaN(ms)) return null;
  return keyOfDay(Math.floor((ms + utcOffsetMinutes * 60_000) / 86_400_000));
}

// Article links from a list page whose link text mentions the moon ("চাঁদ").
export function moonLinks(html: string, baseUrl: string, limit = 3): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<a\s[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const [, href = '', inner = ''] = match;
    if (!/চাঁদ/.test(htmlText(inner))) continue;
    const url = new URL(href, baseUrl).toString();
    if (!links.includes(url)) links.push(url);
    if (links.length >= limit) break;
  }
  return links;
}

// An article to read; `summary` (from an RSS item) is used when the article page is blocked.
type Article = { url: string; summary?: { text: string; publishedKey: string | null } };

// Items of an RSS feed whose title mentions the moon, with their title + lead as a summary.
export function rssMoonItems(xml: string, utcOffsetMinutes: number, limit = 3): Article[] {
  const field = (item: string, tag: string) =>
    (new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(item)?.[1] ?? '')
      .replace(/^\s*<!\[CDATA\[/, '')
      .replace(/\]\]>\s*$/, '')
      .trim();
  const items: Article[] = [];
  for (const [, item = ''] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = field(item, 'title');
    const link = field(item, 'link');
    if (!/চাঁদ/.test(title) || !/^https?:\/\//.test(link)) continue;
    if (items.some((a) => a.url === link)) continue;
    const ms = Date.parse(field(item, 'pubDate'));
    items.push({
      url: link,
      summary: {
        text: htmlText(`${title}। ${field(item, 'description')}`),
        publishedKey: Number.isNaN(ms)
          ? null
          : keyOfDay(Math.floor((ms + utcOffsetMinutes * 60_000) / 86_400_000)),
      },
    });
    if (items.length >= limit) break;
  }
  return items;
}

// "blocked (HTTP 403)", "HTTP 404", "timeout" or the error message, for the log.
export function failureOf(error: unknown): string {
  if (error instanceof HttpError) {
    return [401, 403, 429, 503].includes(error.status)
      ? `blocked (HTTP ${error.status})`
      : `HTTP ${error.status}`;
  }
  const { name, message } = error as Error;
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : `error (${message})`;
}

export async function readNewspapers(input: {
  sources: readonly Source[];
  fetchText: Fetcher;
  askGemini?: GeminiAsker;
  eveningKey: string;
  utcOffsetMinutes: number;
  log: (line: string) => void;
}): Promise<Decision[]> {
  const { eveningKey, log } = input;
  const decisions: Decision[] = [];
  for (const source of input.sources) {
    let articles: Article[];
    try {
      if (source.kind === 'article') articles = [{ url: source.url }];
      else {
        const page = await input.fetchText(source.url);
        articles =
          source.kind === 'rss'
            ? rssMoonItems(page, input.utcOffsetMinutes)
            : moonLinks(page, source.url).map((url) => ({ url }));
      }
    } catch (error) {
      log(`Source ${source.name}: ${failureOf(error)}`);
      continue;
    }
    if (articles.length === 0) {
      log(`Source ${source.name}: OK, no article about the moon`);
      continue;
    }
    const found: Decision[] = [];
    const failures: string[] = [];
    for (const { url, summary } of articles) {
      let text: string;
      let published: string | null;
      try {
        const html = await input.fetchText(url);
        text = htmlText(html);
        published = publishedKey(html, input.utcOffsetMinutes);
      } catch (error) {
        if (!summary) {
          failures.push(`${url}: ${failureOf(error)}`);
          continue;
        }
        failures.push(`${url}: ${failureOf(error)}, read the feed's summary instead`);
        ({ text, publishedKey: published } = summary);
      }
      try {
        let decision = extractDecision(text, url, eveningKey, published);
        if (!decision && input.askGemini && /চাঁদ/.test(text)) {
          decision = await input.askGemini(text, eveningKey, url);
        }
        if (decision) found.push(decision);
      } catch (error) {
        failures.push(`${url}: ${failureOf(error)}`);
      }
    }
    const summary = `${articles.length} moon article${articles.length === 1 ? '' : 's'}`;
    log(
      found.length > 0
        ? `Source ${source.name}: OK, ${summary}, ${found.length} with a decision`
        : `Source ${source.name}: OK, ${summary}, no decision in them`,
    );
    for (const failure of failures) log(`  ${failure}`);
    for (const decision of found) log(`  ${JSON.stringify(decision)}`);
    decisions.push(...found);
  }
  return decisions;
}
