/**
 * CloudWatch EMF telemetry for hosted MCP tool calls (issue #978).
 *
 * One metric answers two standing questions:
 *  - activation: "which tenants had ≥1 agent MCP call this week?" —
 *    `McpToolCall` dimensioned by `tenant`, joined against the repo
 *    `connectedAt` cohort in DynamoDB;
 *  - the deprecated-alias removal gate (README "Deprecated tool names"):
 *    per-tool-name counts come from the `tool` property via Logs Insights,
 *    kept out of the dimensions so metric cardinality stays = tenants.
 *
 * EMF is a formatted console.log — no SDK dependency, no latency, and the
 * Lambda's existing log group is the transport. Telemetry must never break
 * the request path: emitters swallow their own failures.
 */

const NAMESPACE = "SystemDox/Mcp";
const METRIC_NAME = "McpToolCall";

export interface McpToolCallMetric {
  _aws: {
    Timestamp: number;
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
  tenant: string;
  tool: string;
  [METRIC_NAME]: number;
}

/** Build the EMF envelope for a single tool call. Pure — unit-testable. */
export function buildMcpToolCallMetric(
  tenant: string,
  tool: string,
  timestamp: number = Date.now()
): McpToolCallMetric {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: NAMESPACE,
          Dimensions: [["tenant"]],
          Metrics: [{ Name: METRIC_NAME, Unit: "Count" }],
        },
      ],
    },
    tenant,
    tool,
    [METRIC_NAME]: 1,
  };
}

/**
 * Parse a JSON-RPC request body (single message or batch) and emit one EMF
 * line per `tools/call`. Anything unparseable or non-tool (initialize,
 * tools/list, notifications) is ignored. Never throws.
 */
export function emitMcpToolCalls(
  tenant: string,
  rawBody: string,
  log: (line: string) => void = console.log
): void {
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { method?: unknown }).method === "tools/call"
      ) {
        const params = (message as { params?: { name?: unknown } }).params;
        const tool = typeof params?.name === "string" ? params.name : "unknown";
        log(JSON.stringify(buildMcpToolCallMetric(tenant || "unknown", tool)));
      }
    }
  } catch {
    // Telemetry never breaks the request path — a malformed body will be
    // rejected by the transport with a proper JSON-RPC error anyway.
  }
}
