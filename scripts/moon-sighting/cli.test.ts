// End to end: the real check.ts as the workflow runs it, with fetch replaced by fixtures
// (test-support/mock-fetch.ts), a temporary remote.json, GITHUB_OUTPUT and RUNNER_TEMP.
// No network, no real key.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect } from './testing.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const CHECK = join(here, 'check.ts');
const MOCK = pathToFileURL(join(here, 'test-support', 'mock-fetch.ts')).href;
const SOURCES = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8')) as { url: string }[];
const GOOGLE_URL = SOURCES.find((s) => s.url.startsWith('https://news.google.com/'))?.url ?? '';
const GOOGLE_FEED = readFileSync(join(here, 'fixtures', 'google-news-2026-11-10.xml'), 'utf8');
const NOTICES = 'https://islamicfoundation.gov.bd/pages/notices';
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

const REMOTE_BEFORE_FIX = {
  schema: 2,
  hijriOffset: { BD: 0 },
  monthStarts: { BD: { '1448-05': '2026-10-13' } },
};
const REMOTE_MAIN = {
  schema: 2,
  hijriOffset: { BD: 0 },
  monthStarts: { BD: { '1448-05': '2026-10-13', '1448-06': '2026-11-12' } },
};
// IFB unreachable from the runner (as on 10 Nov 2026), Google News has the evening's headlines.
const PAGES = {
  [`${NOTICES}?page=1`]: { error: 'ECONNRESET', message: 'read ECONNRESET' },
  [`${NOTICES}?page=2`]: { error: 'ECONNRESET', message: 'read ECONNRESET' },
  'https://islamicfoundation.gov.bd/pages/news': { error: 'ECONNRESET', message: 'read ECONNRESET' },
  [GOOGLE_URL]: { body: GOOGLE_FEED },
};

function runCli(options: {
  remote: object;
  args: string[];
  pages?: object;
  env?: Record<string, string>;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'moon-cli-'));
  const remotePath = join(dir, 'remote.json');
  const remoteText = `${JSON.stringify(options.remote, null, 2)}\n`;
  writeFileSync(remotePath, remoteText);
  const pagesPath = join(dir, 'pages.json');
  writeFileSync(pagesPath, JSON.stringify(options.pages ?? PAGES));
  const outputPath = join(dir, 'github-output');
  writeFileSync(outputPath, '');
  const fetchLog = join(dir, 'fetched.txt');
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    MOCK_FETCH_PAGES: pagesPath,
    MOCK_FETCH_LOG: fetchLog,
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: dir,
    MOON_SIGHTING_TEST_ANCHORS_UNTIL: '1448-05',
    NODE_EXTRA_CA_CERTS: join(here, 'certs', 'sectigo-dv-r36.pem'),
    ...options.env,
  };
  const child = spawnSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import',
      MOCK,
      CHECK,
      '--remote',
      remotePath,
      ...options.args,
    ],
    { env, encoding: 'utf8', timeout: 60_000 },
  );
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    remoteChanged: readFileSync(remotePath, 'utf8') !== remoteText,
    remote: JSON.parse(readFileSync(remotePath, 'utf8')) as object,
    output: readFileSync(outputPath, 'utf8'),
    fetched: existsSync(fetchLog) ? readFileSync(fetchLog, 'utf8').trim().split('\n') : [],
    dir,
  };
}

describe('check.ts end to end (offline)', () => {
  it('the PR test: dry run, now = 2026-11-10T15:30:00Z on main: confirms 1448-06 = 2026-11-12, writes nothing', () => {
    const r = runCli({ remote: REMOTE_MAIN, args: ['--dry-run', '--now', '2026-11-10T15:30:00Z'] });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('DRY RUN: nothing is committed, purged or opened.');
    expect(r.stdout).toContain(
      'IFB notices page 1: error (fetch failed; cause: ECONNRESET: read ECONNRESET)',
    );
    expect(r.stdout).toContain(
      '1448-06 (Jumada al-Akhirah 1448): the sources confirm 2026-11-12 (5 independent news sources), as recorded.',
    );
    expect(r.stdout).toContain('would not change config/remote.json');
    expect(r.stdout).toContain('would open no issue');
    expect(r.remoteChanged).toBe(false);
    expect(r.output).toBe('action=none\n');
  });

  it('dry run before the hand fix: would commit 1448-06 = 2026-11-12, still writes nothing', () => {
    const r = runCli({
      remote: REMOTE_BEFORE_FIX,
      args: ['--dry-run', '--now', '2026-11-10T15:30:00Z'],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(
      'would commit "moon-sighting: 1448-06 (Jumada al-Akhirah) starts 2026-11-12 (5 news sources)"',
    );
    expect(r.stdout).toContain('"1448-06": "2026-11-12"');
    expect(r.stdout).toContain(
      'would open (if new) issue: Moon sighting: Jumada al-Akhirah 1448 (1448-06) starts 2026-11-12 (recorded)',
    );
    expect(r.remoteChanged).toBe(false);
    expect(r.output).toBe('action=none\n');
    expect(existsSync(join(r.dir, 'moon-sighting-issues.json'))).toBe(false);
  });

  it('a real run writes schema 2 with every entry kept and tells the workflow to commit', () => {
    const r = runCli({ remote: REMOTE_BEFORE_FIX, args: ['--now', '2026-11-10T15:30:00Z'] });
    expect(r.status).toBe(0);
    expect(r.remote).toEqual(REMOTE_MAIN);
    expect(r.output).toContain('action=commit\n');
    expect(r.output).toContain(
      'commit_title=moon-sighting: 1448-06 (Jumada al-Akhirah) starts 2026-11-12 (5 news sources)\n',
    );
    const issues = JSON.parse(
      readFileSync(join(r.dir, 'moon-sighting-issues.json'), 'utf8'),
    ) as { title: string; mode: string }[];
    expect(issues.map((i) => i.title)).toEqual([
      'Moon sighting: Jumada al-Akhirah 1448 (1448-06) starts 2026-11-12 (recorded)',
    ]);
  });

  it('a retired Gemini model is an ::error and an issue, not a silent 404', () => {
    const r = runCli({
      remote: REMOTE_MAIN,
      args: ['--dry-run', '--now', '2026-11-20T15:30:00Z'],
      pages: {
        [`${GEMINI}/models?pageSize=1000`]: {
          body: JSON.stringify({
            models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }],
          }),
        },
        [`${GEMINI}/models/gemini-2.5-flash`]: { status: 404, body: '{}' },
      },
      env: { GEMINI_API_KEY: 'dummy', GEMINI_MODEL: 'gemini-2.5-flash' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('::error title=Gemini model gemini-2.5-flash is not usable::HTTP 404');
    expect(r.stdout).toContain(
      'would open (if new) issue: Moon sighting: Gemini model "gemini-2.5-flash" is not usable',
    );
    // Nothing was due on 20 Nov: only the two Gemini checks were fetched.
    expect(r.fetched).toEqual([
      `${GEMINI}/models?pageSize=1000`,
      `${GEMINI}/models/gemini-2.5-flash`,
    ]);
  });

  it('a bad --now fails the run instead of guessing', () => {
    const r = runCli({ remote: REMOTE_MAIN, args: ['--dry-run', '--now', '10/11/2026'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('::error title=Moon sighting check failed::--now must be');
  });
});
