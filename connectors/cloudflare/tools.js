// ---------------------------------------------------------------------------
// connectors/cloudflare/tools.js — aggregates and registers all Cloudflare
// sub-tool modules (D1, KV, R2, Workers, Hyperdrive) with the MCP server.
// ---------------------------------------------------------------------------

import * as d1 from "./d1.js";
import * as kv from "./kv.js";
import * as r2 from "./r2.js";
import * as workers from "./workers.js";
import * as hyperdrive from "./hyperdrive.js";
import * as observability from "./observability.js";

export function register(server) {
  d1.register(server);
  kv.register(server);
  r2.register(server);
  workers.register(server);
  hyperdrive.register(server);
  observability.register(server);
}
