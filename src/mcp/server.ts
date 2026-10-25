// The MCP server: read-only tools that let Claude look at the user's Garmin data.

import { getMcpAuthContext } from "agents/mcp/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { requestContext, track } from "../analytics.js";
import { GarminApi, GarminError, type Props } from "../garmin/api.js";
import { dateRange, parseDate, upcomingRange, UserInputError } from "../garmin/shape.js";

export const INSTRUCTIONS = `\
Read-only access to the user's own Garmin Connect data (sleep, HRV, heart rate,
stress, Body Battery, activities, training status, body composition, personal
records, planned workouts).

- Dates are YYYY-MM-DD; 'today' and 'yesterday' also work ('today' is the
  user's local date, from their Garmin time zone). Today's data is partial
  until the watch syncs.
- For trends, prefer the range tools (daily_trends, sleep_history, hrv_history,
  activities) over calling single-day tools many times.
- day_timeline shows one day in 15-minute steps (heart rate, stress, Body
  Battery, steps), in the user's local time.
- Garmin's sleep and HRV for a date refer to the night ending that morning.
- Weight and body composition come from body_composition.
- disconnect deletes the user's stored Pons connection and Garmin login. Only call it when the
  user clearly asks, and confirm first.
- Explain findings in plain language and compare against the user's own
  baseline rather than population norms. This is not medical advice: suggest a
  doctor for anything that looks like a health concern.
- If the user isn't connected, or Garmin keeps rejecting their login after a
  retry, ask them to disconnect and reconnect Pons in their AI app's connector
  settings.
`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Turn an expected failure into plain text Claude can relay. Unknown errors get a generic message. */
export function describeError(e: unknown): string {
  if (e instanceof UserInputError) return `Invalid input: ${e.message}`;
  if (e instanceof GarminError) {
    switch (e.kind) {
      case "not_connected":
        return "Garmin rejected the login. This is often brief: try again in a moment. If it keeps failing, ask the user to disconnect and reconnect Pons in their AI app's connector settings.";
      case "rate_limit":
        return "Garmin is limiting requests right now. Wait a few minutes and try again.";
      case "unreachable":
        return "Could not reach Garmin Connect. Try again in a moment.";
      default:
        return `Could not get data from Garmin Connect. ${e.message}`;
    }
  }
  return "Something went wrong while reading Garmin data.";
}

/** The short name of a failure, for the usage statistics. */
function errorKind(e: unknown): string {
  if (e instanceof UserInputError) return "invalid_input";
  if (e instanceof GarminError) return e.kind;
  return "internal";
}

/** Run a tool body and wrap its result (or its failure) as an MCP tool result. `onStatus` hears "ok" or the failure's kind. */
export async function runTool(body: () => Promise<unknown>, onStatus?: (status: string) => void): Promise<CallToolResult> {
  try {
    const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify(await body()) }] };
    onStatus?.("ok");
    return result;
  } catch (e) {
    onStatus?.(errorKind(e));
    return errorResult(describeError(e));
  }
}

const LIMIT_MESSAGE = "Too many requests to Pons in the last minute. Wait a minute and try again.";

/** The per-user limit is a guard, not a gate: if the binding fails, let the call through. */
async function withinLimit(env: Env, userId: string): Promise<boolean> {
  try {
    return (await env.TOOL_LIMIT.limit({ key: userId })).success;
  } catch {
    return true;
  }
}

/** One tool call: apply the per-user limit, run the body, and record the outcome (names and timings only). */
async function call(name: string, body: () => Promise<unknown>): Promise<CallToolResult> {
  const context = requestContext.getStore();
  if (!context) return runTool(body);
  const userId = (getMcpAuthContext()?.props as Partial<Props> | undefined)?.userId;
  const started = Date.now();
  let status = "ok";
  let result: CallToolResult;
  if (userId && !(await withinLimit(context.env, userId))) {
    status = "rate_limited";
    result = errorResult(LIMIT_MESSAGE);
  } else {
    result = await runTool(body, (s) => (status = s));
  }
  track(context.env, { type: "tool", name, detail: status, ms: Date.now() - started, platform: context.platform, userId });
  return result;
}

/** Revoke every Pons grant of this user, which deletes the stored Garmin login with it. */
async function disconnect(): Promise<unknown> {
  const env = requestContext.getStore()?.env;
  const userId = (getMcpAuthContext()?.props as Partial<Props> | undefined)?.userId;
  if (!env || !userId) {
    return {
      disconnected: false,
      message: "Pons cannot tell which connection this is yet. Try again in an hour, or remove Pons from the AI app's connector settings.",
    };
  }
  let removed = 0;
  try {
    let cursor: string | undefined;
    do {
      const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { limit: 100, cursor });
      for (const grant of page.items) {
        await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
        removed++;
      }
      cursor = page.cursor;
    } while (cursor);
  } catch {
    return {
      disconnected: false,
      connections_removed: removed,
      message:
        "Pons could not finish disconnecting: some or none of the connections were removed. Try again, or remove Pons from the AI app's connector settings.",
    };
  }
  return {
    disconnected: true,
    connections_removed: removed,
    message: "Pons deleted the stored Garmin login and this connection. Tell the user to also remove Pons from their AI app's connector settings.",
  };
}


function currentApi(): GarminApi {
  const props = getMcpAuthContext()?.props as Partial<Props> | undefined;
  if (!props?.garmin?.access || !props.displayName) throw new GarminError("not_connected", "No Garmin login.");
  return new GarminApi(props as Props);
}

/** The user's Garmin time zone, which decides what 'today' is. Undefined falls back to UTC. */
const userTimeZone = () => (getMcpAuthContext()?.props as Partial<Props> | undefined)?.timeZone;

const rangeShape = {
  start_date: z.string().optional().describe("First day, YYYY-MM-DD. Defaults to 30 days before end_date."),
  end_date: z.string().optional().describe("Last day, YYYY-MM-DD, 'today' or 'yesterday'. Defaults to today."),
};

const dateShape = {
  date: z.string().optional().describe("YYYY-MM-DD, 'today' or 'yesterday'. Defaults to today."),
};

/** `origin` is the Worker's own origin, so the icon and website URLs are absolute. Without it the server has neither. */
export function createServer(origin?: string): McpServer {
  const server = new McpServer(
    {
      name: "pons",
      title: "Pons",
      version: "0.1.0",
      description: "Read-only access to your Garmin Connect data: sleep, HRV, stress, Body Battery, activities and training.",
      ...(origin ? { websiteUrl: origin, icons: [{ src: `${origin}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }] } : {}),
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "connection_status",
    {
      title: "Garmin connection status",
      description:
        "Check the Garmin connection and when the watch last synced. Also gives the watch name and when it last uploaded, " +
        "the user's time zone and today's local date.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => call("connection_status", () => currentApi().connectionStatus()),
  );

  server.registerTool(
    "daily_overview",
    {
      title: "Daily overview",
      description:
        "Everything about one day: steps, heart rate, stress, Body Battery, last night's sleep and HRV, " +
        "and training readiness. Good first call for 'how am I doing today?' questions.",
      inputSchema: z.object({
        date: z.string().optional().describe("YYYY-MM-DD, 'today' or 'yesterday'. Defaults to today."),
      }),
      annotations: READ_ONLY,
    },
    ({ date }) => call("daily_overview", async () => currentApi().dailyOverview(parseDate(date, undefined, userTimeZone()))),
  );

  server.registerTool(
    "sleep_history",
    {
      title: "Sleep history",
      description:
        "Nightly sleep summaries (duration, stages, score, resting HR, respiration). Defaults to the last 30 days; max 366.",
      inputSchema: z.object(rangeShape),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date }) =>
      call("sleep_history", async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366, undefined, userTimeZone());
        return currentApi().sleepHistory(start, end);
      }),
  );

  server.registerTool(
    "daily_trends",
    {
      title: "Daily trends",
      description:
        "One row per day with steps, calories, resting HR, stress, Body Battery, intensity minutes and sleep time. " +
        "Defaults to the last 30 days; max 366.",
      inputSchema: z.object(rangeShape),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date }) =>
      call("daily_trends", async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366, undefined, userTimeZone());
        return currentApi().dailyTrends(start, end);
      }),
  );

  server.registerTool(
    "sleep_night_detail",
    {
      title: "Sleep night detail",
      description:
        "Detailed breakdown of one night: stages, score factors, overnight HRV, SpO2, respiration, restlessness, " +
        "Body Battery recharge.",
      inputSchema: z.object(dateShape),
      annotations: READ_ONLY,
    },
    ({ date }) => call("sleep_night_detail", async () => currentApi().sleepNightDetail(parseDate(date, undefined, userTimeZone()))),
  );

  server.registerTool(
    "hrv_history",
    {
      title: "HRV history",
      description:
        "Nightly HRV with the 7-day average, personal baseline range and status (balanced / unbalanced / low). " +
        "Defaults to the last 30 days; max 180.",
      inputSchema: z.object(rangeShape),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date }) =>
      call("hrv_history", async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 180, undefined, userTimeZone());
        return currentApi().hrvHistory(start, end);
      }),
  );

  server.registerTool(
    "activities",
    {
      title: "Activities",
      description:
        "Workouts, newest first, with distance, duration, pace or speed, heart rate, training effect and load. " +
        "Defaults to the last 30 days; max 366. At most 200 activities are returned; ask for a shorter range if a " +
        "note says there are more. For 'my last N workouts' or 'my last 5 runs', use limit (with activity_type " +
        "if needed) and no dates instead of guessing a date range. activity_type takes a group (running, cycling, " +
        "swimming, hiking, walking, fitness_equipment, multi_sport, other) or any single sport, such as golf, " +
        "tennis, padel, yoga, strength_training or trail_running.",
      inputSchema: z.object({
        ...rangeShape,
        activity_type: z
          .string()
          .optional()
          .describe(
            "Only this kind: a group (running, cycling, swimming, hiking, walking, fitness_equipment, multi_sport, other) " +
              "or one sport by Garmin's name for it, e.g. golf, tennis, padel, strength_training.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Only the N most recent activities, e.g. 5 for 'my last 5 runs'. Without dates, no date range applies."),
      }),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date, activity_type, limit }) =>
      call("activities", async () => {
        // "Table Tennis" and "table-tennis" become Garmin's "table_tennis".
        const type = activity_type?.trim().toLowerCase().replace(/[\s-]+/g, "_") || undefined;
        // "The last N": no default 30 days, Garmin returns the most recent ones.
        if (limit !== undefined && !start_date && !end_date) return currentApi().activities(undefined, undefined, type, limit);
        // A limit with only an end date looks back up to a year from it.
        const [start, end] = dateRange(start_date, end_date, limit !== undefined ? 366 : 30, 366, undefined, userTimeZone());
        return currentApi().activities(start, end, type, limit);
      }),
  );

  server.registerTool(
    "activity_detail",
    {
      title: "Activity detail",
      description:
        "Full summary of one workout plus its laps/splits, time in heart rate zones, power time in zones and weather. " +
        "For strength workouts it also gives the sets (exercises, reps, weight). Get the id from the activities tool.",
      inputSchema: z.object({ activity_id: z.string().describe("The workout's id, from the activities tool.") }),
      annotations: READ_ONLY,
    },
    ({ activity_id }) =>
      call("activity_detail", async () => {
        const id = activity_id.trim();
        if (!/^\d{1,20}$/.test(id)) throw new UserInputError("activity_id must be a number from the activities tool.");
        return currentApi().activityDetail(id);
      }),
  );

  server.registerTool(
    "training_status",
    {
      title: "Training status",
      description:
        "Fitness and training picture: training status and load balance, acute load, recovery time, readiness, VO2 max, " +
        "heat and altitude acclimation, race predictions, endurance and hill score, fitness age. Also the lactate threshold, " +
        "running power and cycling FTP, and heart rate zones.",
      inputSchema: z.object(dateShape),
      annotations: READ_ONLY,
    },
    ({ date }) => call("training_status", async () => currentApi().trainingStatus(parseDate(date, undefined, userTimeZone()))),
  );

  server.registerTool(
    "body_composition",
    {
      title: "Weight and body composition",
      description:
        "Weight and body composition entries (if the user logs weight or uses a Garmin scale): the place for any " +
        "weight question. Defaults to the last 90 days; max 366.",
      inputSchema: z.object(rangeShape),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date }) =>
      call("body_composition", async () => {
        const [start, end] = dateRange(start_date, end_date, 90, 366, undefined, userTimeZone());
        return currentApi().bodyComposition(start, end);
      }),
  );

  server.registerTool(
    "day_timeline",
    {
      title: "Day timeline",
      description:
        "One day in 15-minute steps (local time): average and max heart rate, stress, Body Battery and steps. " +
        "Use it to see when stress rose, when Body Battery dropped, or how a workout or a bad night showed up during the day.",
      inputSchema: z.object(dateShape),
      annotations: READ_ONLY,
    },
    ({ date }) => call("day_timeline", async () => currentApi().dayTimeline(parseDate(date, undefined, userTimeZone()))),
  );

  server.registerTool(
    "personal_records",
    {
      title: "Personal records",
      description:
        "The user's personal records (fastest 5 km, 10 km, half marathon, longest run and so on). " +
        "Times are in seconds, distances in metres.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => call("personal_records", () => currentApi().personalRecords()),
  );

  server.registerTool(
    "planned_workouts",
    {
      title: "Planned workouts",
      description:
        "Workouts scheduled on the user's Garmin calendar, including training plans. " +
        "Defaults to the next 14 days from today; max 90 days.",
      inputSchema: z.object({
        start_date: z.string().optional().describe("First day, YYYY-MM-DD or 'today'. Defaults to today."),
        end_date: z.string().optional().describe("Last day, YYYY-MM-DD. Defaults to 13 days after start_date."),
      }),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date }) =>
      call("planned_workouts", async () => {
        const [start, end] = upcomingRange(start_date, end_date, 14, 90, undefined, userTimeZone());
        return currentApi().plannedWorkouts(start, end);
      }),
  );

  server.registerTool(
    "disconnect",
    {
      title: "Disconnect Pons",
      description:
        "Deletes everything Pons holds for this user: all their Pons connections and the stored Garmin login. " +
        "Only call it when the user clearly asks to disconnect Pons or delete their data, and confirm with them first. " +
        "It does not change anything in the Garmin account.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => call("disconnect", disconnect),
  );

  return server;
}
