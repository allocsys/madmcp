// ---------------------------------------------------------------------------
// connectors/notion/views.js
//
// Notion Views API wrapper (Step 2 of the plan "Plan: Native Notion charts in
// madmcp", entity_id: plan-madmcp-notion-charts). Step 3 adds the pure chart
// config builder, Step 4 the notion_chart tool. Nothing here is wired into a
// tool yet.
//
// VERSION NOTE: the Views API needs Notion-Version 2025-09-03 or later, but
// the global NOTION_VERSION in config.js (2022-06-28) must NOT be bumped: the
// entity index depends on /databases/{id}/query. Every call in this file
// passes VIEWS_API_VERSION explicitly via notionRequest's `version` option.
//
// RETRY NOTE: notionRequest's isSafeToRetryOnServerError already treats
// POST /views as NOT safe to retry on 5xx (a lost response could otherwise
// create a duplicate view), and PATCH/DELETE /views/{id} as safe. Covered by
// test/notion-views.test.js so a future change to that function can't
// silently break it.
// ---------------------------------------------------------------------------

import { notionRequest } from "./client.js";

export const VIEWS_API_VERSION = "2026-03-11";

// Single source of truth lives in chart_config.js (pure, no I/O imports).
export { CHART_TYPES } from "./chart_config.js";

function requireId(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required (non-empty string)`);
  }
  return value.trim();
}

function viewsRequest(path, { method = "GET", body } = {}) {
  return notionRequest(path, { method, body, version: VIEWS_API_VERSION });
}

// POST /v1/views. `body` is passed through as-is (Step 3 builds it).
export function createView(body) {
  if (!body || typeof body !== "object") throw new Error("createView: body is required");
  return viewsRequest("/views", { method: "POST", body });
}

// GET /v1/views/{id} -- full view object incl. filter, sorts, configuration.
export function retrieveView(view_id) {
  return viewsRequest(`/views/${encodeURIComponent(requireId(view_id, "view_id"))}`);
}

// PATCH /v1/views/{id}. Only include fields to change; configuration is a
// shallow merge and must include its `type`.
export function updateView(view_id, body) {
  if (!body || typeof body !== "object") throw new Error("updateView: body is required");
  return viewsRequest(`/views/${encodeURIComponent(requireId(view_id, "view_id"))}`, { method: "PATCH", body });
}

// DELETE /v1/views/{id}. Notion refuses to delete a database's last view.
export function deleteView(view_id) {
  return viewsRequest(`/views/${encodeURIComponent(requireId(view_id, "view_id"))}`, { method: "DELETE" });
}

// GET /v1/views?database_id=... | ?data_source_id=... (exactly one).
// Returns minimal references ({object, id}); retrieveView for full details.
export function listViews({ database_id, data_source_id, start_cursor, page_size } = {}) {
  if (!!database_id === !!data_source_id) {
    throw new Error("listViews: pass exactly one of database_id or data_source_id");
  }
  const params = new URLSearchParams();
  if (database_id) params.set("database_id", requireId(database_id, "database_id"));
  if (data_source_id) params.set("data_source_id", requireId(data_source_id, "data_source_id"));
  if (start_cursor) params.set("start_cursor", start_cursor);
  if (page_size) params.set("page_size", String(Math.min(Math.max(Number(page_size) || 1, 1), 100)));
  return viewsRequest(`/views?${params.toString()}`);
}

// Resolves what a view/chart needs from a database: the data source ID and a
// property map. Under 2026-03-11 the database object only carries a
// `data_sources` array ([{id, name}]); the property schema lives on the data
// source (GET /data_sources/{id}).
//
// Pass data_source_id to pick one when the database has several; without it,
// a database with more than one data source is an error (guessing could chart
// the wrong data).
//
// Returns { database_id, data_source_id, data_source_name, properties,
// propertiesById } where properties is keyed by property name and each value
// is { id, name, type, raw }.
export async function getDatabaseSchema(database_id, { data_source_id } = {}) {
  const dbId = requireId(database_id, "database_id");
  const db = await viewsRequest(`/databases/${encodeURIComponent(dbId)}`);
  const sources = Array.isArray(db?.data_sources) ? db.data_sources : [];
  if (!sources.length) {
    throw new Error(`Database ${dbId} has no data sources (is the integration shared with it?)`);
  }

  let source;
  if (data_source_id) {
    source = sources.find((s) => s.id === data_source_id);
    if (!source) {
      throw new Error(`data_source_id ${data_source_id} not found in database ${dbId}. Available: ${sources.map((s) => `${s.name || "(unnamed)"} (${s.id})`).join(", ")}`);
    }
  } else if (sources.length === 1) {
    source = sources[0];
  } else {
    throw new Error(`Database ${dbId} has ${sources.length} data sources; pass data_source_id. Available: ${sources.map((s) => `${s.name || "(unnamed)"} (${s.id})`).join(", ")}`);
  }

  const ds = await viewsRequest(`/data_sources/${encodeURIComponent(source.id)}`);
  const properties = {};
  const propertiesById = {};
  for (const [key, prop] of Object.entries(ds?.properties || {})) {
    const entry = { id: prop.id, name: prop.name || key, type: prop.type, raw: prop };
    properties[entry.name] = entry;
    if (entry.id) propertiesById[entry.id] = entry;
  }

  return {
    database_id: dbId,
    data_source_id: source.id,
    data_source_name: source.name || null,
    properties,
    propertiesById,
  };
}
