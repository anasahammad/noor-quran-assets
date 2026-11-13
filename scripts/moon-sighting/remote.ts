// config/remote.json: the only file the Action writes. It is always written as schema 2
//   { "schema": 2, "hijriOffset": { "BD": 0 }, "monthStarts": { "BD": { "1448-06": "2026-11-12" } } }
// and an existing entry is never removed or changed: the Action only adds month starts.

import {
  createHijriCalendar,
  type HijriCalendarConfig,
} from '../../app/src/lib/hijri/calendar.ts';
import {
  isValidDateKey,
  isValidMonthKey,
  MAX_REMOTE_HIJRI_OFFSET,
  parseRemoteConfig,
} from '../../app/src/lib/hijri/remoteSchema.ts';
import { tabularToHijri } from '../../app/src/lib/hijri/tabular.ts';

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// Adds monthStarts[country][monthKey]. Refuses to change an existing different value.
export function withMonthStart(remote: Json, country: string, monthKey: string, startDate: string): Json {
  if (!isValidMonthKey(monthKey) || !isValidDateKey(startDate)) {
    throw new Error(`refusing to write: invalid month start ${monthKey} = ${startDate}`);
  }
  const all = isObject(remote.monthStarts) ? remote.monthStarts : {};
  const mine = isObject(all[country]) ? all[country] : {};
  const existing = mine[monthKey];
  if (existing !== undefined && existing !== startDate) {
    throw new Error(
      `refusing to write: monthStarts.${country}["${monthKey}"] is already ${JSON.stringify(existing)}, not changing it to ${startDate}`,
    );
  }
  return { ...remote, monthStarts: { ...all, [country]: { ...mine, [monthKey]: startDate } } };
}

// Schema 1 (or none): hijriOffset was relative to the old tabular calendar. The app converts it
// with offsetFromTabular(offset, today) (src/features/prayer/services/hijri.ts): the offset on
// the visibility calendar under which today shows the date it showed before. Same here, for the
// day of the conversion, so writing schema 2 changes nothing the app shows.
export function offsetFromTabular(
  tabularOffset: number,
  today: number,
  config: HijriCalendarConfig,
  monthStarts: Readonly<Record<string, string>>,
): number {
  const wanted = tabularToHijri(today + tabularOffset);
  const calendar = createHijriCalendar(config, monthStarts);
  const start = calendar.startOf(wanted.year, wanted.month);
  if (start === null) throw new Error(`no calendar start for ${wanted.year}-${wanted.month}`);
  return start + wanted.day - 1 - today;
}

// The JSON to write: schema 2, every existing value kept (other countries, unknown keys,
// even entries the app would ignore), schema 1 offsets converted for `country`.
export function toSchema2(
  remote: Json,
  input: { country: string; config: HijriCalendarConfig; today: number },
): Json {
  const { country } = input;
  const { schema: _schema, hijriOffset: rawOffsets, monthStarts: rawStarts, ...rest } = remote;
  const offsets = isObject(rawOffsets) ? { ...rawOffsets } : {};
  const monthStarts = isObject(rawStarts) ? rawStarts : {};
  const schema = typeof remote.schema === 'number' ? remote.schema : 1;
  if (schema > 2) throw new Error(`refusing to write: remote.json has schema ${schema}`);
  if (schema < 2) {
    for (const key of Object.keys(offsets)) {
      if (key !== country) {
        throw new Error(
          `refusing to convert schema ${schema}: hijriOffset.${key} is relative to the tabular calendar and only ${country} has a calendar here; convert it by hand`,
        );
      }
    }
    const old = offsets[country];
    if (typeof old === 'number' && Number.isInteger(old)) {
      const parsed = parseRemoteConfig(remote, country);
      const converted = offsetFromTabular(old, input.today, input.config, parsed.monthStarts);
      if (Math.abs(converted) > MAX_REMOTE_HIJRI_OFFSET) {
        throw new Error(
          `refusing to convert schema ${schema}: hijriOffset.${country} = ${old} becomes ${converted}, beyond ±${MAX_REMOTE_HIJRI_OFFSET}`,
        );
      }
      offsets[country] = converted;
    }
  }
  if (!(country in offsets)) offsets[country] = 0;
  return { schema: 2, hijriOffset: offsets, monthStarts, ...rest };
}

// Every monthStarts entry (all countries) of `before` is in `after` with the same value.
export function keptMonthStarts(before: Json, after: Json): string[] {
  const lost: string[] = [];
  const b = isObject(before.monthStarts) ? before.monthStarts : {};
  const a = isObject(after.monthStarts) ? after.monthStarts : {};
  for (const [country, entries] of Object.entries(b)) {
    if (!isObject(entries)) {
      if (JSON.stringify(a[country]) !== JSON.stringify(entries)) lost.push(country);
      continue;
    }
    const now = isObject(a[country]) ? a[country] : {};
    for (const [key, value] of Object.entries(entries)) {
      if (JSON.stringify(now[key]) !== JSON.stringify(value)) lost.push(`${country}.${key}`);
    }
  }
  return lost;
}

// The next remote.json: schema 2 with the new month starts added, validated. Throws instead of
// writing anything that would drop or change an existing value.
export function nextRemoteJson(
  remote: Json,
  starts: readonly { monthKey: string; startDate: string }[],
  input: { country: string; config: HijriCalendarConfig; today: number },
): Json {
  let next = toSchema2(remote, input);
  for (const { monthKey, startDate } of starts) {
    next = withMonthStart(next, input.country, monthKey, startDate);
  }
  const lost = keptMonthStarts(remote, next);
  if (lost.length > 0) {
    throw new Error(`refusing to write: monthStarts entries would change or vanish: ${lost.join(', ')}`);
  }
  const parsed = parseRemoteConfig(next, input.country);
  const {
    schema: _s1,
    hijriOffset: _o1,
    monthStarts: _m1,
    ...restBefore
  } = remote;
  const { schema: _s2, hijriOffset: _o2, monthStarts: _m2, ...restAfter } = next;
  if (
    parsed.schema !== 2 ||
    starts.some((s) => parsed.monthStarts[s.monthKey] !== s.startDate) ||
    JSON.stringify(restBefore) !== JSON.stringify(restAfter)
  ) {
    throw new Error('refusing to write: the new remote.json does not validate');
  }
  return next;
}
