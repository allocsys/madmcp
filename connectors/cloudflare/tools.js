// ---------------------------------------------------------------------------
// connectors/cloudflare/tools.js — aggregates and registers all Cloudflare
// sub-tool modules (D1, KV, R2, Workers, Hyperdrive, Observability, guarded
// delete) with the
// MCP server. observability_compare.js exports compareScripts, which the
// observability module calls for action 'compare' (it registers no tool).
// ---------------------------------------------------------------------------

import * as d1 from "./d1.js";
import * as kv from "./kv.js";
import * as r2 from "./r2.js";
import * as workers from "./workers.js";
import * as hyperdrive from "./hyperdrive.js";
import * as observability from "./observability.js";
import * as del from "./delete.js";

export function register(server) {
  d1.register(server);
  kv.register(server);
  r2.register(server);
  workers.register(server);
  hyperdrive.register(server);
  observability.register(server);
  del.register(server);
}
