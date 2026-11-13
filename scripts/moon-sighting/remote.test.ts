import { describe, it } from 'node:test';

import { bd } from '../../app/src/config/countries/bd.ts';
import { createHijriCalendar, dayOfKey } from '../../app/src/lib/hijri/calendar.ts';
import { parseRemoteConfig } from '../../app/src/lib/hijri/remoteSchema.ts';
import { tabularToHijri } from '../../app/src/lib/hijri/tabular.ts';
import { keptMonthStarts, nextRemoteJson, toSchema2, withMonthStart } from './remote.ts';
import { expect } from './testing.ts';

const CONFIG = {
  ...bd.hijri,
  anchors: Object.fromEntries(
    Object.entries(bd.hijri.anchors).filter(([key]) => key <= '1448-05'),
  ),
};
const TODAY = dayOfKey('2026-11-13');
const input = { country: 'BD', config: CONFIG, today: TODAY };
const NEW = [{ monthKey: '1448-07', startDate: '2026-12-11' }];

// What the app shows for `day` under a remote config (schema 1: the tabular calendar plus the
// offset; schema 2: the visibility calendar with monthStarts plus the offset).
function shown(remote: Record<string, unknown>, day: number) {
  const parsed = parseRemoteConfig(remote, 'BD');
  const offset = parsed.hijriOffset ?? 0;
  if (parsed.schema < 2) return tabularToHijri(day + offset);
  return createHijriCalendar(CONFIG, parsed.monthStarts).toHijri(day + offset);
}

describe('remote.json schema 1 → 2', () => {
  for (const offset of [-1, 0, 1]) {
    it(`hijriOffset.BD = ${offset} (tabular) keeps the date the app shows today`, () => {
      const before = { schema: 1, hijriOffset: { BD: offset } };
      const after = toSchema2(before, input);
      expect(after.schema).toBe(2);
      expect(Object.keys(after)).toEqual(['schema', 'hijriOffset', 'monthStarts']);
      expect(shown(after, TODAY)).toEqual(shown(before, TODAY));
    });
  }

  it('no "schema" key is schema 1; no offset becomes 0', () => {
    expect(toSchema2({}, input)).toEqual({ schema: 2, hijriOffset: { BD: 0 }, monthStarts: {} });
  });

  it('refuses a schema 1 offset for a country it has no calendar for', () => {
    expect(() => toSchema2({ schema: 1, hijriOffset: { BD: 0, PK: 1 } }, input)).toThrow(
      /hijriOffset\.PK/,
    );
  });

  it('refuses a conversion beyond ±3 days (the app would drop it)', () => {
    expect(() => toSchema2({ schema: 1, hijriOffset: { BD: 3 } }, { ...input, today: TODAY })).not.toThrow();
    const far = { schema: 1, hijriOffset: { BD: 3 } };
    // Find a day on which tabular+3 is more than 3 days off the visibility calendar, if any.
    let threw = false;
    for (let d = TODAY; d < TODAY + 400 && !threw; d++) {
      try {
        toSchema2(far, { ...input, today: d });
      } catch (error) {
        threw = /beyond ±3/.test((error as Error).message);
      }
    }
    expect(threw).toBe(true);
  });

  it('refuses a newer schema', () => {
    expect(() => toSchema2({ schema: 3 }, input)).toThrow(/schema 3/);
  });
});

describe('monthStarts are never removed or changed', () => {
  const MAIN = {
    schema: 2,
    hijriOffset: { BD: 0 },
    monthStarts: { BD: { '1448-05': '2026-10-13', '1448-06': '2026-11-12' } },
  };

  it('keeps the hand-fixed 1448-05 and 1448-06 and adds the new month', () => {
    expect(nextRemoteJson(MAIN, NEW, input)).toEqual({
      schema: 2,
      hijriOffset: { BD: 0 },
      monthStarts: {
        BD: { '1448-05': '2026-10-13', '1448-06': '2026-11-12', '1448-07': '2026-12-11' },
      },
    });
  });

  it('keeps other countries, entries the app would ignore, and unknown keys', () => {
    const odd = {
      schema: 2,
      hijriOffset: { BD: 1, PK: -1 },
      monthStarts: { BD: { '1448-05': '2026-10-13', junk: 'x' }, PK: { '1448-05': '2026-10-12' } },
      note: 'hand edit',
    };
    const next = nextRemoteJson(odd, NEW, input);
    expect(next).toEqual({
      schema: 2,
      hijriOffset: { BD: 1, PK: -1 },
      monthStarts: {
        BD: { '1448-05': '2026-10-13', junk: 'x', '1448-07': '2026-12-11' },
        PK: { '1448-05': '2026-10-12' },
      },
      note: 'hand edit',
    });
    expect(keptMonthStarts(odd, next)).toEqual([]);
  });

  it('a schema 1 file with month starts: converted, entries kept', () => {
    const old = { schema: 1, hijriOffset: { BD: 0 }, monthStarts: { BD: { '1448-05': '2026-10-13' } } };
    const next = nextRemoteJson(old, NEW, input);
    expect(next.schema).toBe(2);
    expect(next.monthStarts).toEqual({ BD: { '1448-05': '2026-10-13', '1448-07': '2026-12-11' } });
  });

  it('refuses to overwrite an existing month start with another date', () => {
    expect(() =>
      nextRemoteJson(MAIN, [{ monthKey: '1448-06', startDate: '2026-11-11' }], input),
    ).toThrow(/already "2026-11-12"/);
    // The same value again is fine (nothing changes).
    expect(nextRemoteJson(MAIN, [{ monthKey: '1448-06', startDate: '2026-11-12' }], input)).toEqual(
      MAIN,
    );
  });

  it('refuses invalid keys or dates', () => {
    expect(() => withMonthStart(MAIN, 'BD', '1448-13', '2026-12-11')).toThrow(/invalid/);
    expect(() => withMonthStart(MAIN, 'BD', '1448-07', '2026-02-30')).toThrow(/invalid/);
  });

  it('detects a lost or changed entry', () => {
    expect(
      keptMonthStarts(MAIN, { monthStarts: { BD: { '1448-05': '2026-10-13' } } }),
    ).toEqual(['BD.1448-06']);
    expect(keptMonthStarts(MAIN, { monthStarts: {} })).toEqual(['BD.1448-05', 'BD.1448-06']);
  });
});
