import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminApi, type Props } from "../src/garmin/api.js";
import { connect, json, message, mockFetch, on, rpc } from "./helpers.js";

// All fixtures are invented.
const props: Props = {
  garmin: { access: "fake-access-token", refresh: "fake-refresh", clientId: "FAKE_CLIENT", expiresAt: 4_000_000_000 },
  displayName: "fake-display-name",
};
const API = "https://connectapi.garmin.com";
const api = () => new GarminApi(props);

afterEach(() => vi.restoreAllMocks());

describe("daily_trends", () => {
  it("returns one compact row per day, in 28-day chunks (one call each)", async () => {
    const { spy } = mockFetch((url) => {
      if (url.pathname !== "/usersummary-service/v2/dailysummaries") return undefined;
      const start = url.searchParams.get("startDate");
      return json({ data: [{ calendarDate: start, totalSteps: 5000, totalDistanceMeters: 4000, averageStressLevel: -1, junk: 1 }, { totalSteps: 1 }] });
    });

    const rows = await api().dailyTrends("2030-01-01", "2030-02-10");

    expect(rows).toEqual([
      { date: "2030-01-01", steps: 5000, distance_km: 4 },
      { date: "2030-01-29", steps: 5000, distance_km: 4 },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("accepts a plain list as well as { data }", async () => {
    mockFetch(on(`${API}/usersummary-service/v2/dailysummaries`, () => json([{ calendarDate: "2030-01-01", totalSteps: 7 }])));
    expect(await api().dailyTrends("2030-01-01", "2030-01-01")).toEqual([{ date: "2030-01-01", steps: 7 }]);
  });
});

describe("hrv_history", () => {
  it("adds the date to each slimmed summary", async () => {
    const { calls } = mockFetch(
      on(`${API}/hrv-service/hrv/daily/`, () =>
        json({
          hrvSummaries: [
            { calendarDate: "2030-03-14", weeklyAvg: 58, lastNightAvg: 61.234, status: "BALANCED", baseline: { lowUpper: 48, balancedLow: 52 }, userProfilePK: 1, empty: null },
          ],
        }),
      ),
    );
    const rows = await api().hrvHistory("2030-03-14", "2030-03-14");
    expect(rows).toEqual([
      { calendarDate: "2030-03-14", weeklyAvg: 58, lastNightAvg: 61.23, status: "BALANCED", baseline: { lowUpper: 48, balancedLow: 52 }, date: "2030-03-14" },
    ]);
    expect(calls).toEqual([`${API}/hrv-service/hrv/daily/2030-03-14/2030-03-14`]);
  });
});

describe("sleep_night_detail", () => {
  it("slims the night and drops per-minute series", async () => {
    mockFetch(
      on(`${API}/wellness-service/wellness/dailySleepData/fake-display-name`, () =>
        json({
          dailySleepDTO: { sleepTimeSeconds: 27000, deepSleepSeconds: 5400, avgOvernightHrv: 55.5, ownerId: 99, note: "" },
          sleepHeartRate: Array.from({ length: 40 }, (_, i) => i),
        }),
      ),
    );
    expect(await api().sleepNightDetail("2030-03-14")).toEqual({
      dailySleepDTO: { sleepTimeSeconds: 27000, deepSleepSeconds: 5400, avgOvernightHrv: 55.5 },
      sleepHeartRate: "<time series with 40 points omitted>",
    });
  });
});

describe("activities", () => {
  const run = (id: number, type = "running") => ({
    activityId: id,
    activityName: `Run ${id}`,
    startTimeLocal: "2030-03-14 07:00:00",
    activityType: { typeKey: type },
    distance: 10_000,
    duration: 3000,
    averageSpeed: 10_000 / 3000,
    averageHR: 150.4,
    aerobicTrainingEffect: 3.2,
    ignored: "x",
  });

  it("shapes a run with pace and a ride with speed, and stops at a short page", async () => {
    const { spy } = mockFetch(on(`${API}/activitylist-service/activities/search/activities`, () => json([run(1), { ...run(2, "cycling"), averageSpeed: 8 }])));

    const rows = await api().activities("2030-03-01", "2030-03-31", "running");

    expect(rows[0]).toEqual({
      id: 1,
      name: "Run 1",
      start: "2030-03-14 07:00:00",
      avg_hr: 150.4,
      aerobic_te: 3.2,
      type: "running",
      distance_km: 10,
      duration_min: 50,
      pace_min_per_km: "5:00",
    });
    expect(rows[1]).toMatchObject({ id: 2, type: "cycling", speed_kmh: 28.8 });
    expect(rows[1]).not.toHaveProperty("pace_min_per_km");
    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ startDate: "2030-03-01", endDate: "2030-03-31", start: "0", limit: "20", activityType: "running" });
  });

  it("pages by 20 and caps at 10 calls with a note", async () => {
    const { spy } = mockFetch(
      on(`${API}/activitylist-service/activities/search/activities`, () => json(Array.from({ length: 20 }, (_, i) => run(i + 1)))),
    );
    const rows = await api().activities("2030-01-01", "2030-12-31");
    expect(spy).toHaveBeenCalledTimes(10);
    expect(rows).toHaveLength(201);
    expect(rows[200]).toEqual({ note: expect.stringContaining("first 200 activities") });
  });

  it("returns an empty list when there are no workouts", async () => {
    mockFetch(on(`${API}/activitylist-service`, () => json([])));
    expect(await api().activities("2030-01-01", "2030-01-02")).toEqual([]);
  });
});

describe("activity_detail", () => {
  it("combines summary, laps, zones and weather, and survives a missing part", async () => {
    const { calls } = mockFetch(
      (url) => (url.pathname === "/activity-service/activity/123" ? json({ activityName: "Morning run", summaryDTO: { distance: 5000.456, maxHR: 170, ownerId: 5 } }) : undefined),
      on(`${API}/activity-service/activity/123/splits`, () => json({ lapDTOs: [{ lapIndex: 1, distance: 1000, averageHR: 150 }] })),
      on(`${API}/activity-service/activity/123/hrTimeInZones`, () => json([{ zoneNumber: 1, secsInZone: 120 }])),
      on(`${API}/activity-service/activity/123/weather`, () => json({}, 404)),
    );

    expect(await api().activityDetail("123")).toEqual({
      name: "Morning run",
      summary: { distance: 5000.46, maxHR: 170 },
      laps: [{ lapIndex: 1, distance: 1000, averageHR: 150 }],
      hr_zones: [{ zoneNumber: 1, secsInZone: 120 }],
      weather: { unavailable: "Garmin answered 404." },
    });
    expect(calls).toHaveLength(4);
  });
});

describe("training_status", () => {
  it("makes six calls and slims each part", async () => {
    const { calls } = mockFetch(
      on(`${API}/metrics-service/metrics/trainingstatus/aggregated/2030-03-14`, () => json({ mostRecentTrainingStatus: { status: "PRODUCTIVE" }, empty: [] })),
      on(`${API}/metrics-service/metrics/trainingreadiness/2030-03-14`, () => json([{ score: 70 }])),
      on(`${API}/metrics-service/metrics/maxmet/daily/2030-03-14/2030-03-14`, () => json([{ generic: { vo2MaxPreciseValue: 51.234 } }])),
      on(`${API}/metrics-service/metrics/racepredictions/latest/fake-display-name`, () => json({ time5K: 1500, time10K: 3100 })),
      on(`${API}/metrics-service/metrics/endurancescore`, () => json({ overallScore: 6000 })),
      on(`${API}/fitnessage-service/fitnessage/2030-03-14`, () => json({ fitnessAge: 31.5 })),
    );
    expect(await api().trainingStatus("2030-03-14")).toEqual({
      training_status: { mostRecentTrainingStatus: { status: "PRODUCTIVE" } },
      readiness: [{ score: 70 }],
      max_metrics: [{ generic: { vo2MaxPreciseValue: 51.23 } }],
      race_predictions: { time5K: 1500, time10K: 3100 },
      endurance_score: { overallScore: 6000 },
      fitness_age: { fitnessAge: 31.5 },
    });
    expect(calls).toHaveLength(6);
  });
});

describe("body_composition", () => {
  it("is one call to the weight service, slimmed (weight history lives here)", async () => {
    const { spy } = mockFetch(
      on(`${API}/weight-service/weight/dateRange`, () =>
        json({ dateWeightList: [{ calendarDate: "2030-03-14", weight: 72500.4, bodyFat: 18.2, userProfilePK: 1 }], totalAverage: { weight: 72500 } }),
      ),
    );
    expect(await api().bodyComposition("2030-01-01", "2030-03-14")).toEqual({
      dateWeightList: [{ calendarDate: "2030-03-14", weight: 72500.4, bodyFat: 18.2 }],
      totalAverage: { weight: 72500 },
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("day_timeline", () => {
  // 2030-03-14 in a +01:00 zone: local = GMT + 1 h. GMT 07:00 is local 08:00.
  const t = (hhmm: string) => Date.parse(`2030-03-14T${hhmm}:00Z`);

  it("buckets heart rate, stress, Body Battery and steps into 15 minutes of local time", async () => {
    const { calls } = mockFetch(
      on(`${API}/wellness-service/wellness/dailyHeartRate/fake-display-name`, () =>
        json({
          startTimestampGMT: "2030-03-13T23:00:00.0",
          startTimestampLocal: "2030-03-14T00:00:00.0",
          heartRateValues: [[t("07:00"), 60], [t("07:05"), 70], [t("07:10"), null], [t("07:20"), 90]],
        }),
      ),
      on(`${API}/wellness-service/wellness/dailyStress/2030-03-14`, () =>
        json({
          stressValuesArray: [[t("07:01"), 20], [t("07:06"), 40], [t("07:07"), -2]],
          bodyBatteryValuesArray: [[t("07:00"), "MEASURED", 80, 1.0], [t("07:10"), "MEASURED", 78, 1.0]],
        }),
      ),
      on(`${API}/wellness-service/wellness/dailySummaryChart/fake-display-name`, () =>
        json([{ startGMT: "2030-03-14T07:00:00.0", endGMT: "2030-03-14T07:15:00.0", steps: 120 }, { startGMT: "2030-03-14T07:15:00.0", steps: 0 }]),
      ),
    );

    expect(await api().dayTimeline("2030-03-14")).toEqual({
      date: "2030-03-14",
      tz_offset_min: 60,
      buckets: [
        { time: "08:00", hr_avg: 65, hr_max: 70, stress_avg: 30, body_battery: 78, steps: 120 },
        { time: "08:15", hr_avg: 90, hr_max: 90 },
      ],
    });
    expect(calls).toHaveLength(3);
  });

  it("names the parts Garmin could not give instead of failing", async () => {
    mockFetch(
      on(`${API}/wellness-service/wellness/dailyHeartRate/`, () => json({}, 404)),
      on(`${API}/wellness-service/wellness/dailyStress/`, () => json({ stressValuesArray: [[Date.parse("2030-03-14T10:00:00Z"), 50]] })),
      on(`${API}/wellness-service/wellness/dailySummaryChart/`, () => json({}, 404)),
    );
    expect(await api().dayTimeline("2030-03-14")).toEqual({
      date: "2030-03-14",
      tz_offset_min: 0,
      buckets: [{ time: "10:00", stress_avg: 50 }],
      unavailable: ["heart_rate", "steps"],
    });
  });
});

describe("personal_records", () => {
  it("labels the running records and leaves others as they are", async () => {
    mockFetch(
      on(`${API}/personalrecord-service/personalrecord/prs/fake-display-name`, () =>
        json([
          { typeId: 3, activityType: "running", value: 1450.5, activityId: 11, activityName: "Park race", prStartTimeGmtFormatted: "2030-02-01T08:00:00.0", junk: 1 },
          { typeId: 7, activityType: "running", value: 21097 },
          { typeId: 99, activityType: "cycling", value: 3 },
        ]),
      ),
    );
    expect(await api().personalRecords()).toEqual([
      { type_id: 3, sport: "running", value: 1450.5, date: "2030-02-01T08:00:00.0", activity_id: 11, activity_name: "Park race", record: "fastest 5 km", unit: "s" },
      { type_id: 7, sport: "running", value: 21097, record: "longest run", unit: "m" },
      { type_id: 99, sport: "cycling", value: 3 },
    ]);
  });
});

describe("planned_workouts", () => {
  it("shapes the schedule, whether Garmin sends a list or an object holding one", async () => {
    const item = { calendarDate: "2030-03-15", workoutName: "Easy 8 km", sportTypeKey: "running", workoutId: 5, estimatedDurationInSecs: 2700, estimatedDistanceInMeters: 8000, other: 1 };
    const { spy } = mockFetch(on(`${API}/workout-service/schedule/workoutScheduleByPeriod`, () => json([item])));
    const expected = [{ date: "2030-03-15", name: "Easy 8 km", sport: "running", workout_id: 5, duration_min: 45, distance_km: 8 }];
    expect(await api().plannedWorkouts("2030-03-15", "2030-03-28")).toEqual(expected);
    expect(Object.fromEntries(new URL(String(spy.mock.calls[0]![0])).searchParams)).toEqual({ startDate: "2030-03-15", endDate: "2030-03-28" });

    vi.restoreAllMocks();
    mockFetch(on(`${API}/workout-service/schedule`, () => json({ workoutScheduleSummaries: [item] })));
    expect(await api().plannedWorkouts("2030-03-15", "2030-03-28")).toEqual(expected);
  });
});

describe("the tools over MCP", () => {
  const call = async (name: string, args: object = {}) => {
    const { accessToken } = await connect();
    return (await message(await rpc(accessToken, "tools/call", { name, arguments: args }))).result;
  };

  it("runs a range tool with its default window", async () => {
    const session = await connect();
    const { spy } = mockFetch(on(`${API}/usersummary-service/v2/dailysummaries`, () => json({ data: [{ calendarDate: "2030-03-14", totalSteps: 10 }] })));
    const res = await rpc(session.accessToken, "tools/call", { name: "daily_trends", arguments: {} });
    const result = (await message(res)).result;
    // 30 days need two 28-day calls; the fake answers both alike.
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ date: "2030-03-14", steps: 10 }, { date: "2030-03-14", steps: 10 }]);
    expect(spy.mock.calls.length).toBe(2);
  });

  it("refuses ranges that are too long without calling Garmin", async () => {
    const session = await connect();
    const { calls } = mockFetch();
    for (const [name, args] of [
      ["daily_trends", { start_date: "2020-01-01", end_date: "2030-01-01" }],
      ["hrv_history", { start_date: "2029-01-01", end_date: "2030-01-01" }],
      ["planned_workouts", { start_date: "2030-01-01", end_date: "2030-12-31" }],
    ] as const) {
      const result = (await message(await rpc(session.accessToken, "tools/call", { name, arguments: args }))).result;
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/Range too long/);
    }
    expect(calls).toEqual([]);
  });

  it("refuses an activity id that is not a number", async () => {
    const result = await call("activity_detail", { activity_id: "../../secrets" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/activity_id must be a number/);
  });

  it("refuses a bad date", async () => {
    const result = await call("day_timeline", { date: "14/03/2030" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/Invalid input/);
  });

  it("tells the user to reconnect when Garmin rejects the login, and to wait when it limits requests", async () => {
    const session = await connect();
    mockFetch(() => json({}, 401));
    const rejected = (await message(await rpc(session.accessToken, "tools/call", { name: "personal_records", arguments: {} }))).result;
    expect(rejected.content[0]!.text).toMatch(/reconnect Pons/);

    vi.restoreAllMocks();
    mockFetch(() => json({}, 429));
    const limited = (await message(await rpc(session.accessToken, "tools/call", { name: "body_composition", arguments: {} }))).result;
    expect(limited.isError).toBe(true);
    expect(limited.content[0]!.text).toMatch(/limiting requests/);
  });

  it("stays under 50 Garmin calls at every tool's maximum range", async () => {
    const session = await connect();
    const { spy } = mockFetch(
      on(`${API}/activitylist-service`, () => json(Array.from({ length: 20 }, (_, i) => ({ activityId: i })))),
      () => json({}),
    );
    const widest: [string, object][] = [
      ["daily_trends", { start_date: "2029-03-01", end_date: "2030-03-01" }],
      ["sleep_history", { start_date: "2029-03-01", end_date: "2030-03-01" }],
      ["hrv_history", { start_date: "2029-09-05", end_date: "2030-03-01" }],
      ["activities", { start_date: "2029-03-01", end_date: "2030-03-01" }],
      ["body_composition", { start_date: "2029-03-01", end_date: "2030-03-01" }],
      ["planned_workouts", { start_date: "2030-03-01", end_date: "2030-05-29" }],
      ["activity_detail", { activity_id: "1" }],
      ["training_status", {}],
      ["day_timeline", {}],
      ["daily_overview", {}],
    ];
    for (const [name, args] of widest) {
      spy.mockClear();
      const result = (await message(await rpc(session.accessToken, "tools/call", { name, arguments: args }))).result;
      expect(result.isError, `${name}: ${result.content[0]?.text}`).toBeFalsy();
      expect(spy.mock.calls.length, name).toBeLessThan(50);
    }
  });
});
