// ---------------------------------------------------------------------------
// connectors/notion/chart_data.js
//
// Pure functions (no I/O) for the notion_chart `create_from_data` action:
// turn a small inline dataset ({columns, rows}) into the request bodies for a
// new Notion database and its rows. Step 8 follow-up of the plan "Plan:
// Native Notion charts in madmcp" (entity_id: plan-madmcp-notion-charts).
//
// Scope is deliberately small: scratch data to chart, not general data entry.
// Six column types, at most MAX_COLUMNS columns and MAX_ROWS rows (rows are
// written one request at a time, so the cap keeps a call quick and well under
// Notion's rate limit).
//
// Like chart_config.js, validation collects ALL problems and throws once.
// ---------------------------------------------------------------------------

export const MAX_ROWS = 50;
export const MAX_COLUMNS = 25;
const MAX_TEXT = 2000;       // Notion's limit for one rich-text item
const MAX_SELECT = 100;      // Notion's limit for a select option name
const MAX_ERRORS_SHOWN = 20;

// column type -> [Notion property type, schema body for POST /databases]
const COLUMN_TYPES = {
  title:    ["title",     { title: {} }],
  text:     ["rich_text", { rich_text: {} }],
  number:   ["number",    { number: {} }],
  select:   ["select",    { select: {} }],
  date:     ["date",      { date: {} }],
  checkbox: ["checkbox",  { checkbox: {} }],
};
export const COLUMN_TYPE_NAMES = Object.keys(COLUMN_TYPES);

const DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

export class DatasetError extends Error {
  constructor(errors) {
    const shown = errors.slice(0, MAX_ERRORS_SHOWN);
    const extra = errors.length - shown.length;
    super(shown.join("; ") + (extra > 0 ? `; ...and ${extra} more` : ""));
    this.name = "DatasetError";
    this.errors = shown;
    this.totalErrors = errors.length;
  }
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isBlank = (v) => v === undefined || v === null || v === "";

// Converts one cell. Returns { value } (a Notion property value), { skip: true }
// for an empty cell, or { error } with a message.
function convertCell(type, raw) {
  if (isBlank(raw)) return { skip: true };

  if (type === "title" || type === "text") {
    if (typeof raw === "object") return { error: `must be a string, number or boolean` };
    const str = String(raw);
    if (str.length > MAX_TEXT) return { error: `is ${str.length} characters; the limit is ${MAX_TEXT}` };
    const rich = [{ type: "text", text: { content: str } }];
    return { value: type === "title" ? { title: rich } : { rich_text: rich } };
  }
  if (type === "number") {
    if (typeof raw === "number" && Number.isFinite(raw)) return { value: { number: raw } };
    if (typeof raw === "string" && NUMBER_RE.test(raw.trim())) return { value: { number: Number(raw) } };
    return { error: `must be a number (got ${JSON.stringify(raw)})` };
  }
  if (type === "select") {
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return { error: "must be a string" };
    const name = String(raw).trim();
    if (!name) return { skip: true };
    if (name.includes(",")) return { error: `can't contain a comma (Notion rejects it in option names): ${JSON.stringify(name)}` };
    if (name.length > MAX_SELECT) return { error: `is ${name.length} characters; the limit for an option name is ${MAX_SELECT}` };
    return { value: { select: { name } } };
  }
  if (type === "date") {
    if (typeof raw !== "string" || !DATE_RE.test(raw.trim()) || Number.isNaN(Date.parse(raw.trim()))) {
      return { error: `must be an ISO date like 2026-10-04 or 2026-10-04T09:30:00Z (got ${JSON.stringify(raw)})` };
    }
    return { value: { date: { start: raw.trim() } } };
  }
  if (type === "checkbox") {
    if (typeof raw !== "boolean") return { error: `must be true or false (got ${JSON.stringify(raw)})` };
    return { value: { checkbox: raw } };
  }
  return { error: `unsupported column type ${type}` };
}

// input: { database_title, columns: [{name, type}], rows: [{<column>: value}] }
// Returns { title, columns, schema, rows } where:
//   schema -> the `properties` body for POST /databases
//   rows   -> one Notion `properties` object per row, for POST /pages
export function buildDataset(input = {}) {
  const errs = [];
  const { database_title, columns, rows } = input;

  const title = typeof database_title === "string" ? database_title.trim() : "";
  if (!title) errs.push("database_title is required");

  const cols = [];
  if (!Array.isArray(columns) || !columns.length) {
    errs.push("columns is required: a non-empty array of {name, type}");
  } else if (columns.length > MAX_COLUMNS) {
    errs.push(`too many columns (${columns.length}); the limit is ${MAX_COLUMNS}`);
  } else {
    const seen = new Set();
    columns.forEach((c, i) => {
      const label = `columns[${i}]`;
      if (!isObj(c)) { errs.push(`${label} must be an object {name, type}`); return; }
      const name = typeof c.name === "string" ? c.name.trim() : "";
      if (!name) { errs.push(`${label}.name is required`); return; }
      if (!COLUMN_TYPES[c.type]) { errs.push(`${label} ("${name}"): type must be one of ${COLUMN_TYPE_NAMES.join(", ")} (got ${JSON.stringify(c.type)})`); return; }
      if (seen.has(name.toLowerCase())) { errs.push(`${label}: duplicate column name "${name}"`); return; }
      seen.add(name.toLowerCase());
      cols.push({ name, type: c.type });
    });
    const titles = cols.filter((c) => c.type === "title");
    if (cols.length === columns.length && titles.length !== 1) {
      errs.push(`exactly one column must have type "title" (found ${titles.length})`);
    }
  }

  const outRows = [];
  if (!Array.isArray(rows) || !rows.length) {
    errs.push("rows is required: a non-empty array of objects keyed by column name");
  } else if (rows.length > MAX_ROWS) {
    errs.push(`too many rows (${rows.length}); the limit is ${MAX_ROWS} per call`);
  } else if (!errs.length) {
    const byName = new Map(cols.map((c) => [c.name, c]));
    rows.forEach((row, i) => {
      if (!isObj(row)) { errs.push(`rows[${i}] must be an object keyed by column name`); return; }
      const props = {};
      for (const key of Object.keys(row)) {
        if (!byName.has(key)) { errs.push(`rows[${i}]: "${key}" isn't a declared column (columns: ${cols.map((c) => c.name).join(", ")})`); continue; }
        const col = byName.get(key);
        const cell = convertCell(col.type, row[key]);
        if (cell.error) errs.push(`rows[${i}].${key} ${cell.error}`);
        else if (!cell.skip) props[key] = cell.value;
      }
      outRows.push(props);
    });
  }

  if (errs.length) throw new DatasetError(errs);

  const schema = {};
  for (const c of cols) schema[c.name] = COLUMN_TYPES[c.type][1];
  return { title, columns: cols, schema, rows: outRows };
}

// A stand-in for getDatabaseSchema() (views.js) built from the declared
// columns, so chart settings can be validated BEFORE anything is written.
// Property ids are the column names; the real ids only exist once Notion has
// created the database.
export function syntheticSchema(columns) {
  const properties = {};
  const propertiesById = {};
  for (const c of columns) {
    const entry = { id: c.name, name: c.name, type: COLUMN_TYPES[c.type][0] };
    properties[c.name] = entry;
    propertiesById[c.name] = entry;
  }
  return {
    database_id: "<new database id>",
    data_source_id: "<new data source id>",
    data_source_name: null,
    properties,
    propertiesById,
  };
}
