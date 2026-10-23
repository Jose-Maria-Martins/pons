// The MCP server: read-only tools that let Claude look at the user's Garmin data.

import { getMcpAuthContext } from "agents/mcp/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { GarminApi, GarminError, type Props } from "../garmin/api.js";
import { dateRange, parseDate, upcomingRange, UserInputError } from "../garmin/shape.js";

export const INSTRUCTIONS = `\
Read-only access to the user's own Garmin Connect data (sleep, HRV, heart rate,
stress, Body Battery, activities, training status, body composition, personal
records, planned workouts).

- Dates are YYYY-MM-DD; 'today' and 'yesterday' also work ('today' is the UTC
  date). Today's data is partial until the watch syncs.
- For trends, prefer the range tools (daily_trends, sleep_history, hrv_history,
  activities) over calling single-day tools many times.
- day_timeline shows one day in 15-minute steps (heart rate, stress, Body
  Battery, steps), in the user's local time.
- Garmin's sleep and HRV for a date refer to the night ending that morning.
- Weight and body composition come from body_composition.
- Explain findings in plain language and compare against the user's own
  baseline rather than population norms. This is not medical advice: suggest a
  doctor for anything that looks like a health concern.
- If the user isn't connected, or their Garmin login expired, ask them to
  disconnect and reconnect Pons in their Claude connector settings.
`;

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const errorResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Turn an expected failure into plain text Claude can relay. Unknown errors get a generic message. */
export function describeError(e: unknown): string {
  if (e instanceof UserInputError) return `Invalid input: ${e.message}`;
  if (e instanceof GarminError) {
    switch (e.kind) {
      case "not_connected":
        return "Not connected to Garmin, or the Garmin login expired. Ask the user to disconnect and reconnect Pons in their Claude connector settings, then try again.";
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

/** Run a tool body and wrap its result (or its failure) as an MCP tool result. */
export async function runTool(body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await body()) }] };
  } catch (e) {
    return errorResult(describeError(e));
  }
}

function currentApi(): GarminApi {
  const props = getMcpAuthContext()?.props as Partial<Props> | undefined;
  if (!props?.garmin?.access || !props.displayName) throw new GarminError("not_connected", "No Garmin login.");
  return new GarminApi(props as Props);
}

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
      description: "Check the Garmin connection and when the watch last synced.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => runTool(() => currentApi().connectionStatus()),
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
    ({ date }) => runTool(async () => currentApi().dailyOverview(parseDate(date))),
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
      runTool(async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366);
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
      runTool(async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366);
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
    ({ date }) => runTool(async () => currentApi().sleepNightDetail(parseDate(date))),
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
      runTool(async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 180);
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
      runTool(async () => {
        const [start, end] = dateRange(start_date, end_date, 30, 366);
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
      runTool(async () => {
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
    ({ date }) => runTool(async () => currentApi().trainingStatus(parseDate(date))),
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
      runTool(async () => {
        const [start, end] = dateRange(start_date, end_date, 90, 366);
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
    ({ date }) => runTool(async () => currentApi().dayTimeline(parseDate(date))),
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
    () => runTool(() => currentApi().personalRecords()),
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
      runTool(async () => {
        const [start, end] = upcomingRange(start_date, end_date, 14, 90);
        return currentApi().plannedWorkouts(start, end);
      }),
  );

  return server;
}
