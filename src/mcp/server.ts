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
  retry, ask them to disconnect and reconnect Pons in their Claude connector
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
        return "Garmin rejected the login. This is often brief: try again in a moment. If it keeps failing, ask the user to disconnect and reconnect Pons in their Claude connector settings.";
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

/** One tool call: apply the per-user limit, run the body, and record the outcome (names and timings only). */
async function call(name: string, body: () => Promise<unknown>): Promise<CallToolResult> {
  const context = requestContext.getStore();
  if (!context) return runTool(body);
  const userId = (getMcpAuthContext()?.props as Partial<Props> | undefined)?.userId;
  const started = Date.now();
  let status = "ok";
  let result: CallToolResult;
  if (userId && !(await context.env.TOOL_LIMIT.limit({ key: userId })).success) {
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
      message: "Pons cannot tell which connection this is yet. Try again in an hour, or remove the Pons connector in Claude's settings.",
    };
  }
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(userId, { limit: 100, cursor });
    for (const grant of page.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, userId);
      removed++;
    }
    cursor = page.cursor;
  } while (cursor);
  return {
    disconnected: true,
    connections_removed: removed,
    message: "Pons deleted the stored Garmin login and this connection. Tell the user to also remove the Pons connector in Claude's settings.",
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

export function createServer(): McpServer {
  const server = new McpServer({ name: "pons", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "connection_status",
    {
      title: "Garmin connection status",
      description: "Check the Garmin connection and when the watch last synced. Also gives the user's time zone and today's local date.",
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
        "Workouts in a date range with distance, duration, pace or speed, heart rate, training effect and load. " +
        "Defaults to the last 30 days; max 366. At most 200 activities are returned; ask for a shorter range if a " +
        "note says there are more. activity_type filters: running, cycling, swimming, hiking, walking, " +
        "fitness_equipment, multi_sport, other.",
      inputSchema: z.object({
        ...rangeShape,
        activity_type: z
          .string()
          .optional()
          .describe("Only this kind: running, cycling, swimming, hiking, walking, fitness_equipment, multi_sport or other."),
      }),
      annotations: READ_ONLY,
    },
    ({ start_date, end_date, activity_type }) =>
      call("activities", async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366, undefined, userTimeZone());
        return currentApi().activities(start, end, activity_type?.trim().toLowerCase() || undefined);
      }),
  );

  server.registerTool(
    "activity_detail",
    {
      title: "Activity detail",
      description:
        "Full summary of one workout plus its laps/splits, time in heart rate zones and weather. " +
        "Get the id from the activities tool.",
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
        "Fitness and training picture: training status and load balance, readiness, VO2 max, race predictions, " +
        "endurance score and fitness age.",
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
