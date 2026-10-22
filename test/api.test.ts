import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminApi, GarminError, type Props } from "../src/garmin/api.js";
import { describeError, runTool } from "../src/mcp/server.js";
import { UserInputError } from "../src/garmin/shape.js";
import { json, mockFetch, on } from "./helpers.js";

const props: Props = {
  garmin: { access: "fake-access-token", refresh: "fake-refresh", clientId: "FAKE_CLIENT", expiresAt: 4_000_000_000 },
  displayName: "fake-display-name",
};
const API = "https://connectapi.garmin.com";

afterEach(() => vi.restoreAllMocks());

describe("daily_overview", () => {
  it("shapes the day, sleep, hrv and readiness", async () => {
    const { spy } = mockFetch(
      on(`${API}/usersummary-service/usersummary/daily/fake-display-name`, () =>
        json({ calendarDate: "2030-03-14", totalSteps: 9000, totalDistanceMeters: 7000, restingHeartRate: 52, averageStressLevel: 31 }),
      ),
      on(`${API}/wellness-service/wellness/dailySleepData/`, () =>
        json({
          dailySleepDTO: {
            sleepTimeSeconds: 27900,
            sleepScores: { overall: { value: 84, qualifierKey: "GOOD" } },
            deepSleepSeconds: 5400,
            lightSleepSeconds: 15000,
            remSleepSeconds: 5000,
            awakeSleepSeconds: 600,
          },
        }),
      ),
      on(`${API}/hrv-service/hrv/2030-03-14`, () =>
        json({ hrvSummary: { lastNightAvg: 61, weeklyAvg: 58, status: "BALANCED", feedbackPhrase: "HRV_BALANCED_2", baseline: { low: 48.123, high: 70 } } }),
      ),
      on(`${API}/metrics-service/metrics/trainingreadiness/2030-03-14`, () =>
        json([{ score: 72, level: "HIGH", feedbackShort: "WELL_RESTED", recoveryTime: 0, ignored: 1 }]),
      ),
    );

    const out = await new GarminApi(props).dailyOverview("2030-03-14");

    expect(out).toEqual({
      day: { date: "2030-03-14", steps: 9000, distance_km: 7, resting_hr: 52, stress_avg: 31 },
      last_night_sleep: { hours: 7.75, score: 84, quality: "GOOD", deep_min: 90, light_min: 250, rem_min: 83, awake_min: 10 },
      hrv: { last_night_avg: 61, weekly_avg: 58, status: "BALANCED", feedback: "HRV_BALANCED_2", baseline: { low: 48.12, high: 70 } },
      training_readiness: { score: 72, level: "HIGH", feedback: "WELL_RESTED", recovery_time_min: 0 },
    });
    // Every call carries the bearer token and the date.
    const first = spy.mock.calls[0]!;
    expect((first[1]?.headers as Record<string, string>).Authorization).toBe("Bearer fake-access-token");
  });

  it("reports a missing metric as unavailable instead of failing", async () => {
    mockFetch(
      on(`${API}/usersummary-service`, () => json({ totalSteps: 1, calendarDate: "2030-03-14" })),
      on(`${API}/wellness-service`, () => json({}, 404)),
      on(`${API}/hrv-service`, () => json({}, 404)),
      on(`${API}/metrics-service`, () => json({}, 404)),
    );
    const out = await new GarminApi(props).dailyOverview("2030-03-14");
    expect(out.day).toEqual({ date: "2030-03-14", steps: 1 });
    expect(out.last_night_sleep).toEqual({ unavailable: "Garmin answered 404." });
    expect(out.training_readiness).toEqual({ unavailable: "Garmin answered 404." });
  });
});

describe("sleep_history", () => {
  it("fetches in 28-day chunks and returns one row per night, sorted", async () => {
    const { calls } = mockFetch((url) => {
      if (!url.pathname.startsWith("/sleep-service/stats/sleep/daily/")) return undefined;
      const [, , , , , start] = url.pathname.split("/");
      return json({
        individualStats: [
          { calendarDate: start, values: { totalSleepTimeInSeconds: 28800, sleepScore: 90 } },
          { calendarDate: "2030-01-28", values: { totalSleepTimeInSeconds: 21600 } },
        ],
      });
    });

    const rows = await new GarminApi(props).sleepHistory("2030-01-01", "2030-02-10");

    expect(calls).toEqual([`${API}/sleep-service/stats/sleep/daily/2030-01-01/2030-01-28`, `${API}/sleep-service/stats/sleep/daily/2030-01-29/2030-02-10`]);
    expect(rows.map((r) => r.date)).toEqual(["2030-01-01", "2030-01-28", "2030-01-29"]);
    expect(rows[0]).toMatchObject({ date: "2030-01-01", hours: 8, score: 90 });
  });
});

describe("connection_status", () => {
  it("returns name, units and last sync", async () => {
    mockFetch(
      on(`${API}/userprofile-service/socialProfile`, () => json({ fullName: "Test Person", displayName: "fake-display-name" })),
      on(`${API}/userprofile-service/userprofile/user-settings`, () => json({ userData: { measurementSystem: "metric" } })),
      on(`${API}/wellness-service/wellness/syncTimestamp`, () => json("2030-03-14T07:00:00.0")),
    );
    expect(await new GarminApi(props).connectionStatus()).toEqual({
      connected: true,
      name: "Test Person",
      units: "metric",
      last_sync: "2030-03-14T07:00:00.0",
    });
  });
});

describe("errors", () => {
  it("maps Garmin failures to GarminError kinds", async () => {
    const kind = async (status: number) => {
      mockFetch(() => json({}, status));
      try {
        await new GarminApi(props).get("/x");
      } catch (e) {
        return (e as GarminError).kind;
      }
    };
    expect(await kind(401)).toBe("not_connected");
    expect(await kind(429)).toBe("rate_limit");
    expect(await kind(503)).toBe("unreachable");
    expect(await kind(404)).toBe("http");
  });

  it("returns plain isError results, never raw exceptions", async () => {
    for (const [error, text] of [
      [new GarminError("not_connected", "x"), /reconnect Pons/],
      [new GarminError("rate_limit", "x"), /limiting requests/],
      [new GarminError("unreachable", "x"), /Could not reach Garmin/],
      [new UserInputError("bad date"), /Invalid input: bad date/],
      [new Error("secret internal detail"), /Something went wrong/],
    ] as const) {
      const result = await runTool(() => Promise.reject(error));
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(text) });
      expect(describeError(error)).not.toContain("secret internal detail");
    }
  });

  it("returns the data as JSON text on success", async () => {
    const result = await runTool(async () => ({ ok: 1 }));
    expect(result).toEqual({ content: [{ type: "text", text: '{"ok":1}' }] });
  });
});
