// ---------------------------------------------------------------------------
// connectors/notion/views.js
//
// Notion Views API wrapper + native chart view config builder (scaffold).
// See the plan: "Plan: Native Notion charts in madmcp" (entity_id:
// plan-madmcp-notion-charts).
//
// NOT wired into any tool yet -- Step 1 only adds this skeleton. Later steps
// add the views client (Step 2), the pure chart config builder (Step 3) and
// the notion_chart tool (Step 4).
//
// VERSION NOTE: the Views API needs Notion-Version 2025-09-03 or later, but
// the global NOTION_VERSION in config.js (2022-06-28) must NOT be bumped: the
// entity index depends on /databases/{id}/query. Every call in this file
// passes VIEWS_API_VERSION explicitly via notionRequest's `version` option.
// ---------------------------------------------------------------------------

export const VIEWS_API_VERSION = "2026-03-11";

export const CHART_TYPES = ["column", "bar", "line", "donut", "number"];
