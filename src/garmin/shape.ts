// Helpers that turn Garmin's big, inconsistent responses into small, stable rows.
// Ported from the Python claudeGarmin project (garmin.py and data.py).

/** Bad input from the user (for example a malformed date). Shown to Claude as plain text. */
export class UserInputError extends Error {}

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

// Identifiers and image links add noise and nothing useful for analysis.
const DROP_KEY =
  /(ProfilePK|ProfileId|userProfile|ownerId|ownerDisplayName|ownerFullName|ImageUrl|imageUrl|uuid|UUID|deviceId|unitId)$/;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Drop nulls, IDs and long time series so a response fits in a chat. */
export function slim(obj: unknown, maxItems = 60): unknown {
  if (isRecord(obj)) {
    const out: Json = {};
    for (const [k, raw] of Object.entries(obj)) {
      if (DROP_KEY.test(k)) continue;
      const v = slim(raw, maxItems);
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (isRecord(v) && Object.keys(v).length === 0) continue;
      out[k] = v;
    }
    return out;
  }
  if (Array.isArray(obj)) {
    if (obj.length > 20 && !obj.slice(0, 5).some(isRecord)) {
      return `<time series with ${obj.length} points omitted>`;
    }
    const items = obj.slice(0, maxItems).map((x) => slim(x, maxItems));
    if (obj.length > maxItems) items.push(`<${obj.length - maxItems} more items omitted>`);
    return items;
  }
  if (typeof obj === "number" && !Number.isInteger(obj)) return round2(obj);
  return obj;
}

/** The first present, non-null value among the keys. */
export function first(d: unknown, ...keys: string[]): unknown {
  if (!isRecord(d)) return undefined;
  for (const k of keys) {
    if (d[k] !== undefined && d[k] !== null) return d[k];
  }
  return undefined;
}

/** Build a compact object: output name -> first matching Garmin field. */
export function pick(d: unknown, mapping: Record<string, readonly string[]>): Json {
  const out: Json = {};
  for (const [name, keys] of Object.entries(mapping)) {
    const v = first(d, ...keys);
    if (v !== undefined) out[name] = typeof v === "number" && !Number.isInteger(v) ? round2(v) : v;
  }
  return out;
}

// -- Dates -----------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Accept YYYY-MM-DD, "today" or "yesterday". Returns YYYY-MM-DD. "Today" is the UTC date. */
export function parseDate(value: string | undefined, now: Date = new Date()): string {
  const v = (value ?? "today").trim().toLowerCase();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (v === "today") return toIso(today);
  if (v === "yesterday") return toIso(today - DAY_MS);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!ISO_DATE.test(v) || Number.isNaN(ms) || toIso(ms) !== v) {
    throw new UserInputError(`"${value}" is not a date. Use YYYY-MM-DD, "today" or "yesterday".`);
  }
  return v;
}

export function dateRange(
  start: string | undefined,
  end: string | undefined,
  defaultDays: number,
  maxDays: number,
  now: Date = new Date(),
): [string, string] {
  let endD = parseDate(end, now);
  let startD = start ? parseDate(start, now) : toIso(Date.parse(`${endD}T00:00:00Z`) - (defaultDays - 1) * DAY_MS);
  if (startD > endD) [startD, endD] = [endD, startD];
  const days = (Date.parse(`${endD}T00:00:00Z`) - Date.parse(`${startD}T00:00:00Z`)) / DAY_MS + 1;
  if (days > maxDays) throw new UserInputError(`Range too long: at most ${maxDays} days per request.`);
  return [startD, endD];
}

/** Split a date range for endpoints that limit how many days they return. */
export function chunks(start: string, end: string, size: number): [string, string][] {
  const out: [string, string][] = [];
  let s = Date.parse(`${start}T00:00:00Z`);
  const e = Date.parse(`${end}T00:00:00Z`);
  while (s <= e) {
    const c = Math.min(s + (size - 1) * DAY_MS, e);
    out.push([toIso(s), toIso(c)]);
    s = c + DAY_MS;
  }
  return out;
}

// -- Rows --------------------------------------------------------------------

const DAY_FIELDS: Record<string, readonly string[]> = {
  date: ["calendarDate"],
  steps: ["totalSteps"],
  distance_km: ["totalDistanceMeters"],
  calories_total: ["totalKilocalories"],
  calories_active: ["activeKilocalories"],
  resting_hr: ["restingHeartRate"],
  min_hr: ["minHeartRate"],
  max_hr: ["maxHeartRate"],
  stress_avg: ["averageStressLevel"],
  stress_max: ["maxStressLevel"],
  body_battery_high: ["bodyBatteryHighestValue"],
  body_battery_low: ["bodyBatteryLowestValue"],
  body_battery_charged: ["bodyBatteryChargedValue"],
  body_battery_drained: ["bodyBatteryDrainedValue"],
  intensity_min_moderate: ["moderateIntensityMinutes"],
  intensity_min_vigorous: ["vigorousIntensityMinutes"],
  floors: ["floorsAscended"],
  sleep_seconds: ["sleepingSeconds"],
  spo2_avg: ["averageSpo2", "averageSpO2Value"],
  respiration_avg: ["avgWakingRespirationValue"],
};

/** One day's summary as a compact row. Returns {} when the input has no known fields. */
export function dayRow(raw: unknown): Json {
  if (!isRecord(raw)) return {};
  const row = pick(raw, DAY_FIELDS);
  // Garmin uses -1/-2 as "no data" markers for stress.
  for (const k of ["stress_avg", "stress_max"]) {
    const v = row[k];
    if (typeof v === "number" && v < 0) delete row[k];
  }
  if (typeof row.distance_km === "number") row.distance_km = round2(row.distance_km / 1000);
  return row;
}

/** One row per night from Garmin's sleep stats (`individualStats` entries). */
export function sleepRows(stats: unknown): Json[] {
  if (!Array.isArray(stats)) return [];
  return stats.filter(isRecord).map((r) => {
    const values = isRecord(r.values) ? r.values : {};
    const row: Json = { date: r.calendarDate ?? null, ...(slim(values) as Json) };
    const secs = first(values, "totalSleepTimeInSeconds", "sleepTimeInSeconds", "sleepTimeSeconds");
    if (typeof secs === "number" && secs) row.hours = round2(secs / 3600);
    const score = first(values, "sleepScore", "overallSleepScore", "sleepScoreValue");
    if (score !== undefined) row.score = score;
    return row;
  });
}
