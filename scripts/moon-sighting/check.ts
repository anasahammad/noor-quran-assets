/**
 * Moon-sighting check, run by the GitHub Action in the noor-quran-assets repo every evening
 * (18:30–23:30 Dhaka). Uses the app's own calendar (src/lib/hijri, same files, no copy).
 *
 *   node scripts/moon-sighting/check.ts --remote <assets>/config/remote.json
 *        [--sources <file>] [--now <ISO time>] [--dry-run]
 *
 * 1. Exits unless this evening is the 29th by our calendar (or yesterday was and no decision
 *    is recorded yet).
 * 2. Primary source: the Islamic Foundation's notices page (ifb.ts). This evening's committee
 *    notice for the expected month is enough on its own (unless its PDF states another date).
 * 3. Newspapers (sources.json; Bangla patterns first, Gemini only for articles the patterns
 *    can't settle) are always read and logged per source, but only decide when no IFB notice is
 *    found by 23:30 Dhaka (or on the next day); then two independent sources must agree.
 * 4. Matches our calculated start → nothing. Differs → commits the monthStarts entry, or asks
 *    for a human with an issue. Writes `action`, `title`, `body_file` to $GITHUB_OUTPUT; the
 *    workflow commits, purges jsDelivr and opens the issue.
 * Only monthStarts is ever changed, and the JSON is validated before it is written.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bd } from '../../app/src/config/countries/bd.ts';
import { createHijriCalendar, dayOfKey, keyOfDay, monthKey } from '../../app/src/lib/hijri/calendar.ts';
import { isValidDateKey, parseRemoteConfig } from '../../app/src/lib/hijri/remoteSchema.ts';
import {
  decide,
  decideFromNotice,
  withMonthStart,
  type Decision,
  type Outcome,
} from './decision.ts';
import { readIfbNotice } from './ifb.ts';
import {
  HttpError,
  readNewspapers,
  type Fetcher,
  type GeminiAsker,
  type Source,
} from './newspapers.ts';

// Newspapers decide only from 23:30 Dhaka on the sighting evening (the last scheduled run).
const NEWSPAPER_FALLBACK_MINUTES = 23 * 60 + 30;

// A normal browser, so news sites serve the page they serve to readers.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'bn-BD,bn;q=0.9,en;q=0.8',
};

export type CheckDeps = {
  nowMs: number;
  remoteJson: Record<string, unknown>;
  sources: readonly Source[];
  fetchText: Fetcher;
  // For the IFB notice PDF; omitted in tests that do not need it.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  // Gemini fallback; omitted when there is no key.
  askGemini?: GeminiAsker;
  log?: (line: string) => void;
};

export type CheckResult = {
  outcome: Outcome | { action: 'skip'; reason: string };
  decisions: Decision[];
  eveningKey: string | null;
  // remote.json to write when the outcome is a commit.
  nextRemote: Record<string, unknown> | null;
};

const HIJRI_MONTH_NAMES = [
  'Muharram',
  'Safar',
  'Rabi al-Awwal',
  'Rabi al-Thani',
  'Jumada al-Awwal',
  'Jumada al-Akhirah',
  'Rajab',
  'Shaban',
  'Ramadan',
  'Shawwal',
  'Dhul Qadah',
  'Dhul Hijjah',
];
export const monthName = (month: number) => HIJRI_MONTH_NAMES[month - 1] ?? String(month);

export async function runCheck(deps: CheckDeps): Promise<CheckResult> {
  const log = deps.log ?? (() => undefined);
  const config = bd.hijri;
  const remote = parseRemoteConfig(deps.remoteJson, config.remoteKey);
  const calendar = createHijriCalendar(config, remote.monthStarts);
  if (!Number.isFinite(deps.nowMs)) {
    throw new Error(`invalid current time (${String(deps.nowMs)})`);
  }
  const offsetMs = config.observer.utcOffsetMinutes * 60_000;
  const today = Math.floor((deps.nowMs + offsetMs) / 86_400_000);
  // Never a partial or fallback date: anything the calendar cannot place stops the run.
  const hijriOf = (day: number) => {
    const hijri = calendar.toHijri(day);
    if (!hijri) {
      throw new Error(`${keyOfDay(day)} is before the first official month of the calendar`);
    }
    return hijri;
  };
  const describe = (h: { day: number; month: number; year: number }) =>
    `${h.day} ${monthName(h.month)} ${h.year}`;

  const todayHijri = hijriOf(today);
  const yesterdayHijri = hijriOf(today - 1);
  log(
    `Now ${new Date(deps.nowMs).toISOString()} = ${keyOfDay(today)} in ${config.observer.name} = ${describe(todayHijri)} (daytime date)`,
  );

  // This evening is the 29th, or yesterday was and the next month is not decided yet.
  let evening: number | null = null;
  if (todayHijri.day === 29) evening = today;
  else if (yesterdayHijri.day === 29) evening = today - 1;
  const eveningHijri = evening === null ? null : hijriOf(evening);
  if (evening === null || !eveningHijri) {
    log(`Not a sighting evening: today is ${describe(todayHijri)}.`);
    return {
      outcome: { action: 'skip', reason: `not a sighting evening (${describe(todayHijri)})` },
      decisions: [],
      eveningKey: null,
      nextRemote: null,
    };
  }
  const eveningKey = keyOfDay(evening);
  const expected =
    eveningHijri.month === 12
      ? { year: eveningHijri.year + 1, month: 1 }
      : { year: eveningHijri.year, month: eveningHijri.month + 1 };
  const key = monthKey(expected.year, expected.month);
  const decided = calendar
    .months()
    .find((m) => m.year === expected.year && m.month === expected.month);
  if (evening !== today && decided && decided.source !== 'calculated') {
    return {
      outcome: { action: 'skip', reason: `${key} already decided (${decided.source})` },
      decisions: [],
      eveningKey,
      nextRemote: null,
    };
  }
  const startDay = calendar.startOf(expected.year, expected.month);
  if (startDay === null) throw new Error(`no calculated start for ${key}`);
  const calculatedStart = keyOfDay(startDay);
  log(
    `Sighting evening ${eveningKey} = ${describe(eveningHijri)}; ${key} calculated ${calculatedStart}`,
  );

  const notice = await readIfbNotice({
    fetchText: deps.fetchText,
    fetchBytes: deps.fetchBytes,
    eveningKey,
    expected,
    log,
  });
  // Always read, so every run log shows which newspapers answer.
  const newspapers = await readNewspapers({
    sources: deps.sources,
    fetchText: deps.fetchText,
    askGemini: deps.askGemini,
    eveningKey,
    utcOffsetMinutes: config.observer.utcOffsetMinutes,
    log,
  });
  const decisions = notice ? [notice.decision, ...newspapers] : newspapers;
  const minutesSinceEvening = (deps.nowMs + offsetMs - evening * 86_400_000) / 60_000;

  let outcome: Outcome;
  if (notice) {
    outcome = decideFromNotice({
      notice: notice.decision,
      pdfStart: notice.pdfStart,
      expected,
      calculatedStart,
    });
  } else if (minutesSinceEvening >= NEWSPAPER_FALLBACK_MINUTES) {
    log('No IFB notice by 23:30: the newspapers decide (two independent sources must agree).');
    outcome = decide({ decisions: newspapers, expected, calculatedStart });
  } else {
    outcome = {
      action: 'none',
      reason: 'no IFB notice yet; newspapers decide only from 23:30 without one',
    };
  }
  let nextRemote: Record<string, unknown> | null = null;
  if (outcome.action === 'commit') {
    nextRemote = withMonthStart(
      deps.remoteJson,
      config.remoteKey,
      outcome.monthKey,
      outcome.startDate,
    );
    // Validate: it must parse back with the new start, and nothing else may change.
    const parsed = parseRemoteConfig(nextRemote, config.remoteKey);
    const { monthStarts: _before, ...restBefore } = deps.remoteJson;
    const { monthStarts: _after, ...restAfter } = nextRemote;
    if (
      parsed.monthStarts[outcome.monthKey] !== outcome.startDate ||
      !isValidDateKey(outcome.startDate) ||
      JSON.stringify(restBefore) !== JSON.stringify(restAfter)
    ) {
      throw new Error('refusing to write: the new remote.json does not validate');
    }
  }
  return { outcome, decisions, eveningKey, nextRemote };
}

// The Gemini fallback (free tier), constrained to a JSON schema; anything inconsistent is dropped.
export function geminiAsker(apiKey: string, fetchImpl: typeof fetch = fetch) {
  return async (text: string, eveningKey: string, url: string): Promise<Decision | null> => {
    const prompt = `This is a Bangladeshi news article (${url}). Did Bangladesh's National Moon Sighting Committee (Islamic Foundation) decide on the evening of ${eveningKey} whether the new Hijri month's crescent was seen? Answer only from the text. month is 1-12 (Muharram=1), startDate is the first day of that month (YYYY-MM-DD), meetingDate is the date of the committee meeting the article reports. If the article does not report such a decision, set conclusive=false.\n\n${text.slice(0, 12_000)}`;
    const response = await fetchImpl(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: {
              type: 'OBJECT',
              properties: {
                conclusive: { type: 'BOOLEAN' },
                seen: { type: 'BOOLEAN' },
                month: { type: 'INTEGER' },
                hijriYear: { type: 'INTEGER' },
                startDate: { type: 'STRING' },
                meetingDate: { type: 'STRING' },
                source: { type: 'STRING' },
              },
              required: [
                'conclusive',
                'seen',
                'month',
                'hijriYear',
                'startDate',
                'meetingDate',
                'source',
              ],
            },
          },
        }),
      },
    );
    if (!response.ok) throw new Error(`Gemini: HTTP ${response.status}`);
    const body = (await response.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) return null;
    const answer = JSON.parse(raw) as {
      conclusive: boolean;
      seen: boolean;
      month: number;
      hijriYear: number;
      startDate: string;
      meetingDate: string;
    };
    const expectedStart = keyOfDay(dayOfKey(eveningKey) + (answer.seen ? 1 : 2));
    const consistent =
      answer.conclusive &&
      Number.isInteger(answer.month) &&
      answer.month >= 1 &&
      answer.month <= 12 &&
      isValidDateKey(answer.startDate) &&
      answer.startDate === expectedStart;
    if (!consistent) return null;
    return {
      seen: answer.seen,
      month: answer.month,
      hijriYear: Number.isInteger(answer.hijriYear) ? answer.hijriYear : null,
      startDate: answer.startDate,
      source: url,
      sameEvening: answer.meetingDate === eveningKey,
    };
  };
}

// Markdown for the GitHub issue.
export function issueText(result: CheckResult): { title: string; body: string } | null {
  const { outcome } = result;
  const table = result.decisions
    .map(
      (d) =>
        `| ${d.source} | ${d.seen ? 'seen' : 'not seen'} | ${monthName(d.month)} ${d.hijriYear ?? '?'} | ${d.startDate} | ${d.sameEvening ? 'yes' : 'no'} |`,
    )
    .join('\n');
  const decisionsBlock = `| Source | Crescent | Month | Start | This evening |\n|---|---|---|---|---|\n${table || '| (none) | | | | |'}`;
  if (outcome.action === 'commit') {
    const [year = '', month = ''] = outcome.monthKey.split('-');
    return {
      // One source is the IFB notice (it decides alone); newspapers commit only in twos.
      title: `Auto-updated ${monthName(Number(month))} ${year}: ${outcome.startDate} (${outcome.sources.length === 1 ? 'IFB notice' : `${outcome.sources.length} sources`})`,
      body: `The committee's decision on ${result.eveningKey} differs from our calculation, so \`monthStarts.BD["${outcome.monthKey}"] = "${outcome.startDate}"\` was committed to config/remote.json and jsDelivr was purged.\n\nTo undo: revert the commit (one click on the commit page) and purge again.\n\n${decisionsBlock}`,
    };
  }
  if (outcome.action === 'issue') {
    const suggested = outcome.suggested
      ? `\n\nSuggested remote.json entry (not committed):\n\n\`\`\`json\n"monthStarts": { "BD": { "${outcome.suggested.monthKey}": "${outcome.suggested.startDate}" } }\n\`\`\``
      : '';
    return {
      title: `Moon sighting needs a check (${result.eveningKey}): ${outcome.reason}`,
      body: `No change was made: ${outcome.reason}.\n\n${decisionsBlock}${suggested}`,
    };
  }
  return null;
}

// --now: an ISO date-time with an explicit offset ("2026-11-10T20:00:00+06:00" or "…Z"),
// surrounding spaces ignored. Anything else throws: the run must never guess a date.
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export function parseNowArg(raw: string): number {
  const value = raw.trim();
  const match = ISO_WITH_OFFSET.exec(value);
  const ms = Date.parse(value);
  if (!match || Number.isNaN(ms)) {
    throw new Error(
      `--now must be an ISO date-time with an offset, e.g. 2026-11-10T20:00:00+06:00 (got "${raw}")`,
    );
  }
  // Reject dates that Date.parse would roll over (e.g. 2026-02-30).
  const [, y, mo, d, h, mi, s = '0', zone = 'Z'] = match;
  const offsetMinutes =
    zone === 'Z'
      ? 0
      : (zone.startsWith('-') ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4)));
  const local = new Date(ms + offsetMinutes * 60_000);
  const sameFields =
    local.getUTCFullYear() === Number(y) &&
    local.getUTCMonth() + 1 === Number(mo) &&
    local.getUTCDate() === Number(d) &&
    local.getUTCHours() === Number(h) &&
    local.getUTCMinutes() === Number(mi) &&
    local.getUTCSeconds() === Number(s);
  if (!sameFields) throw new Error(`--now is not a real date-time (got "${raw}")`);
  return ms;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function browserFetch(url: string): Promise<Response> {
  const response = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new HttpError(response.status);
  return response;
}

// NODE_EXTRA_CA_CERTS is read once at startup and a missing file only prints a warning, so say
// plainly whether the intermediate certificate is there.
export function extraCaStatus(path: string | undefined): string {
  if (!path) return 'NODE_EXTRA_CA_CERTS is not set (the IFB site will fail TLS verification)';
  try {
    const pem = readFileSync(path, 'utf8');
    const count = pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
    return count > 0
      ? `NODE_EXTRA_CA_CERTS: ${path} (${count} certificate${count === 1 ? '' : 's'})`
      : `NODE_EXTRA_CA_CERTS: ${path} has no certificate`;
  } catch (error) {
    return `NODE_EXTRA_CA_CERTS: ${path} cannot be read (${(error as Error).message})`;
  }
}

async function main() {
  console.log(extraCaStatus(process.env.NODE_EXTRA_CA_CERTS));
  const args = process.argv.slice(2);
  const remotePath = resolve(argValue(args, '--remote') ?? 'config/remote.json');
  const sourcesPath = resolve(
    argValue(args, '--sources') ?? resolve(import.meta.dirname, 'sources.json'),
  );
  const dryRun = args.includes('--dry-run');
  const now = argValue(args, '--now');
  const remoteJson = JSON.parse(readFileSync(remotePath, 'utf8')) as Record<string, unknown>;
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8')) as Source[];
  const apiKey = process.env.GEMINI_API_KEY;

  const result = await runCheck({
    // An empty --now (the scheduled runs) means the real current time.
    nowMs: now !== undefined && now.trim() !== '' ? parseNowArg(now) : Date.now(),
    remoteJson,
    sources,
    fetchText: async (url) => (await browserFetch(url)).text(),
    fetchBytes: async (url) => new Uint8Array(await (await browserFetch(url)).arrayBuffer()),
    askGemini: apiKey ? geminiAsker(apiKey) : undefined,
    log: (line) => console.log(line),
  });
  console.log(`Outcome: ${JSON.stringify(result.outcome)}`);

  const action = result.outcome.action;
  const issue = issueText(result);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (dryRun) {
    if (result.nextRemote)
      console.log(`[dry run] would write:\n${JSON.stringify(result.nextRemote, null, 2)}`);
    if (issue) console.log(`[dry run] would open: ${issue.title}\n${issue.body}`);
    if (outputPath) appendFileSync(outputPath, 'action=none\n');
    return;
  }
  if (result.nextRemote)
    writeFileSync(remotePath, `${JSON.stringify(result.nextRemote, null, 2)}\n`);
  if (outputPath) {
    const bodyFile = resolve('moon-sighting-issue.md');
    if (issue) writeFileSync(bodyFile, issue.body);
    appendFileSync(
      outputPath,
      `action=${action === 'commit' || action === 'issue' ? action : 'none'}\n` +
        (issue ? `title=${issue.title}\nbody_file=${bodyFile}\n` : ''),
    );
  }
}

// Run as a script (not when the tests import this file).
if (process.argv[1]?.endsWith('check.ts')) {
  main().catch((error: unknown) => {
    // A GitHub error annotation, so the failed run says why at the top.
    console.error(`::error title=Moon sighting check failed::${(error as Error).message}`);
    console.error(error);
    process.exit(1);
  });
}
