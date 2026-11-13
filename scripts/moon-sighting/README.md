# Moon-sighting check

Keeps `config/remote.json` → `monthStarts.BD` in step with Bangladesh's National Moon Sighting
Committee. Run by `.github/workflows/moon-sighting.yml`. The script lives here; the Hijri calendar
it uses (`src/lib/hijri`, `src/config/countries/bd.ts`) comes from a sparse checkout of the app
repo (`anasahammad/noor-al-quran`, `main`) in `./app`, so the Action and the app always agree.

```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/moon-sighting/check.ts \
  --remote config/remote.json [--sources file] [--now 2026-11-10T20:00:00+06:00] [--dry-run]
```

## What a run does

Scheduled at 20:30, 21:30, 23:30 Dhaka and 09:00 the next morning (GitHub cron is often late).

1. **Gemini model check** (if `GEMINI_API_KEY` is set): the model from the `GEMINI_MODEL`
   repository variable (default `gemini-flash-latest`) must exist (models list). If not: an
   `::error` and an issue listing the models the key can use. Gemini only reads articles the
   Bangla patterns cannot settle; it is optional.
2. **Which months are due** (`run.ts`): the previous, current and next Hijri month. A month is
   due once its sighting evening (the 29th of the month before) has come and it is neither in
   `monthStarts` nor an official anchor in the app. Days with nothing due fetch nothing.
3. **Sources**, for each due month, for up to 5 days after the evening (catch-up):
   - IFB notices page, pages 1-2 (`ifb.ts`): a committee notice for that month, dated the
     evening or the next day, decides on its own (unless its text PDF states another date).
   - News (`sources.json`, `newspapers.ts`): list pages and RSS feeds, including the Google
     News search feed, whose items name their publisher (so a site that blocks the runner still
     counts through it; only headlines are read, article pages of Google News are never
     fetched). A blocked article falls back to the feed summary or the list headline.
4. **Matching** (`bangla.ts`, `bangla-terms.json`, `decision.ts`): every spelling of the month
   names and phrases is in `bangla-terms.json`. A decision only counts if
   - its start is one of the two possible dates (the day after the 29th, or after the 30th),
   - its Hijri month and year (if printed) are the expected ones,
   - it is not another country's sighting,
   - it was published after the meeting (17:00 Dhaka on the evening) and before the run time,
   - and, when the start is only inferred from "দেখা গেছে / দেখা যায়নি" (no date or weekday
     stated), it was published on the evening itself.
   News is confident when **two independent publishers** (registrable domains) agree and none
   disagrees.
5. **Result**:
   - Confident → `monthStarts.BD[month] = start` is committed (also when it equals the
     calculation, so the month is recorded), jsDelivr is purged, and an info issue is opened.
   - Not confident when the evening is over (23:30 or a later run) → one issue per month
     (`… not decided`), commented on by every later run, with every source's status and error.
   - Still missing 5 days after the evening → one `… still missing after 3 days` issue.
6. **remote.json** (`remote.ts`) is always written as schema 2. Existing entries are never
   changed or removed (a different date for a recorded month stops the run); a schema 1 offset
   is converted as the app does (`offsetFromTabular`).

Every failed fetch is logged with its cause (`err.cause` code and message) and classified: a TLS
chain problem (fix: the missing intermediate in `certs/`, passed as `NODE_EXTRA_CA_CERTS`;
verification is never turned off), DNS, or a dropped/refused/timed-out connection, which from the
GitHub runner usually means the site blocks foreign IPs (not fixable here; the news path covers
it). `certs/sectigo-dv-r36.pem` is the intermediate islamicfoundation.gov.bd does not send.

## Manual run (dry run)

Actions → **Moon sighting** → **Run workflow** → branch → `dry_run` ticked (default) → optional
`now` (ISO time with offset, e.g. `2026-11-10T15:30:00Z`). A dry run commits, purges and opens
nothing; it prints what a real run would do. With `now`, articles and notices published after
that time are ignored, and months already in `monthStarts` whose evening is within the
catch-up days are checked against the sources too (a real run skips recorded months).

## Tests (offline)

Fixtures only: no network, no `GEMINI_API_KEY`. `cli.test.ts` runs `check.ts` end to end with
`fetch` replaced by fixtures (`test-support/mock-fetch.ts`). The tests need the app's calendar
code in `./app` (gitignored):

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/anasahammad/noor-al-quran app
git -C app sparse-checkout set src/lib/hijri src/config/countries
npm test
```

The workflow runs the same tests before every check.
