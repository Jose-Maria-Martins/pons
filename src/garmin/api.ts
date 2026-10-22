// Read-only access to the Garmin Connect data API with a DI bearer token.

import { chunks, dayRow, first, pick, sleepRows, slim } from "./shape.js";

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

  // -- The three tools -------------------------------------------------------

  async connectionStatus(): Promise<Json> {
    const profile = await this.get("/userprofile-service/socialProfile");
    const [settings, sync] = await Promise.all([
      this.tryGet("/userprofile-service/userprofile/user-settings"),
      this.tryGet("/wellness-service/wellness/syncTimestamp"),
    ]);
    const userData = (settings as Json | null)?.userData;
    return {
      connected: true,
      name: first(profile, "fullName") ?? "",
      units: first(userData, "measurementSystem") ?? settings,
      last_sync: sync,
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
}
