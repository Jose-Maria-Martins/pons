import { afterEach, describe, expect, it, vi } from "vitest";
import { GarminApi, type Props } from "../src/garmin/api.js";
import { connect, json, message, mockFetch, on, rpc } from "./helpers.js";

// All fixtures are invented.
const props: Props = {
  garmin: { access: "fake-access-token", refresh: "fake-refresh", clientId: "FAKE_CLIENT", expiresAt: 4_000_000_000 },
  displayName: "fake-display-name",
  userId: "fake-user-id",
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

  it("with a limit and no start date, sends no dates and makes one request", async () => {
    const { spy } = mockFetch(on(`${API}/activitylist-service/activities/search/activities`, () => json([run(1), run(2), run(3)])));

    const rows = await api().activities(undefined, undefined, "running", 3);

    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ start: "0", limit: "3", activityType: "running" });
  });

  it("with a limit and a date range, stops once it has enough and asks for no more than needed", async () => {
    const { spy } = mockFetch((url) => {
      if (!url.pathname.startsWith("/activitylist-service")) return undefined;
      const start = Number(url.searchParams.get("start"));
      return json(Array.from({ length: Number(url.searchParams.get("limit")) }, (_, i) => run(start + i + 1)));
    });

    const rows = await api().activities("2030-01-01", "2030-12-31", undefined, 45);

    expect(rows).toHaveLength(45);
    expect(rows.every((r) => !("note" in r))).toBe(true);
    const sent = spy.mock.calls.map(([u]) => Object.fromEntries(new URL(String(u)).searchParams));
    expect(sent.map((p) => [p.start, p.limit])).toEqual([["0", "20"], ["20", "20"], ["40", "5"]]);
    expect(sent[0]).toMatchObject({ startDate: "2030-01-01", endDate: "2030-12-31" });
  });

  it("with a limit, stops at a short page", async () => {
    const { spy } = mockFetch(on(`${API}/activitylist-service`, () => json([run(1), run(2)])));
    expect(await api().activities("2030-01-01", "2030-01-31", undefined, 30)).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list when there are no workouts", async () => {
    mockFetch(on(`${API}/activitylist-service`, () => json([])));
    expect(await api().activities("2030-01-01", "2030-01-02")).toEqual([]);
  });
});

describe("activities tool limit", () => {
  it("skips the 30-day default when only a limit is given", async () => {
    const { accessToken } = await connect();
    const { spy } = mockFetch(on(`${API}/activitylist-service`, () => json([{ activityId: 1, activityType: { typeKey: "running" } }])));

    const result = (await message(await rpc(accessToken, "tools/call", { name: "activities", arguments: { limit: 5, activity_type: " Running " } }))).result;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual([{ id: 1, type: "running" }]);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ start: "0", limit: "5", activityType: "running" });
  });

  it("looks back up to a year when the limit comes with only an end date", async () => {
    const { accessToken } = await connect();
    const { spy } = mockFetch(on(`${API}/activitylist-service`, () => json([])));
    await message(await rpc(accessToken, "tools/call", { name: "activities", arguments: { limit: 2, end_date: "2030-03-01" } }));
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({ startDate: "2029-03-01", endDate: "2030-03-01", start: "0", limit: "2" });
  });

  it("keeps the date range when a start date comes with the limit", async () => {
    const { accessToken } = await connect();
    const { spy } = mockFetch(on(`${API}/activitylist-service`, () => json([])));
    await message(await rpc(accessToken, "tools/call", { name: "activities", arguments: { limit: 2, start_date: "2030-02-01", end_date: "2030-03-01" } }));
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ startDate: "2030-02-01", endDate: "2030-03-01", limit: "2" });
  });

  it.each([0, 101, 2.5, "five"])("rejects a limit of %j without calling Garmin", async (limit) => {
    const { accessToken } = await connect();
    const { spy } = mockFetch(() => json([]));
    const result = (await message(await rpc(accessToken, "tools/call", { name: "activities", arguments: { limit } }))).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/limit/);
    expect(spy).not.toHaveBeenCalled();
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
  it("keeps the latest weigh-ins when the list is long and comes oldest first", async () => {
    const day = (i: number) => new Date(Date.UTC(2030, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
    const entries = Array.from({ length: 70 }, (_, i) => ({
      summaryDate: day(i),
      allWeightMetrics: Array.from({ length: 65 }, (_, j) => ({ calendarDate: day(i), samplePk: j, weight: 70000 + j })),
    }));
    mockFetch(on(`${API}/weight-service/weight/dateRange`, () => json({ dailyWeightSummaries: entries, totalAverage: { weight: 70000 } })));

    const out = (await api().bodyComposition("2030-01-01", "2030-03-11")) as {
      dailyWeightSummaries: { summaryDate?: string; allWeightMetrics?: { samplePk: number }[] }[];
    };

    const kept = out.dailyWeightSummaries.filter((s) => s.summaryDate);
    expect(kept).toHaveLength(60);
    expect(kept[0]?.summaryDate).toBe(day(69));
    expect(kept.map((s) => s.summaryDate)).not.toContain(day(0));
    expect(kept.at(-1)?.summaryDate).toBe(day(10));
    // Inside a day, the newest of a long list of measurements are kept too.
    expect(out.dailyWeightSummaries.at(-1)).toMatch(/10 more items omitted/);
  });

  it("leaves a list in its order when the entries carry no date", async () => {
    mockFetch(on(`${API}/weight-service/weight/dateRange`, () => json({ dailyWeightSummaries: [{ weight: 2 }, { weight: 1 }] })));
    expect(await api().bodyComposition("2030-01-01", "2030-01-02")).toEqual({ dailyWeightSummaries: [{ weight: 2 }, { weight: 1 }] });
  });


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

  describe("on a day the clocks change (Europe/London)", () => {
    const london = new GarminApi({ ...props, timeZone: "Europe/London" });
    const at = (iso: string) => Date.parse(iso);
    const serve = (date: string, points: [string, number][]) =>
      mockFetch(
        on(`${API}/wellness-service/wellness/dailyHeartRate/fake-display-name`, () =>
          json({
            startTimestampGMT: `${date}T00:00:00.0`,
            startTimestampLocal: `${date}T00:00:00.0`,
            heartRateValues: points.map(([time, bpm]) => [at(`${date}T${time}:00Z`), bpm]),
          }),
        ),
        on(`${API}/wellness-service/wellness/dailyStress/`, () => json({})),
        on(`${API}/wellness-service/wellness/dailySummaryChart/`, () => json([])),
      );

    it("jumps from 00:45 to 02:00 when the clocks go forward (2030-03-31, 01:00 GMT becomes 02:00 BST)", async () => {
      serve("2030-03-31", [["00:30", 60], ["00:50", 62], ["01:10", 70], ["01:40", 72], ["06:00", 80]]);
      const out = (await london.dayTimeline("2030-03-31")) as { tz_offset_min: number; buckets: { time: string; hr_avg: number }[] };
      expect(out.tz_offset_min).toBe(0);
      expect(out.buckets).toEqual([
        { time: "00:30", hr_avg: 60, hr_max: 60 },
        { time: "00:45", hr_avg: 62, hr_max: 62 },
        { time: "02:00", hr_avg: 70, hr_max: 70 },
        { time: "02:30", hr_avg: 72, hr_max: 72 },
        { time: "07:00", hr_avg: 80, hr_max: 80 },
      ]);
    });

    it("repeats the 01:00 hour, in time order, when the clocks go back (2030-10-27, 02:00 BST becomes 01:00 GMT)", async () => {
      serve("2030-10-27", [["00:10", 55], ["00:50", 58], ["01:10", 61], ["01:40", 63], ["05:00", 70]]);
      const out = (await london.dayTimeline("2030-10-27")) as { buckets: { time: string; hr_avg: number }[] };
      expect(out.buckets.map((b) => [b.time, b.hr_avg])).toEqual([
        ["01:00", 55],
        ["01:45", 58],
        ["01:00", 61],
        ["01:30", 63],
        ["05:00", 70],
      ]);
    });

    it("matches the single-offset result on an ordinary day", async () => {
      serve("2030-03-14", [["07:00", 60], ["07:20", 90]]);
      const out = (await london.dayTimeline("2030-03-14")) as { buckets: { time: string }[] };
      expect(out.buckets.map((b) => b.time)).toEqual(["07:00", "07:15"]);
    });

    it("falls back to the day's offset for a time zone name the runtime does not know", async () => {
      serve("2030-03-31", [["01:10", 70]]);
      const out = (await new GarminApi({ ...props, timeZone: "Not/AZone" }).dayTimeline("2030-03-31")) as { buckets: { time: string }[] };
      expect(out.buckets.map((b) => b.time)).toEqual(["01:00"]);
    });
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

  it("labels the step and streak records, which belong to no sport", async () => {
    mockFetch(
      on(`${API}/personalrecord-service/personalrecord/prs/fake-display-name`, () =>
        json([
          { typeId: 12, value: 40000 },
          { typeId: 13, activityType: null, value: 70000 },
          { typeId: 14, value: 120000 },
          { typeId: 15, value: 9 },
          { typeId: 16, value: 3 },
          { typeId: 17, value: 1 },
        ]),
      ),
    );
    expect(await api().personalRecords()).toEqual([
      { type_id: 12, value: 40000, record: "most steps in a day", unit: "steps" },
      { type_id: 13, value: 70000, record: "most steps in a week", unit: "steps" },
      { type_id: 14, value: 120000, record: "most steps in a month", unit: "steps" },
      { type_id: 15, value: 9, record: "longest step-goal streak", unit: "days" },
      { type_id: 16, value: 3, record: "current step-goal streak", unit: "days" },
      { type_id: 17, value: 1 },
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

  it("asks for a retry first, then a reconnect, when Garmin rejects the login, and to wait when it limits requests", async () => {
    const session = await connect();
    mockFetch(() => json({}, 401));
    const rejected = (await message(await rpc(session.accessToken, "tools/call", { name: "personal_records", arguments: {} }))).result;
    expect(rejected.content[0]!.text).toMatch(/try again in a moment.*If it keeps failing.*reconnect Pons/);

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
