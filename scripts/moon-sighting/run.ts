// One run of the moon-sighting check (no file system; network only through the injected
// fetchers, so the tests replay fixtures).
//
// Every run, not only on the 29th: the previous, current and next Hijri month (by the app's
// calendar) are checked. A month whose sighting evening has come (the 29th of the month before)
// and that is not yet in monthStarts (nor an official anchor) is resolved from the sources, for
// up to MAX_CATCH_UP_DAYS days after the evening:
//   - IFB notice for that evening and month → confident on its own (unless its PDF disagrees);
//   - otherwise two independent news publishers that agree, after the plausibility check.
// Confident → the month start is written (also when it equals the calculation, so the month is
// recorded and never re-checked). Not confident once the evening is over (23:30 Dhaka) → an
// issue listing every source's status. Still missing after the catch-up days → another issue.

import { bd } from '../../app/src/config/countries/bd.ts';
import {
  createHijriCalendar,
  keyOfDay,
  monthKey as keyOf,
  type HijriCalendar,
  type HijriCalendarConfig,
} from '../../app/src/lib/hijri/calendar.ts';
import { parseRemoteConfig } from '../../app/src/lib/hijri/remoteSchema.ts';
import {
  decide,
  decideFromNotice,
  possibleStarts,
  type Decision,
  type Evening,
  type Outcome,
} from './decision.ts';
import { geminiProblem, type GeminiStatus } from './gemini.ts';
import { readIfbNotice } from './ifb.ts';
import {
  readNewspapers,
  type Fetcher,
  type GeminiAsker,
  type Source,
  type SourceStatus,
} from './newspapers.ts';
import { nextRemoteJson } from './remote.ts';

// The last scheduled run of a sighting evening (23:30 Dhaka): an evening without a confident
// decision by then gets an issue.
export const EVENING_OVER_MINUTES = 23 * 60 + 30;
// Days after the sighting evening during which a missing month is still resolved from the
// sources (the start is at most 2 days after the evening, then 3 more days of catching up).
export const MAX_CATCH_UP_DAYS = 5;

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
const label = (m: { year: number; month: number }) =>
  `${keyOf(m.year, m.month)} (${monthName(m.month)} ${m.year})`;

export type RunDeps = {
  nowMs: number;
  // The app's BD calendar config; tests pin the anchors so new official dates in the app do
  // not change what they test.
  hijriConfig?: HijriCalendarConfig;
  remoteJson: Record<string, unknown>;
  sources: readonly Source[];
  fetchText: Fetcher;
  // For the IFB notice PDF; omitted in tests that do not need it.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  // Gemini fallback; omitted when there is no key or the model is not usable.
  askGemini?: GeminiAsker;
  // Dry run: months already recorded whose evening is within the catch-up days are checked
  // against the sources too (nothing is written either way).
  dryRun?: boolean;
  log?: (line: string) => void;
};

export type MonthCheck = {
  year: number;
  month: number;
  monthKey: string;
  eveningKey: string;
  // [if seen, if not seen]
  possible: readonly [string, string];
  calculated: string;
  // Days since the sighting evening (0 = the evening itself).
  daysSinceEvening: number;
  // 'resolve': not recorded, read the sources; 'verify': recorded, dry run compares;
  // 'missing': not recorded and past the catch-up days.
  mode: 'resolve' | 'verify' | 'missing';
  recorded: string | null;
  outcome: Outcome;
  decisions: Decision[];
  ifbStatus: string[];
  sourceStatus: SourceStatus[];
  // The evening is over (23:30 Dhaka or later): no confident decision now means an issue.
  eveningOver: boolean;
};

export type RunResult = {
  nowMs: number;
  todayKey: string;
  months: MonthCheck[];
  // Month starts to write (confident decisions), in order.
  commits: { monthKey: string; startDate: string; sources: string[] }[];
  // remote.json to write when there are commits.
  nextRemote: Record<string, unknown> | null;
};

const nextOf = (m: { year: number; month: number }) =>
  m.month === 12 ? { year: m.year + 1, month: 1 } : { year: m.year, month: m.month + 1 };
const previousOf = (m: { year: number; month: number }) =>
  m.month === 1 ? { year: m.year - 1, month: 12 } : { year: m.year, month: m.month - 1 };

const sourceOf = (calendar: HijriCalendar, m: { year: number; month: number }) => {
  calendar.startOf(m.year, m.month);
  return calendar.months().find((x) => x.year === m.year && x.month === m.month)?.source ?? null;
};

export async function runCheck(deps: RunDeps): Promise<RunResult> {
  const log = deps.log ?? (() => undefined);
  const config = deps.hijriConfig ?? bd.hijri;
  if (!Number.isFinite(deps.nowMs)) {
    throw new Error(`invalid current time (${String(deps.nowMs)})`);
  }
  const overrides = { ...parseRemoteConfig(deps.remoteJson, config.remoteKey).monthStarts };
  const offsetMinutes = config.observer.utcOffsetMinutes;
  const localMs = deps.nowMs + offsetMinutes * 60_000;
  const today = Math.floor(localMs / 86_400_000);
  const minutesToday = (localMs - today * 86_400_000) / 60_000;
  const clock = `${String(Math.floor(minutesToday / 60)).padStart(2, '0')}:${String(Math.floor(minutesToday % 60)).padStart(2, '0')}`;

  let calendar = createHijriCalendar(config, overrides);
  const todayHijri = calendar.toHijri(today);
  // Never a partial or fallback date: anything the calendar cannot place stops the run.
  if (!todayHijri) {
    throw new Error(`${keyOfDay(today)} is before the first official month of the calendar`);
  }
  log(
    `Now ${new Date(deps.nowMs).toISOString()} = ${keyOfDay(today)} ${clock} in ${config.observer.name} = ${todayHijri.day} ${monthName(todayHijri.month)} ${todayHijri.year} (daytime date)`,
  );

  const current = { year: todayHijri.year, month: todayHijri.month };
  const months: MonthCheck[] = [];
  const commits: RunResult['commits'] = [];
  const candidates = [previousOf(current), current, nextOf(current)];
  for (const [index, target] of candidates.entries()) {
    let unrecordedBefore = false;
    calendar = createHijriCalendar(config, overrides);
    const key = keyOf(target.year, target.month);
    const before = previousOf(target);
    const beforeStart = calendar.startOf(before.year, before.month);
    const targetStart = calendar.startOf(target.year, target.month);
    if (beforeStart === null || targetStart === null) {
      throw new Error(`the calendar has no start for ${key}`);
    }
    const evening = beforeStart + 28;
    const eveningKey = keyOfDay(evening);
    if (today < evening) {
      log(`${label(target)}: sighting evening ${eveningKey}, not yet.`);
      continue;
    }
    const daysSinceEvening = today - evening;
    const source = sourceOf(calendar, target);
    const recorded = source === 'calculated' ? null : keyOfDay(targetStart);
    const withinCatchUp = daysSinceEvening <= MAX_CATCH_UP_DAYS;
    if (recorded) {
      // Official anchors are never re-checked; remote entries only in a dry run (to test).
      if (!(deps.dryRun && source === 'override' && withinCatchUp)) {
        log(`${label(target)}: recorded (${source}) as ${recorded}.`);
        continue;
      }
      log(`${label(target)}: recorded as ${recorded}; dry run, checking the sources anyway.`);
    } else if (sourceOf(calendar, before) === 'calculated') {
      // Its evening depends on a month that is not recorded either. That month is the previous
      // candidate (handled, and reported, just before), except for the first candidate: then
      // both are missing and that is reported here, never silently skipped.
      log(`${label(target)}: waits for ${label(before)} to be recorded.`);
      if (index !== 0) continue;
      unrecordedBefore = true;
    }

    const possible = possibleStarts(eveningKey);
    const check: MonthCheck = {
      year: target.year,
      month: target.month,
      monthKey: key,
      eveningKey,
      possible,
      calculated: keyOfDay(targetStart),
      daysSinceEvening,
      mode: recorded ? 'verify' : withinCatchUp && !unrecordedBefore ? 'resolve' : 'missing',
      recorded,
      outcome: { action: 'none', reason: '' },
      decisions: [],
      ifbStatus: [],
      sourceStatus: [],
      eveningOver: daysSinceEvening >= 1 || minutesToday >= EVENING_OVER_MINUTES,
    };
    months.push(check);
    if (check.mode === 'missing') {
      check.outcome = {
        action: 'issue',
        reason: unrecordedBefore
          ? `neither it nor ${label(before)} is in monthStarts`
          : `not in monthStarts ${daysSinceEvening} days after its sighting evening ${eveningKey}`,
        suggested: null,
      };
      log(`${label(target)}: MISSING, ${check.outcome.reason}.`);
      continue;
    }

    log(
      `${label(target)}: sighting evening ${eveningKey} (${daysSinceEvening === 0 ? 'tonight' : `${daysSinceEvening} day(s) ago`}); starts ${possible[0]} if seen, ${possible[1]} if not; calculated ${check.calculated}.`,
    );
    const expected = { year: target.year, month: target.month };
    const notice = await readIfbNotice({
      fetchText: deps.fetchText,
      fetchBytes: deps.fetchBytes,
      eveningKey,
      expected,
      todayKey: keyOfDay(today),
      log,
      status: check.ifbStatus,
    });
    // Always read, so every run log (and issue) shows which news sources answer.
    const news = await readNewspapers({
      sources: deps.sources,
      fetchText: deps.fetchText,
      askGemini: deps.askGemini,
      evening: { eveningKey, expected, utcOffsetMinutes: offsetMinutes, nowMs: deps.nowMs },
      log,
      status: check.sourceStatus,
    });
    check.decisions = notice ? [notice.decision, ...news] : news;
    check.outcome = notice
      ? decideFromNotice({ notice: notice.decision, pdfStart: notice.pdfStart, expected })
      : decide({ decisions: news, expected });
    // A news decision that disagrees with this evening's IFB notice is worth a look, but the
    // notice still decides.
    if (notice && check.outcome.action === 'commit') {
      const startDate = check.outcome.startDate;
      const others = news.filter((d) => d.startDate !== startDate);
      if (others.length > 0) {
        log(`  Note: ${others.length} news decision(s) differ from the IFB notice (it decides).`);
      }
    }
    log(`${label(target)}: ${describeOutcome(check)}`);

    if (check.outcome.action === 'commit' && check.mode === 'resolve') {
      overrides[key] = check.outcome.startDate;
      commits.push({
        monthKey: key,
        startDate: check.outcome.startDate,
        sources: check.outcome.sources,
      });
    }
  }
  if (months.length === 0) log('Nothing to check: no sighting evening is due.');

  // Schema 2, the new starts added, every existing value kept (nextRemoteJson throws otherwise).
  const nextRemote =
    commits.length === 0
      ? null
      : nextRemoteJson(deps.remoteJson, commits, { country: config.remoteKey, config, today });
  return { nowMs: deps.nowMs, todayKey: keyOfDay(today), months, commits, nextRemote };
}

function describeOutcome(check: MonthCheck): string {
  const { outcome } = check;
  if (outcome.action === 'commit') {
    const how =
      outcome.sources.length === 1 && check.decisions[0]?.basis === 'notice'
        ? 'IFB notice'
        : `${outcome.sources.length} independent news sources`;
    if (check.mode === 'verify') {
      return outcome.startDate === check.recorded
        ? `the sources confirm ${outcome.startDate} (${how}), as recorded.`
        : `the sources say ${outcome.startDate} (${how}) but ${check.recorded} is recorded!`;
    }
    return `CONFIDENT: starts ${outcome.startDate} (${how}).`;
  }
  return `no confident decision: ${outcome.reason}${check.eveningOver ? '' : ' (the evening is not over; the next run tries again)'}.`;
}

// ---------------------------------------------------------------------------------------------
// Issues: one per month and kind. 'update': created, or commented on if it exists (each run
// that still has no decision adds its status). 'once': created only if no issue has the title.

export type Issue = { title: string; body: string; mode: 'update' | 'once' };

const fmtSources = (check: MonthCheck) => {
  const rows = [
    ...check.ifbStatus.map((line) => {
      const [name = '', ...rest] = line.split(': ');
      return `| ${name} | ${escapeCell(rest.join(': '))} |`;
    }),
    ...check.sourceStatus.map((s) => `| ${escapeCell(s.name)} | ${escapeCell(s.status)} |`),
  ];
  return `| Source | Status |\n|---|---|\n${rows.join('\n') || '| (none read) | |'}`;
};
const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const fmtDecisions = (check: MonthCheck) => {
  if (check.decisions.length === 0) return '_No source had a usable decision._';
  const rows = check.decisions.map(
    (d) =>
      `| ${d.publisher ?? ''} | ${d.seen ? 'seen' : 'not seen'} | ${d.startDate} | ${d.basis ?? ''} | ${d.source} |`,
  );
  return `| Publisher | Crescent | Start | How | Link |\n|---|---|---|---|---|\n${rows.join('\n')}`;
};

export function issuesFor(result: RunResult, gemini: GeminiStatus | null = null): Issue[] {
  const problem = gemini ? geminiProblem(gemini) : null;
  const geminiBlock =
    gemini && problem
      ? `\n\n## ⚠️ Gemini\n\n${problem}${gemini.available.length > 0 ? `\n\nModels this key can use: ${gemini.available.map((m) => `\`${m}\``).join(', ')}` : ''}\n\nSet the repository variable \`GEMINI_MODEL\` (Settings > Secrets and variables > Actions > Variables) to a model that exists.`
      : '';
  const runLine = `Run at ${new Date(result.nowMs).toISOString()} (${result.todayKey} in Dhaka).`;
  const issues: Issue[] = [];
  for (const check of result.months) {
    const name = `${monthName(check.month)} ${check.year} (${check.monthKey})`;
    const header = `Sighting evening: **${check.eveningKey}**. The month starts **${check.possible[0]}** if the crescent was seen, **${check.possible[1]}** if not. Our calculation: ${check.calculated}.\n\n${runLine}`;
    const howToFix = `If you know the committee's decision, add it by hand to \`config/remote.json\` (keep everything else):\n\n\`\`\`json\n"monthStarts": { "BD": { "${check.monthKey}": "YYYY-MM-DD" } }\n\`\`\`\n\nthen purge https://purge.jsdelivr.net/gh/anasahammad/noor-quran-assets@main/config/remote.json`;
    if (check.mode === 'missing') {
      issues.push({
        title: `Moon sighting: ${name} still missing after 3 days`,
        mode: 'once',
        body: `${name}: **${check.outcome.action === 'issue' ? check.outcome.reason : 'missing'}**. The Action no longer resolves it from the sources (it tries for ${MAX_CATCH_UP_DAYS} days after the evening), so it needs a human.\n\n${header}\n\n${howToFix}${geminiBlock}`,
      });
      continue;
    }
    if (check.mode === 'verify') continue;
    if (check.outcome.action === 'commit') {
      const commit = result.commits.find((c) => c.monthKey === check.monthKey);
      if (!commit) continue;
      issues.push({
        title: `Moon sighting: ${name} starts ${commit.startDate} (recorded)`,
        mode: 'once',
        body: `\`monthStarts.BD["${check.monthKey}"] = "${commit.startDate}"\` was committed to config/remote.json and jsDelivr was purged${commit.startDate === check.calculated ? ' (same as our calculation)' : ` (our calculation said ${check.calculated})`}.\n\nTo undo: revert the commit and purge again.\n\n${header}\n\n### Decisions\n\n${fmtDecisions(check)}\n\n### Sources\n\n${fmtSources(check)}${geminiBlock}`,
      });
      continue;
    }
    if (!check.eveningOver) continue;
    const reason =
      check.outcome.action === 'none' || check.outcome.action === 'issue'
        ? check.outcome.reason
        : '';
    const suggested =
      check.outcome.action === 'issue' && check.outcome.suggested
        ? `\n\nThe sources point to **${check.outcome.suggested.startDate}**, but that is not confident enough to write on its own.`
        : '';
    issues.push({
      title: `Moon sighting: ${name} not decided`,
      mode: 'update',
      body: `No confident decision for ${name}: **${reason}**. Nothing was written; the next scheduled run tries again (for ${MAX_CATCH_UP_DAYS} days after the evening).${suggested}\n\n${header}\n\n### Sources\n\n${fmtSources(check)}\n\n### Decisions found\n\n${fmtDecisions(check)}\n\n${howToFix}${geminiBlock}`,
    });
  }
  if (problem && gemini && !issues.some((i) => i.body.includes('## ⚠️ Gemini'))) {
    issues.push({
      title: `Moon sighting: Gemini model "${gemini.model}" is not usable`,
      mode: 'once',
      body: `The moon-sighting check cannot use Gemini (the Bangla patterns still work).${geminiBlock}`,
    });
  }
  return issues;
}

// The commit message for the month starts written in this run.
export function commitTitle(result: RunResult): string | null {
  if (result.commits.length === 0) return null;
  return `moon-sighting: ${result.commits
    .map((c) => {
      const check = result.months.find((m) => m.monthKey === c.monthKey);
      const how =
        c.sources.length === 1 && check?.decisions[0]?.basis === 'notice'
          ? 'IFB notice'
          : `${c.sources.length} news sources`;
      return `${c.monthKey} (${monthName(Number(c.monthKey.slice(5)))}) starts ${c.startDate} (${how})`;
    })
    .join('; ')}`;
}

export type { Evening };
