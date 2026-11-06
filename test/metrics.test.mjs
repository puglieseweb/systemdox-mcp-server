// Unit tests for the EMF tool-call telemetry (src/lib/metrics.ts, issue #978).
// Offline: emitted lines are captured via the injected log function. Build
// first (`npm run build`), then `node --test test/`.
import test from "node:test";
import assert from "node:assert/strict";
import { buildMcpToolCallMetric, emitMcpToolCalls } from "../dist/lib/metrics.js";

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

test("buildMcpToolCallMetric produces a valid EMF envelope", () => {
  const metric = buildMcpToolCallMetric("acme", "get_context", 1234567890);
  assert.equal(metric._aws.Timestamp, 1234567890);
  assert.deepEqual(metric._aws.CloudWatchMetrics, [
    {
      Namespace: "SystemDox/Mcp",
      Dimensions: [["tenant"]],
      Metrics: [{ Name: "McpToolCall", Unit: "Count" }],
    },
  ]);
  assert.equal(metric.tenant, "acme");
  assert.equal(metric.tool, "get_context");
  assert.equal(metric.McpToolCall, 1);
});

test("emits one line per tools/call with tenant and tool name", () => {
  const { lines, log } = capture();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_checks", arguments: {} },
  });
  emitMcpToolCalls("acme", body, log);
  assert.equal(lines.length, 1);
  const emf = JSON.parse(lines[0]);
  assert.equal(emf.tenant, "acme");
  assert.equal(emf.tool, "get_checks");
  assert.equal(emf.McpToolCall, 1);
  assert.equal(emf._aws.CloudWatchMetrics[0].Namespace, "SystemDox/Mcp");
});

test("counts every tools/call in a batch, ignores other methods", () => {
  const { lines, log } = capture();
  const body = JSON.stringify([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_specs" } },
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_guardrails" } },
  ]);
  emitMcpToolCalls("acme", body, log);
  assert.deepEqual(
    lines.map((l) => JSON.parse(l).tool),
    ["get_specs", "get_guardrails"]
  );
});

test("non-tool methods emit nothing", () => {
  const { lines, log } = capture();
  emitMcpToolCalls("acme", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }), log);
  assert.equal(lines.length, 0);
});

test("malformed body never throws and emits nothing", () => {
  const { lines, log } = capture();
  emitMcpToolCalls("acme", "{not json", log);
  emitMcpToolCalls("acme", "", log);
  emitMcpToolCalls("acme", "null", log);
  assert.equal(lines.length, 0);
});

test("missing tool name and empty tenant fall back to 'unknown'", () => {
  const { lines, log } = capture();
  emitMcpToolCalls("", JSON.stringify({ method: "tools/call", params: {} }), log);
  assert.equal(lines.length, 1);
  const emf = JSON.parse(lines[0]);
  assert.equal(emf.tool, "unknown");
  assert.equal(emf.tenant, "unknown");
});
