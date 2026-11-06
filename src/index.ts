import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SystemDoxApiClient } from "./lib/api-client.js";
import { loadConfig } from "./lib/config.js";
import { NO_KEY, keyReason, sessionInstructions } from "./lib/session-brief.js";
import { loadLocalConfig } from "./lib/team-setup-files.js";
import { createServer } from "./server.js";

// The local server: the key from SYSTEMDOX_API_KEY, then from
// ~/.claude/systemdox/credentials.json, where `setup` stores it (never in the
// AI tool's MCP config). The hosted server (http.ts) takes each request's key.
//
// With no key it still connects: installing the server should be enough for a
// computer to know what to do, and that includes being told it has no key
// (ADR-223). A URL that is not https is a misconfiguration the key must not be
// sent through, so loadConfig still stops it, here as there.
let config: ReturnType<typeof loadConfig>;
let keyProblem: string | undefined;
try {
  config = await loadLocalConfig();
} catch (err) {
  // The log gets the whole message; the session gets words of our own.
  console.error(`SystemDox MCP server: ${(err as Error).message}`);
  keyProblem = keyReason((err as Error).message);
  try {
    config = loadConfig(NO_KEY);
  } catch (urlErr) {
    console.error(`SystemDox MCP server: ${(urlErr as Error).message}`);
    process.exit(1);
  }
}
const apiClient = new SystemDoxApiClient(config);

async function main() {
  // Read before connecting: `instructions` go out in the `initialize` answer.
  // The read is bounded and never throws, so it cannot hold or stop the start.
  const instructions = await sessionInstructions(apiClient, { localFiles: true, keyProblem });
  const server = createServer(apiClient, { localFiles: true, instructions, keyProblem });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();

export { apiClient, config };
export { createServer } from "./server.js";
