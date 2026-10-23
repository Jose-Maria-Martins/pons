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

// Garmin's weight lists, which can come oldest first.
const WEIGHT_LISTS = ["dailyWeightSummaries", "dateWeightList", "allWeightMetrics"];

const whenOf = (x: unknown): number => {
  const v = first(x, "summaryDate", "calendarDate", "date", "timestampGMT");
  return (typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN) || 0;
};

/**
 * Weigh-ins sorted newest first, so that `slim` cutting a long list drops the oldest entries, not the latest.
 * Entries without a date keep their order.
 */
export function newestFirst(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const out: Json = { ...data };
  for (const key of WEIGHT_LISTS) {
    const list = out[key];
    if (Array.isArray(list)) out[key] = list.map(newestFirst).sort((a, b) => whenOf(b) - whenOf(a));
  }
  return out;
}

// -- Dates -----------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The zone if the runtime knows it, otherwise "UTC". */
export function resolveTimeZone(timeZone: string | undefined): string {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** The calendar date (YYYY-MM-DD) it is in `timeZone` at `now`. */
export function localDate(now: Date = new Date(), timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: resolveTimeZone(timeZone), year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Accept YYYY-MM-DD, "today" or "yesterday". Returns YYYY-MM-DD. "Today" is the date in `timeZone` (default UTC). */
export function parseDate(value: string | undefined, now: Date = new Date(), timeZone = "UTC"): string {
  const v = (value ?? "today").trim().toLowerCase();
  const today = Date.parse(`${localDate(now, timeZone)}T00:00:00Z`);
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
  timeZone = "UTC",
): [string, string] {
  let endD = parseDate(end, now, timeZone);
  let startD = start ? parseDate(start, now, timeZone) : toIso(Date.parse(`${endD}T00:00:00Z`) - (defaultDays - 1) * DAY_MS);
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

/** A date moved by whole days. */
export function addDays(date: string, days: number): string {
  return toIso(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
}

/** One workout as a compact row. */
export function activityRow(a: unknown): Json {
  const row = pick(a, {
    id: ["activityId"],
    name: ["activityName"],
    start: ["startTimeLocal"],
    avg_hr: ["averageHR"],
    max_hr: ["maxHR"],
    calories: ["calories"],
    elevation_gain_m: ["elevationGain"],
    aerobic_te: ["aerobicTrainingEffect"],
    anaerobic_te: ["anaerobicTrainingEffect"],
    training_load: ["activityTrainingLoad"],
    avg_power: ["avgPower"],
    avg_cadence: ["averageRunningCadenceInStepsPerMinute", "averageBikingCadenceInRevPerMinute"],
    vo2max: ["vO2MaxValue"],
  });
  if (!isRecord(a)) return row;
  const typeKey = isRecord(a.activityType) ? a.activityType.typeKey : undefined;
  const type = typeof typeKey === "string" && typeKey ? typeKey : "other";
  row.type = type;
  if (typeof a.distance === "number" && a.distance) row.distance_km = round2(a.distance / 1000);
  if (typeof a.duration === "number" && a.duration) row.duration_min = Math.round((a.duration / 60) * 10) / 10;
  const speed = a.averageSpeed;
  if (typeof speed === "number" && speed) {
    if (type.includes("run")) {
      const seconds = Math.round(1000 / speed);
      row.pace_min_per_km = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    } else {
      row.speed_kmh = Math.round(speed * 3.6 * 10) / 10;
    }
  }
  return row;
}

/** Nightly HRV rows from Garmin's HRV range response. */
export function hrvRows(data: unknown): Json[] {
  const summaries = isRecord(data) && Array.isArray(data.hrvSummaries) ? data.hrvSummaries : [];
  return summaries.filter(isRecord).map((r) => ({ ...(slim(r) as Json), date: r.calendarDate ?? null }));
}

/** The rows of a daily summaries response: `{ data: [...] }` or a plain list. */
export function dailyRows(data: unknown): Json[] {
  const days = isRecord(data) ? data.data : data;
  return (Array.isArray(days) ? days : []).map(dayRow).filter((r) => r.date);
}

// -- Day timeline --------------------------------------------------------------

const BUCKET_MS = 15 * 60_000;

interface Bucket {
  hr: number[];
  stress: number[];
  battery?: number;
  steps?: number;
}

/** Garmin writes some timestamps as "2030-03-14T06:00:00.0" with no zone: that is GMT. */
const gmtMs = (s: unknown): number => (typeof s === "string" ? Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`) : NaN);

/** A function giving the zone's UTC offset in milliseconds at an instant. The formatter is built once. */
function offsetInZone(timeZone: string): (ms: number) => number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  return (ms) => {
    const p: Record<string, number> = {};
    for (const { type, value } of format.formatToParts(ms)) p[type] = Number(value);
    return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
  };
}

const pairs = (v: unknown): unknown[][] => (Array.isArray(v) ? v.filter((p): p is unknown[] => Array.isArray(p)) : []);

/**
 * One day of heart rate, stress, Body Battery and steps in 15-minute buckets (local time).
 * `heart`, `stress` and `steps` are the raw responses of Garmin's daily heart rate, stress and
 * summary chart endpoints. Buckets without any data are left out.
 * With a known `timeZone` each bucket's local time follows that zone's rules, so a day that changes between
 * summer and winter time stays right. Without one, the offset Garmin reports at the start of the day is used all day.
 */
export function timelineBuckets(
  heart: unknown,
  stress: unknown,
  steps: unknown,
  timeZone?: string,
): { tz_offset_min: number; buckets: Json[] } {
  // Garmin gives the same instant in GMT and local time; the difference is the UTC offset.
  let offsetMin = 0;
  for (const src of [heart, stress]) {
    const gmt = first(src, "startTimestampGMT");
    const local = first(src, "startTimestampLocal");
    const g = typeof gmt === "number" ? gmt : gmtMs(gmt);
    const l = typeof local === "number" ? local : gmtMs(local);
    if (Number.isFinite(g) && Number.isFinite(l)) {
      offsetMin = Math.round((l - g) / 60_000);
      break;
    }
  }

  // A bucket's key is its slot number. With a zone it counts UTC slots, so the repeated hour of a clock change
  // stays two buckets in time order; the local time is worked out once per bucket, not per point.
  const zone = timeZone && resolveTimeZone(timeZone) === timeZone ? timeZone : undefined;
  const zoneOffsetMs = zone ? offsetInZone(zone) : undefined;
  const slotOf = (ts: number) => Math.floor((zoneOffsetMs ? ts : ts + offsetMin * 60_000) / BUCKET_MS);
  const localMs = (key: number) => key * BUCKET_MS + (zoneOffsetMs ? zoneOffsetMs(key * BUCKET_MS) : 0);

  const buckets = new Map<number, Bucket>();
  const at = (ts: number): Bucket => {
    const key = slotOf(ts);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { hr: [], stress: [] }));
    return b;
  };

  for (const [ts, bpm] of pairs(isRecord(heart) ? heart.heartRateValues : undefined)) {
    if (typeof ts === "number" && typeof bpm === "number" && bpm > 0) at(ts).hr.push(bpm);
  }
  const stressData = isRecord(stress) ? stress : {};
  for (const [ts, level] of pairs(stressData.stressValuesArray)) {
    // Negative values are Garmin's "no data" markers.
    if (typeof ts === "number" && typeof level === "number" && level >= 0) at(ts).stress.push(level);
  }
  for (const [ts, , level] of pairs(stressData.bodyBatteryValuesArray)) {
    if (typeof ts === "number" && typeof level === "number") at(ts).battery = level;
  }
  for (const item of Array.isArray(steps) ? steps : []) {
    const ts = gmtMs(first(item, "startGMT"));
    const n = first(item, "steps");
    if (Number.isFinite(ts) && typeof n === "number" && n > 0) {
      const b = at(ts);
      b.steps = (b.steps ?? 0) + n;
    }
  }

  const mean = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  const rows = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([key, b]) => {
      const row: Json = { time: new Date(localMs(key)).toISOString().slice(11, 16) };
      if (b.hr.length) {
        row.hr_avg = mean(b.hr);
        row.hr_max = Math.max(...b.hr);
      }
      if (b.stress.length) row.stress_avg = mean(b.stress);
      if (b.battery !== undefined) row.body_battery = b.battery;
      if (b.steps !== undefined) row.steps = b.steps;
      return row;
    })
    .filter((row) => Object.keys(row).length > 1);
  return { tz_offset_min: offsetMin, buckets: rows };
}

// -- Personal records and planned workouts ---------------------------------------

// Garmin's record types for running (from the garminconnect library's documentation).
const RUNNING_RECORDS: Record<number, { label: string; unit: "s" | "m" }> = {
  1: { label: "fastest 1 km", unit: "s" },
  2: { label: "fastest 1 mile", unit: "s" },
  3: { label: "fastest 5 km", unit: "s" },
  4: { label: "fastest 10 km", unit: "s" },
  5: { label: "fastest half marathon", unit: "s" },
  6: { label: "fastest marathon", unit: "s" },
  7: { label: "longest run", unit: "m" },
};

/** Personal records as compact rows. Times are in seconds, distances in metres. */
export function recordRows(raw: unknown): Json[] {
  return (Array.isArray(raw) ? raw : []).filter(isRecord).map((r) => {
    const row = pick(r, {
      type_id: ["typeId"],
      sport: ["activityType"],
      value: ["value"],
      date: ["prStartTimeGmtFormatted", "actStartDateTimeInGMT", "startTimeLocal"],
      activity_id: ["activityId"],
      activity_name: ["activityName"],
    });
    const known = typeof r.typeId === "number" ? RUNNING_RECORDS[r.typeId] : undefined;
    if (known && (r.activityType === undefined || r.activityType === "running")) {
      row.record = known.label;
      row.unit = known.unit;
    }
    return row;
  });
}

/** Scheduled workouts as compact rows. Garmin returns a list, or an object holding one. */
export function workoutRows(raw: unknown): Json[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) ? (Object.values(raw).find(Array.isArray) ?? []) : [];
  return list.filter(isRecord).map((w) => {
    const row = pick(w, {
      date: ["calendarDate", "date", "scheduledDate"],
      name: ["workoutName", "title"],
      sport: ["sportTypeKey", "sportType", "sport"],
      workout_id: ["workoutId"],
      plan: ["trainingPlanName"],
      description: ["description"],
    });
    const secs = first(w, "estimatedDurationInSecs", "duration");
    if (typeof secs === "number" && secs) row.duration_min = Math.round((secs / 60) * 10) / 10;
    const meters = first(w, "estimatedDistanceInMeters", "distance");
    if (typeof meters === "number" && meters) row.distance_km = round2(meters / 1000);
    return row;
  });
}

/** A range that looks ahead: from `start` (default today) for `defaultDays` days. */
export function upcomingRange(
  start: string | undefined,
  end: string | undefined,
  defaultDays: number,
  maxDays: number,
  now: Date = new Date(),
  timeZone = "UTC",
): [string, string] {
  let startD = parseDate(start, now, timeZone);
  let endD = end ? parseDate(end, now, timeZone) : addDays(startD, defaultDays - 1);
  if (startD > endD) [startD, endD] = [endD, startD];
  if ((Date.parse(`${endD}T00:00:00Z`) - Date.parse(`${startD}T00:00:00Z`)) / DAY_MS + 1 > maxDays) {
    throw new UserInputError(`Range too long: at most ${maxDays} days per request.`);
  }
  return [startD, endD];
}
