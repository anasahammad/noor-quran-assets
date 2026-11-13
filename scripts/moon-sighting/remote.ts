// config/remote.json: the only file the Action writes.

// The JSON to commit: only monthStarts[country][monthKey] changes.
export function withMonthStart(
  remote: Record<string, unknown>,
  country: string,
  monthKey: string,
  startDate: string,
): Record<string, unknown> {
  const all =
    typeof remote.monthStarts === 'object' && remote.monthStarts !== null
      ? (remote.monthStarts as Record<string, Record<string, string>>)
      : {};
  return {
    ...remote,
    monthStarts: { ...all, [country]: { ...(all[country] ?? {}), [monthKey]: startDate } },
  };
}
