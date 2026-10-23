import { afterEach, describe, expect, it, vi } from "vitest";
import { localDate } from "../src/garmin/shape.js";
import { connect, json, message, mockFetch, on, rpc } from "./helpers.js";

const API = "https://connectapi.garmin.com";

afterEach(() => vi.restoreAllMocks());

describe("/mcp", () => {
  it("answers 401 with a pointer to the OAuth metadata when there is no token", async () => {
    const res = await rpc(null, "tools/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
  });

  it("lists every tool with a title, all read-only except disconnect", async () => {
    const { accessToken } = await connect();
    const res = await rpc(accessToken, "tools/list");
    expect(res.status).toBe(200);
    const tools = (await message(res)).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "activities",
      "activity_detail",
      "body_composition",
      "connection_status",
      "daily_overview",
      "daily_trends",
      "day_timeline",
      "disconnect",
      "hrv_history",
      "personal_records",
      "planned_workouts",
      "sleep_history",
      "sleep_night_detail",
      "training_status",
    ]);
    const [disconnect, others] = [tools.filter((t) => t.name === "disconnect"), tools.filter((t) => t.name !== "disconnect")];
    expect(others.every((t) => t.annotations.readOnlyHint === true)).toBe(true);
    expect(disconnect.map((t) => [t.annotations.readOnlyHint, t.annotations.destructiveHint])).toEqual([[false, true]]);
    expect(tools.every((t) => typeof t.title === "string" && t.title.length > 0)).toBe(true);
  });

  it("runs a tool with the Garmin token stored in the grant", async () => {
    const { accessToken } = await connect();
    const { spy } = mockFetch(
      on(`${API}/userprofile-service/socialProfile`, () => json({ fullName: "Test Person" })),
      on(`${API}/userprofile-service/userprofile/user-settings`, () => json({ userData: { measurementSystem: "metric" } })),
      on(`${API}/wellness-service/wellness/syncTimestamp`, () => json("2030-03-14T07:00:00.0")),
    );

    const res = await rpc(accessToken, "tools/call", { name: "connection_status", arguments: {} });
    const result = (await message(res)).result;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({
      connected: true,
      time_zone: "Europe/London",
      today: localDate(new Date(), "Europe/London"),
      name: "Test Person",
      units: "metric",
      last_sync: "2030-03-14T07:00:00.0",
    });
    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-garmin-access");
  });

  it("returns a bad date as an isError result", async () => {
    const { accessToken } = await connect();
    const res = await rpc(accessToken, "tools/call", { name: "daily_overview", arguments: { date: "not-a-date" } });
    const result = (await message(res)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Invalid input/);
  });

  it("returns Garmin being unreachable as an isError result", async () => {
    const { accessToken } = await connect();
    mockFetch(() => json({}, 503));
    const res = await rpc(accessToken, "tools/call", { name: "sleep_history", arguments: {} });
    const result = (await message(res)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Could not reach Garmin/);
  });

  it("uses the time zone stored at login for 'today' in the tools and in connection_status", async () => {
    // Pick a zone whose date differs from the UTC date right now, so a UTC 'today' would fail this test.
    const utc = new Date().toISOString().slice(0, 10);
    const zone = ["Pacific/Kiritimati", "Pacific/Pago_Pago"].find((z) => localDate(new Date(), z) !== utc)!;
    const local = localDate(new Date(), zone);
    const { accessToken } = await connect(3600, "mcp-time-zone", zone);

    const { calls } = mockFetch(() => json({}));
    await message(await rpc(accessToken, "tools/call", { name: "hrv_history", arguments: {} }));
    await message(await rpc(accessToken, "tools/call", { name: "training_status", arguments: {} }));
    expect(calls.some((c) => c.startsWith(`${API}/hrv-service/hrv/daily/`) && c.endsWith(`/${local}`))).toBe(true);
    expect(calls).toContain(`${API}/fitnessage-service/fitnessage/${local}`);

    vi.restoreAllMocks();
    mockFetch(() => json({}));
    const status = (await message(await rpc(accessToken, "tools/call", { name: "connection_status", arguments: {} }))).result;
    expect(JSON.parse(status.content[0]?.text ?? "")).toMatchObject({ time_zone: zone, today: local });
  });

  it("still connects, with the UTC time zone, when Garmin's settings call fails at login", async () => {
    const { accessToken } = await connect(3600, "mcp-no-time-zone", null);
    mockFetch(() => json({}));
    const status = (await message(await rpc(accessToken, "tools/call", { name: "connection_status", arguments: {} }))).result;
    expect(JSON.parse(status.content[0]?.text ?? "")).toMatchObject({ time_zone: "UTC", today: new Date().toISOString().slice(0, 10) });
  });

  it("says 'today' is the local date in the instructions", async () => {
    const { accessToken } = await connect();
    const res = await rpc(accessToken, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    const text = await res.text();
    expect(text).toContain("user's local date");
    expect(text).not.toContain("UTC");
  });

  it("asks for a retry, then a reconnect of Pons, when Garmin rejects the login", async () => {
    const { accessToken } = await connect();
    mockFetch(() => json({}, 401));
    const res = await rpc(accessToken, "tools/call", { name: "sleep_history", arguments: {} });
    const result = (await message(res)).result;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/try again in a moment.*If it keeps failing.*disconnect and reconnect Pons/);
  });
});
