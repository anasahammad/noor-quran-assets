/**
 * Moon-sighting check, run by .github/workflows/moon-sighting.yml (several times on every
 * evening and the next morning). Uses the app's own calendar (./app/src/lib/hijri, a sparse
 * checkout of the app repo), so the Action and the app always agree.
 *
 *   node scripts/moon-sighting/check.ts --remote config/remote.json
 *        [--sources <file>] [--now <ISO time>] [--dry-run]
 *
 * What a run does is in run.ts. This file is the command line: real fetches, the Gemini model
 * check, writing remote.json and the issue list, and the step outputs for the workflow:
 *   action=commit|none, commit_title, issues_file (JSON [{title, body, mode}]).
 * --dry-run writes nothing and sets action=none; it prints what it would do.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  checkGeminiModel,
  DEFAULT_GEMINI_MODEL,
  geminiAsker,
  geminiOff,
} from './gemini.ts';
import { HttpError, type Source } from './newspapers.ts';
import { commitTitle, issuesFor, runCheck } from './run.ts';

// A normal browser, so news sites serve the page they serve to readers.
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'bn-BD,bn;q=0.9,en;q=0.8',
};

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

async function main() {
  console.log(extraCaStatus(process.env.NODE_EXTRA_CA_CERTS));
  const args = process.argv.slice(2);
  const remotePath = resolve(argValue(args, '--remote') ?? 'config/remote.json');
  const sourcesPath = resolve(
    argValue(args, '--sources') ?? resolve(import.meta.dirname, 'sources.json'),
  );
  const dryRun = args.includes('--dry-run');
  const now = argValue(args, '--now');
  // An empty --now (the scheduled runs) means the real current time.
  const nowMs = now !== undefined && now.trim() !== '' ? parseNowArg(now) : Date.now();
  const remoteJson = JSON.parse(readFileSync(remotePath, 'utf8')) as Record<string, unknown>;
  const sources = JSON.parse(readFileSync(sourcesPath, 'utf8')) as Source[];
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  if (dryRun) console.log('DRY RUN: nothing is committed, purged or opened.');

  // First thing: is the configured model there? (On 10 Nov 2026 it was not: HTTP 404.)
  const gemini = apiKey ? await checkGeminiModel(apiKey, model) : geminiOff(model);
  console.log(
    gemini.state === 'off'
      ? 'Gemini: off (no GEMINI_API_KEY)'
      : gemini.state === 'ok'
        ? `Gemini: model ${model} OK`
        : `::error title=Gemini model ${model} is not usable::${gemini.problem ?? gemini.state}${gemini.available.length ? `. Available: ${gemini.available.join(', ')}` : ''}`,
  );

  const result = await runCheck({
    nowMs,
    remoteJson,
    sources,
    fetchText: async (url) => (await browserFetch(url)).text(),
    fetchBytes: async (url) => new Uint8Array(await (await browserFetch(url)).arrayBuffer()),
    askGemini:
      apiKey && gemini.state === 'ok'
        ? geminiAsker(apiKey, fetch, { model, status: gemini })
        : undefined,
    dryRun,
    log: (line) => console.log(line),
  });
  for (const error of gemini.errors) console.log(`::error title=Gemini ${model}::${error}`);

  const issues = issuesFor(result, gemini);
  const title = commitTitle(result);
  const nextRemote = result.nextRemote;
  for (const check of result.months) {
    if (check.mode === 'resolve' && check.eveningOver && check.outcome.action !== 'commit') {
      console.log(`::warning title=Moon sighting ${check.monthKey}::not decided (${check.outcome.action === 'none' || check.outcome.action === 'issue' ? check.outcome.reason : ''})`);
    }
  }

  const outputPath = process.env.GITHUB_OUTPUT;
  if (dryRun) {
    console.log('\n===== DRY RUN: what a real run would do =====');
    if (nextRemote) {
      console.log(`would commit "${title}" with config/remote.json:\n${JSON.stringify(nextRemote, null, 2)}`);
      console.log('would purge jsDelivr for config/remote.json');
    } else {
      console.log('would not change config/remote.json');
    }
    for (const issue of issues) {
      console.log(`\nwould ${issue.mode === 'update' ? 'open or comment on' : 'open (if new)'} issue: ${issue.title}\n${issue.body}`);
    }
    if (issues.length === 0) console.log('would open no issue');
    if (outputPath) appendFileSync(outputPath, 'action=none\n');
    return;
  }
  if (nextRemote) writeFileSync(remotePath, `${JSON.stringify(nextRemote, null, 2)}\n`);
  if (outputPath) {
    // Outside the checkout, so the commit step's "only remote.json changed" check holds.
    const issuesFile = join(process.env.RUNNER_TEMP ?? resolve('.'), 'moon-sighting-issues.json');
    if (issues.length > 0) writeFileSync(issuesFile, JSON.stringify(issues));
    appendFileSync(
      outputPath,
      `action=${nextRemote ? 'commit' : 'none'}\n` +
        (title ? `commit_title=${title}\n` : '') +
        (issues.length > 0 ? `issues_file=${issuesFile}\n` : ''),
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
