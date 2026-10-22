// The MCP server: read-only tools that let Claude look at the user's Garmin data.

import { getMcpAuthContext } from "agents/mcp/server";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { GarminApi, GarminError, type Props } from "../garmin/api.js";
import { dateRange, parseDate, UserInputError } from "../garmin/shape.js";

export const INSTRUCTIONS = `\
Read-only access to the user's own Garmin Connect data (sleep, HRV, heart rate,
stress, Body Battery).

- Dates are YYYY-MM-DD; 'today' and 'yesterday' also work. Today's data is
  partial until the watch syncs.
- For trends, prefer the range tool (sleep_history) over calling single-day
  tools many times.
- Garmin's sleep for a date refers to the night ending that morning.
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

export function createServer(): McpServer {
  const server = new McpServer({ name: "pons", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "connection_status",
    {
      description: "Check the Garmin connection and when the watch last synced.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    () => runTool(() => currentApi().connectionStatus()),
  );

  server.registerTool(
    "daily_overview",
    {
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

  return server;
}
