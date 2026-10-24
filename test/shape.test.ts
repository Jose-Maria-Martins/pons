import { describe, expect, it } from "vitest";
import {
  addDays,
  chunks,
  dateRange,
  dayRow,
  first,
  heartRateZones,
  lactateThreshold,
  localDate,
  parseDate,
  pick,
  resolveTimeZone,
  sleepRows,
  slim,
  strengthSets,
  upcomingRange,
  UserInputError,
} from "../src/garmin/shape.js";

const NOW = new Date("2030-03-15T10:00:00Z");

describe("first and pick", () => {
  it("first skips missing and null values but keeps 0", () => {
    expect(first({ a: null, b: 0, c: 5 }, "a", "b", "c")).toBe(0);
    expect(first({ a: 1 }, "x")).toBeUndefined();
    expect(first("not an object", "a")).toBeUndefined();
  });

  it("pick maps output names to the first matching field and rounds floats", () => {
    expect(pick({ alt: 1.23456, other: 7 }, { v: ["main", "alt"], o: ["other"], none: ["zzz"] })).toEqual({ v: 1.23, o: 7 });
  });
});

describe("slim", () => {
  it("drops nulls, empties and id-like keys", () => {
    const out = slim({ keep: 1, gone: null, empty: [], emptyObj: {}, blank: "", userProfilePK: 9, deviceId: 3, nested: { ownerId: 1, ok: true } });
    expect(out).toEqual({ keep: 1, nested: { ok: true } });
  });

  it("replaces long number series with a note", () => {
    const out = slim({ hr: Array.from({ length: 50 }, (_, i) => i) }) as { hr: string };
    expect(out.hr).toBe("<time series with 50 points omitted>");
  });

  it("truncates long lists of objects and rounds floats", () => {
    const rows = Array.from({ length: 65 }, (_, i) => ({ i, f: 1.23456 }));
    const out = slim(rows, 60) as unknown[];
    expect(out).toHaveLength(61);
    expect(out[0]).toEqual({ i: 0, f: 1.23 });
    expect(out[60]).toBe("<5 more items omitted>");
  });
});

describe("dates", () => {
  it("parses today, yesterday and ISO dates", () => {
    expect(parseDate(undefined, NOW)).toBe("2030-03-15");
    expect(parseDate("Yesterday", NOW)).toBe("2030-03-14");
    expect(parseDate("2030-02-28", NOW)).toBe("2030-02-28");
  });

  it("uses the date in the user's time zone for today and yesterday", () => {
    // Sydney is UTC+11 in March: 21:00 UTC is already 08:00 the next day there.
    const sydney = new Date("2030-03-15T21:00:00Z");
    expect(parseDate("today", sydney, "Australia/Sydney")).toBe("2030-03-16");
    expect(parseDate("yesterday", sydney, "Australia/Sydney")).toBe("2030-03-15");
    expect(parseDate("today", sydney)).toBe("2030-03-15");
    // Los Angeles is UTC-7 in March: 03:00 UTC is still 20:00 the day before there.
    const la = new Date("2030-03-15T03:00:00Z");
    expect(parseDate("today", la, "America/Los_Angeles")).toBe("2030-03-14");
    expect(parseDate("yesterday", la, "America/Los_Angeles")).toBe("2030-03-13");
    expect(parseDate("2030-03-01", la, "America/Los_Angeles")).toBe("2030-03-01");
  });

  it("falls back to UTC for a time zone it does not know", () => {
    const now = new Date("2030-03-15T21:00:00Z");
    expect(parseDate("today", now, "Not/AZone")).toBe("2030-03-15");
    expect(parseDate("today", now, "")).toBe("2030-03-15");
    expect(resolveTimeZone("Not/AZone")).toBe("UTC");
    expect(resolveTimeZone("Europe/London")).toBe("Europe/London");
    expect(localDate(now, "Not/AZone")).toBe("2030-03-15");
  });

  it("rejects things that are not real dates", () => {
    for (const bad of ["2030-02-30", "15/03/2030", "last week", "2030-3-5"]) {
      expect(() => parseDate(bad, NOW)).toThrow(UserInputError);
    }
  });

  it("builds a default range and swaps a reversed one", () => {
    expect(dateRange(undefined, undefined, 30, 366, NOW)).toEqual(["2030-02-14", "2030-03-15"]);
    expect(dateRange("2030-03-10", "2030-03-01", 30, 366, NOW)).toEqual(["2030-03-01", "2030-03-10"]);
  });

  it("ends the default range on the user's local today", () => {
    const sydney = new Date("2030-03-15T21:00:00Z");
    expect(dateRange(undefined, undefined, 3, 366, sydney, "Australia/Sydney")).toEqual(["2030-03-14", "2030-03-16"]);
  });

  it("refuses a range over the maximum", () => {
    expect(() => dateRange("2029-01-01", "2030-03-15", 30, 366, NOW)).toThrow(/at most 366 days/);
  });

  it("splits a range into chunks", () => {
    expect(chunks("2030-01-01", "2030-02-10", 28)).toEqual([
      ["2030-01-01", "2030-01-28"],
      ["2030-01-29", "2030-02-10"],
    ]);
    expect(chunks("2030-01-01", "2030-01-01", 28)).toEqual([["2030-01-01", "2030-01-01"]]);
  });
});

describe("dayRow", () => {
  it("shapes a day summary: km, rounding, and stress no-data markers removed", () => {
    const row = dayRow({
      calendarDate: "2030-03-14",
      totalSteps: 8123,
      totalDistanceMeters: 6543.2,
      restingHeartRate: 55,
      averageStressLevel: -1,
      maxStressLevel: 80,
      averageSpo2: 96.456,
      somethingElse: "ignored",
    });
    expect(row).toEqual({ date: "2030-03-14", steps: 8123, distance_km: 6.54, resting_hr: 55, stress_max: 80, spo2_avg: 96.46 });
  });

  it("returns an empty row for anything that is not an object", () => {
    expect(dayRow(null)).toEqual({});
    expect(dayRow([1, 2])).toEqual({});
  });
});

describe("sleepRows", () => {
  it("adds hours and score and slims the values", () => {
    const rows = sleepRows([
      { calendarDate: "2030-03-14", values: { totalSleepTimeInSeconds: 27000, sleepScore: 81, deepTime: 5400, junk: null } },
      { calendarDate: "2030-03-15", values: { sleepTimeSeconds: 0 } },
      "not a row",
    ]);
    expect(rows).toEqual([
      { date: "2030-03-14", totalSleepTimeInSeconds: 27000, sleepScore: 81, deepTime: 5400, hours: 7.5, score: 81 },
      { date: "2030-03-15", sleepTimeSeconds: 0 },
    ]);
  });
});

describe("upcomingRange", () => {
  it("looks ahead from today by default, and from a given day", () => {
    expect(upcomingRange(undefined, undefined, 14, 90, NOW)).toEqual(["2030-03-15", "2030-03-28"]);
    expect(upcomingRange("2030-04-01", undefined, 14, 90, NOW)).toEqual(["2030-04-01", "2030-04-14"]);
  });

  it("starts from the user's local today", () => {
    const sydney = new Date("2030-03-15T21:00:00Z");
    expect(upcomingRange(undefined, undefined, 3, 90, sydney, "Australia/Sydney")).toEqual(["2030-03-16", "2030-03-18"]);
  });

  it("swaps a reversed range and refuses one over the maximum", () => {
    expect(upcomingRange("2030-03-20", "2030-03-18", 14, 90, NOW)).toEqual(["2030-03-18", "2030-03-20"]);
    expect(() => upcomingRange("2030-01-01", "2030-12-31", 14, 90, NOW)).toThrow(UserInputError);
  });

  it("adds days across month ends", () => {
    expect(addDays("2030-02-27", 3)).toBe("2030-03-02");
  });
});

describe("lactateThreshold", () => {
  it("combines near-duplicate entries: speed (in units of 10 m/s) from one, heart rates from whichever has them", () => {
    expect(
      lactateThreshold([
        { calendarDate: "2030-03-10", speed: 0.4, heartRate: null },
        { calendarDate: "2030-03-01", speed: 0.3, heartRate: 160, heartRateCycling: 150 },
      ]),
    ).toEqual({ date: "2030-03-10", heart_rate: 160, heart_rate_cycling: 150, speed_m_s: 4, pace_per_km: "4:10" });
  });

  it("reads Garmin's misspelt hearRate and a speed that needs rounding", () => {
    expect(lactateThreshold([{ hearRate: 158 }, { calendarDate: "2030-03-10", speed: 0.397 }])).toEqual({
      date: "2030-03-10",
      heart_rate: 158,
      speed_m_s: 3.97,
      pace_per_km: "4:12",
    });
  });

  it("returns {} when there is nothing", () => {
    expect(lactateThreshold([])).toEqual({});
    expect(lactateThreshold(null)).toEqual({});
  });
});

describe("heartRateZones", () => {
  it("makes one entry per sport and drops nulls", () => {
    expect(
      heartRateZones([
        { sport: "RUNNING", trainingMethod: "HR_RESERVE", maxHeartRateUsed: 190, restingHeartRateUsed: 50, lactateThresholdHeartRateUsed: 170, zone1Floor: 120, zone2Floor: 135, zone3Floor: 150, zone4Floor: 160, zone5Floor: 175 },
        { sport: "DEFAULT", maxHeartRateUsed: 188, zone1Floor: 94, zone2Floor: null },
      ]),
    ).toEqual([
      { sport: "RUNNING", method: "HR_RESERVE", max_hr: 190, resting_hr: 50, lactate_threshold_hr: 170, zone_floors: [120, 135, 150, 160, 175] },
      { sport: "DEFAULT", max_hr: 188 },
    ]);
    expect(heartRateZones({})).toEqual([]);
  });
});

describe("strengthSets", () => {
  it("keeps the working sets, converts grams to kg and falls back to the category when the name is null", () => {
    expect(
      strengthSets({
        activityId: 1,
        exerciseSets: [
          { setType: "ACTIVE", duration: 45.6, repetitionCount: 10, weight: 22500, exercises: [{ category: "CURL", name: "DUMBBELL_CURL" }] },
          { setType: "REST", duration: 60, repetitionCount: null, weight: null, exercises: [] },
          { setType: "ACTIVE", duration: 30, repetitionCount: 15, weight: -1, exercises: [{ category: "PUSH_UP", name: null }] },
        ],
      }),
    ).toEqual([
      { exercise: "DUMBBELL_CURL", category: "CURL", reps: 10, weight_kg: 22.5, duration_s: 46 },
      { exercise: "PUSH_UP", category: "PUSH_UP", reps: 15, duration_s: 30 },
    ]);
  });

  it("returns [] when Garmin sends no sets", () => {
    expect(strengthSets({ activityId: 1, exerciseSets: null })).toEqual([]);
    expect(strengthSets(null)).toEqual([]);
  });
});
