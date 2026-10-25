// Read-only access to the Garmin Connect data API with a DI bearer token.

import {
  activityRow,
  chunks,
  dailyRows,
  dayRow,
  first,
  heartRateZones,
  hrvRows,
  lactateThreshold,
  newestFirst,
  pick,
  localDate,
  recordRows,
  resolveTimeZone,
  sleepRows,
  slim,
  strengthSets,
  timelineBuckets,
  workoutRows,
} from "./shape.js";

export const API_BASE = "https://connectapi.garmin.com";

// Headers of the Garmin Connect Android app. Garmin's API expects them.
export const NATIVE_HEADERS: Record<string, string> = {
  "User-Agent": "GCM-Android-5.23",
  "X-Garmin-User-Agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; Android/33; Dalvik/2.1.0",
  "X-Garmin-Paired-App-Version": "10861",
  "X-Garmin-Client-Platform": "Android",
  "X-App-Ver": "10861",
  "X-Lang": "en",
  "X-GCExperience": "GC5",
  "Accept-Language": "en-US,en;q=0.9",
};

/** What the OAuth grant stores for a connected user (encrypted at rest by the OAuth library). */
export interface GarminAuth {
  access: string;
  refresh: string;
  clientId: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface Props {
  garmin: GarminAuth;
  displayName: string;
  /** HMAC of the Garmin id. Grants made before this field existed get it on their next refresh. */
  userId: string;
  /** The user's IANA time zone from Garmin, so "today" is their local date. Grants made before this field existed get it on their next refresh. */
  timeZone?: string;
}

export type GarminErrorKind = "not_connected" | "rate_limit" | "unreachable" | "http";

/** A failed Garmin call. The message never contains tokens or health data. */
export class GarminError extends Error {
  constructor(
    readonly kind: GarminErrorKind,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

const ACTIVITY_PAGE_SIZE = 20;
const MAX_ACTIVITY_PAGES = 10;
// The sport groups Garmin's search can filter by. Any other sport (golf, tennis, padel...) is matched here
// against each workout's type instead.
const GARMIN_SPORT_GROUPS = new Set(["running", "cycling", "swimming", "hiking", "walking", "fitness_equipment", "multi_sport", "other"]);

const isUnavailable = (v: unknown) => typeof v === "object" && v !== null && "unavailable" in v;

const isEmpty = (v: unknown) =>
  v === null || v === undefined || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v).length === 0);

/** Shape an optional metric: Garmin's "unavailable" note passes through, no data becomes undefined (key left out). */
const optional = (raw: unknown, shape: (raw: unknown) => unknown): unknown => {
  if (isUnavailable(raw)) return raw;
  const out = shape(raw);
  return isEmpty(out) ? undefined : out;
};

/** The object itself, or the first one of a list. */
const firstOf = (v: unknown) => (Array.isArray(v) ? v[0] : v);

const withoutUndefined = (o: Json): Json => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

export class GarminApi {
  constructor(private readonly props: Props) {}

  async get(path: string, params?: Record<string, string | number>): Promise<unknown> {
    const url = new URL(API_BASE + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { ...NATIVE_HEADERS, Authorization: `Bearer ${this.props.garmin.access}`, Accept: "application/json" },
      });
    } catch {
      throw new GarminError("unreachable", "Could not reach Garmin Connect.");
    }
    if (res.status === 429) throw new GarminError("rate_limit", "Garmin is limiting requests.");
    if (res.status === 401 || (res.status === 403 && !res.headers.get("cf-mitigated"))) {
      throw new GarminError("not_connected", "Garmin rejected the login.");
    }
    if (res.status >= 500 || res.status === 403) throw new GarminError("unreachable", `Garmin answered ${res.status}.`);
    if (!res.ok) throw new GarminError("http", `Garmin answered ${res.status}.`);
    if (res.status === 204) return null;
    try {
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Like get(), but a missing metric becomes a note instead of an error. Login and rate-limit problems still throw. */
  async tryGet(path: string, params?: Record<string, string | number>): Promise<unknown> {
    try {
      return await this.get(path, params);
    } catch (e) {
      if (e instanceof GarminError && (e.kind === "http" || e.kind === "unreachable")) return { unavailable: e.message };
      throw e;
    }
  }

  // -- Tools -----------------------------------------------------------------

  async connectionStatus(): Promise<Json> {
    const profile = await this.get("/userprofile-service/socialProfile");
    const [settings, sync, device] = await Promise.all([
      this.tryGet("/userprofile-service/userprofile/user-settings"),
      this.tryGet("/wellness-service/wellness/syncTimestamp"),
      this.tryGet("/device-service/deviceservice/mylastused"),
    ]);
    const userData = (settings as Json | null)?.userData;
    const timeZone = resolveTimeZone(this.props.timeZone);
    const watchName = isUnavailable(device) ? undefined : first(device, "lastUsedDeviceName");
    const uploaded = first(device, "lastUsedDeviceUploadTime");
    return {
      connected: true,
      time_zone: timeZone,
      today: localDate(new Date(), timeZone),
      name: first(profile, "fullName") ?? "",
      units: first(userData, "measurementSystem") ?? settings,
      last_sync: sync,
      ...(typeof watchName === "string" && watchName
        ? {
            watch: {
              name: watchName,
              // Epoch milliseconds.
              ...(typeof uploaded === "number" && Number.isFinite(uploaded) ? { last_upload: new Date(uploaded).toISOString() } : {}),
            },
          }
        : {}),
    };
  }

  async dailyOverview(date: string): Promise<Json> {
    const name = encodeURIComponent(this.props.displayName);
    const [summary, sleep, hrv, readiness] = await Promise.all([
      this.tryGet(`/usersummary-service/usersummary/daily/${name}`, { calendarDate: date }),
      this.tryGet(`/wellness-service/wellness/dailySleepData/${name}`, { date, nonSleepBufferMinutes: 60 }),
      this.tryGet(`/hrv-service/hrv/${date}`),
      this.tryGet(`/metrics-service/metrics/trainingreadiness/${date}`),
    ]);

    const sleepData = (sleep ?? {}) as Json;
    const sleepDto = (sleepData.dailySleepDTO ?? {}) as Json;
    const overall = ((sleepDto.sleepScores as Json | undefined)?.overall ?? {}) as Json;
    const hrvData = (hrv ?? {}) as Json;
    const hrvSum = (hrvData.hrvSummary ?? {}) as Json;
    const ready = Array.isArray(readiness) && readiness.length ? readiness[0] : readiness;
    const mins = (key: string) => Math.floor(((sleepDto[key] as number | undefined) ?? 0) / 60);
    const has = (o: Json) => Object.keys(o).length > 0;
    const row = dayRow(summary);

    return {
      day: has(row) ? row : (summary ?? null),
      last_night_sleep: has(sleepDto)
        ? {
            hours: sleepDto.sleepTimeSeconds ? Math.round(((sleepDto.sleepTimeSeconds as number) / 3600) * 100) / 100 : null,
            score: first(overall, "value") ?? null,
            quality: first(overall, "qualifierKey") ?? null,
            deep_min: mins("deepSleepSeconds"),
            light_min: mins("lightSleepSeconds"),
            rem_min: mins("remSleepSeconds"),
            awake_min: mins("awakeSleepSeconds"),
          }
        : sleepData,
      hrv: has(hrvSum)
        ? {
            ...pick(hrvSum, {
              last_night_avg: ["lastNightAvg"],
              weekly_avg: ["weeklyAvg"],
              status: ["status"],
              feedback: ["feedbackPhrase"],
            }),
            baseline: slim(hrvSum.baseline) ?? null,
          }
        : hrvData,
      training_readiness:
        ready && typeof ready === "object" && !Array.isArray(ready) && !("unavailable" in ready)
          ? pick(ready, {
              score: ["score"],
              level: ["level"],
              feedback: ["feedbackShort", "feedbackLong"],
              recovery_time_min: ["recoveryTime"],
            })
          : (ready ?? null),
    };
  }

  async sleepHistory(start: string, end: string): Promise<Json[]> {
    // Garmin's sleep stats endpoint returns at most 28 days per request.
    const byDate = new Map<string, unknown>();
    for (const [s, e] of chunks(start, end, 28)) {
      const data = (await this.get(`/sleep-service/stats/sleep/daily/${s}/${e}`)) as Json | null;
      const stats = Array.isArray(data?.individualStats) ? data.individualStats : [];
      for (const row of stats) {
        const d = first(row, "calendarDate");
        if (typeof d === "string" && !byDate.has(d)) byDate.set(d, row);
      }
    }
    const sorted = [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, row]) => row);
    return sleepRows(sorted);
  }

  async dailyTrends(start: string, end: string): Promise<Json[]> {
    // One call covers up to 28 days.
    const rows: Json[] = [];
    for (const [s, e] of chunks(start, end, 28)) {
      rows.push(...dailyRows(await this.get("/usersummary-service/v2/dailysummaries", { startDate: s, endDate: e })));
    }
    return rows;
  }

  async hrvHistory(start: string, end: string): Promise<Json[]> {
    const rows: Json[] = [];
    for (const [s, e] of chunks(start, end, 28)) {
      rows.push(...hrvRows(await this.get(`/hrv-service/hrv/daily/${s}/${e}`)));
    }
    return rows;
  }

  async sleepNightDetail(date: string): Promise<unknown> {
    const name = encodeURIComponent(this.props.displayName);
    return slim(await this.get(`/wellness-service/wellness/dailySleepData/${name}`, { date, nonSleepBufferMinutes: 60 }));
  }

  /**
   * Workouts in a range, newest first. Garmin pages by 20; at most MAX_ACTIVITY_PAGES pages (calls) are read.
   * With `limit` it stops once that many are collected and asks for no more than needed. Without `start`
   * (and `end`) no date is sent, so Garmin answers with the most recent ones. A sport outside Garmin's groups
   * is matched against each workout's type, reading full pages; if none match, a note lists the types seen.
   */
  async activities(start: string | undefined, end: string | undefined, activityType?: string, limit?: number): Promise<Json[]> {
    const sport = activityType && !GARMIN_SPORT_GROUPS.has(activityType) ? activityType : undefined;
    const rows: Json[] = [];
    const seen = new Set<unknown>();
    const done = () => (sport && rows.length === 0 && seen.size ? [{ note: `No ${sport} activities here. Types found: ${[...seen].join(", ")}.` }] : rows);
    for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
      const size = sport ? ACTIVITY_PAGE_SIZE : Math.min(ACTIVITY_PAGE_SIZE, (limit ?? Infinity) - rows.length);
      const batch = await this.get("/activitylist-service/activities/search/activities", {
        ...(start ? { startDate: start } : {}),
        ...(end ? { endDate: end } : {}),
        start: page * ACTIVITY_PAGE_SIZE,
        limit: size,
        ...(activityType && !sport ? { activityType } : {}),
      });
      if (!Array.isArray(batch) || batch.length === 0) return done();
      const shaped = batch.map(activityRow);
      for (const r of shaped) seen.add(r.type);
      rows.push(...(sport ? shaped.filter((r) => r.type === sport) : shaped).slice(0, (limit ?? Infinity) - rows.length));
      if (batch.length < size || rows.length >= (limit ?? Infinity)) return done();
    }
    const checked = MAX_ACTIVITY_PAGES * ACTIVITY_PAGE_SIZE;
    rows.push({
      note: sport
        ? `Checked the first ${checked} activities and found ${rows.length} ${sport}; there may be more. Ask for a shorter date range.`
        : `Showing the first ${rows.length} activities; there may be more. Ask for a shorter date range.`,
    });
    return rows;
  }

  async activityDetail(id: string): Promise<Json> {
    const base = `/activity-service/activity/${id}`;
    const [activity, splits, zones, weather, powerZones, sets] = await Promise.all([
      this.tryGet(base),
      this.tryGet(`${base}/splits`),
      this.tryGet(`${base}/hrTimeInZones`),
      this.tryGet(`${base}/weather`),
      this.tryGet(`${base}/powerTimeInZones`),
      this.tryGet(`${base}/exerciseSets`),
    ]);
    const a = (activity ?? {}) as Json;
    const sp = (splits ?? {}) as Json;
    const summary = a.summaryDTO;
    const laps = sp.lapDTOs;
    return {
      name: a.activityName ?? null,
      summary: slim(summary && Object.keys(summary).length ? summary : a),
      laps: slim(Array.isArray(laps) && laps.length ? laps : sp, 40),
      hr_zones: slim(zones),
      weather: slim(weather),
      ...withoutUndefined({
        power_zones: isUnavailable(powerZones) ? undefined : optional(powerZones, slim),
        strength_sets: isUnavailable(sets) ? undefined : optional(sets, strengthSets),
      }),
    };
  }

  async trainingStatus(date: string): Promise<Json> {
    const name = encodeURIComponent(this.props.displayName);
    const [status, readiness, maxMetrics, races, endurance, fitnessAge, lactate, runPower, cyclingFtp, hrZones, hill] = await Promise.all([
      this.tryGet(`/metrics-service/metrics/trainingstatus/aggregated/${date}`),
      this.tryGet(`/metrics-service/metrics/trainingreadiness/${date}`),
      this.tryGet(`/metrics-service/metrics/maxmet/daily/${date}/${date}`),
      this.tryGet(`/metrics-service/metrics/racepredictions/latest/${name}`),
      this.tryGet("/metrics-service/metrics/endurancescore", { calendarDate: date }),
      this.tryGet(`/fitnessage-service/fitnessage/${date}`),
      this.tryGet("/biometric-service/biometric/latestLactateThreshold"),
      this.tryGet(`/biometric-service/biometric/powerToWeight/latest/${date}`, { sport: "Running" }),
      this.tryGet("/biometric-service/biometric/latestFunctionalThresholdPower/CYCLING"),
      this.tryGet("/biometric-service/heartRateZones"),
      this.tryGet("/metrics-service/metrics/hillscore", { calendarDate: date }),
    ]);
    return {
      training_status: slim(status),
      readiness: slim(readiness),
      max_metrics: slim(maxMetrics),
      race_predictions: slim(races),
      endurance_score: slim(endurance),
      fitness_age: slim(fitnessAge),
      // Left out when Garmin has no data; the "unavailable" note is kept, except for the hill score.
      ...withoutUndefined({
        lactate_threshold: optional(lactate, lactateThreshold),
        running_power: optional(runPower, (r) =>
          pick(firstOf(r), { ftp_watts: ["functionalThresholdPower"], watts_per_kg: ["powerToWeight"], date: ["calendarDate"], stale: ["isStale"] }),
        ),
        cycling_ftp: optional(cyclingFtp, (r) =>
          pick(firstOf(r), { watts: ["functionalThresholdPower"], date: ["calendarDate"], stale: ["isStale"], source: ["biometricSourceType"] }),
        ),
        heart_rate_zones: optional(hrZones, heartRateZones),
        // Garmin answers {} for most users.
        hill_score: isUnavailable(hill) ? undefined : optional(hill, slim),
      }),
    };
  }

  /** Weight and body composition for a range, from Garmin's weight service (one call). */
  async bodyComposition(start: string, end: string): Promise<unknown> {
    return slim(newestFirst(await this.get("/weight-service/weight/dateRange", { startDate: start, endDate: end })));
  }

  /** One day of heart rate, stress, Body Battery and steps in 15-minute buckets. */
  async dayTimeline(date: string): Promise<Json> {
    const name = encodeURIComponent(this.props.displayName);
    const [heart, stress, steps] = await Promise.all([
      this.tryGet(`/wellness-service/wellness/dailyHeartRate/${name}`, { date }),
      this.tryGet(`/wellness-service/wellness/dailyStress/${date}`),
      this.tryGet(`/wellness-service/wellness/dailySummaryChart/${name}`, { date }),
    ]);
    const usable = (v: unknown) => (isUnavailable(v) ? undefined : v);
    const missing = Object.entries({ heart_rate: heart, stress_and_body_battery: stress, steps })
      .filter(([, v]) => isUnavailable(v))
      .map(([k]) => k);
    return {
      date,
      ...timelineBuckets(usable(heart), usable(stress), usable(steps), this.props.timeZone),
      ...(missing.length ? { unavailable: missing } : {}),
    };
  }

  async personalRecords(): Promise<Json[]> {
    const name = encodeURIComponent(this.props.displayName);
    return recordRows(await this.get(`/personalrecord-service/personalrecord/prs/${name}`));
  }

  async plannedWorkouts(start: string, end: string): Promise<Json[]> {
    return workoutRows(await this.get("/workout-service/schedule/workoutScheduleByPeriod", { startDate: start, endDate: end }));
  }
}
