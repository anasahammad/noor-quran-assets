# Moon-sighting check

Run by `.github/workflows/moon-sighting.yml`. The script lives here; the Hijri calendar it uses
(`src/lib/hijri`, `src/config/countries/bd.ts`) is read from a sparse checkout of the app repo
(`anasahammad/noor-al-quran`, `main`) into `./app`, so the Action and the app always agree.

```
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/moon-sighting/check.ts \
  --remote config/remote.json [--sources file] [--now 2026-11-10T20:00:00+06:00] [--dry-run]
```

## Tests (offline)

The tests use fixtures only: no network, no `GEMINI_API_KEY`. They need the app's calendar code
in `./app` (gitignored):

```
git clone --depth 1 --filter=blob:none --sparse https://github.com/anasahammad/noor-al-quran app
git -C app sparse-checkout set src/lib/hijri src/config/countries
npm test
```
