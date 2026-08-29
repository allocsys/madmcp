# madmcp tool-improvement plan

Source: a `delegate_agent` investigation into ways to improve the MCP tools this
server exposes. Its raw findings were then manually verified against the actual
code before being recorded here — several were confirmed, some were already
solved elsewhere in the codebase, and one was not implementable at all. Only
verified, still-open items should be treated as real backlog.

## Confirmed, still open

### 1. Pagination defaults are genuinely inconsistent
`per_page`/`limit` defaults vary with no documented reason:
- `default: 10` — `github/actions.js` (`list_workflow_runs`), `github/releases.js`
  (`list_releases`), `github/search.js` (`search_code`), `mem/tools.js`
  (`mem0_search`), `notion/tools.js` (`notion_query_database`, `page_size`).
- `default: 20` — `github/branches.js` (`list_commits`), `github/issues.js`
  (`list_issues`), `github/prs.js` (`get_pull_requests`), `github/releases.js`
  (`list_tags`), `github/repo.js` (`list_contributors`), `github/search.js`
  (`search_issues`), `mem/tools.js` (`mem0_list`).
- **Action:** pick one default (20 is already the majority) and one hard cap
  (100, already consistent) and align the outliers. Low risk, mechanical change.

### 2. `read_file`'s `ref` vs `get_file_at_commit`'s `commit` naming
`connectors/github/files.js` (`read_file`) takes an optional `ref` (branch, tag,
or SHA). `connectors/github/repo_mgmt.js` (`get_file_at_commit`) takes a
required `commit` (SHA only). This is a real naming split for an overlapping
concept, and it's already known internally — `agent_delegate.js` (around the
`READ_FILE_SIGNATURE_FAMILY` block) has a comment describing exactly this gap
and a partial, deliberately lightweight workaround for Gemini's *internal*
dedup logic only. That workaround does not touch the MCP-facing tool schemas
Claude/other callers see.
- **Action:** either rename `get_file_at_commit`'s param to `ref` for
  consistency (keeping it required), or explicitly document in both tools'
  descriptions that they're the same concept under different names/constraints
  so a calling model doesn't have to infer it. Small, but real.

### 3. `mem0_list`'s `include_relations` caps full traversal to the top 5 results
Confirmed in `connectors/mem/tools.js`: relation resolution (up to 3 hops) is
deliberately limited to the top 5 ranked results per call, to avoid a full
multi-hop resolution cost across an entire page. This is a reasonable
tradeoff for `mem0_list`/`mem0_search`, but there's no way to explicitly ask
for the full graph around one specific `entity_id` when that's actually what's
needed.
- **Action:** consider a narrow `mem0_get_relations(entity_id)` tool that does
  the full 3-hop resolution for exactly one entity, bypassing the top-5 cap.
  Opt-in and rare enough to not need to be the default path.

### 4. Internal Gemini-side line diff silently gives up above 2000 lines
Confirmed in `connectors/gemini/agent_delegate.js`, `simpleLineDiff()`: if
either file exceeds 2000 lines, it returns only "(files differ — too large
for line diff, showing lengths only: X vs Y lines)" with no way to see any
actual diff content. This is Gemini's own internal helper (not an MCP-facing
tool), used during `delegate_agent` investigations.
- **Action:** support a chunked/ranged diff (e.g. diffing lines 1–2000, then
  2001–4000 on request) instead of an all-or-nothing cutoff.

## Partially valid — smaller than first reported

### 5. `delegate_agent` observability
The original claim was "no way to see what a long-running investigation is
doing mid-flight." This overstates it: `delegate_agent` already supports
`show_transcript: true`, which returns the full step-by-step tool-call
transcript on completion. What's *actually* missing is a lighter-weight,
plan-level view (what Gemini intends to do next) rather than a full raw
transcript — useful mid-run, not just after the fact. Lower priority than
originally framed.

## Investigated and found invalid — do not action

### 6. "Notion page creation can fail and leave an orphaned page with no
recovery path" — **false, already handled.**
`connectors/notion/tools.js` (`notion_create_page`'s batch-append path) was
checked directly. It already:
- creates the page with the first ≤100 blocks,
- PATCHes remaining blocks in further ≤100 batches,
- on a batch failure, still records the entity_id dedup index entry (so a
  retry won't create a duplicate page),
- returns the partially-created page's id/url and explicit instructions to
  finish it via `notion_update_page` (`append_content`).

This is a deliberate, documented design (with a comment referencing a real
2026-07-25 production failure that motivated it), not a gap.

### 7. "Add a `notion_move_page` tool" — **not implementable as scoped.**
The Notion public API has no endpoint to change an existing page's parent.
There is no first-class "move" operation to wrap. This would need to be
faked as create-in-new-location + copy content + archive-old, which is the
same multi-step process an agent already has to do manually — a wrapper tool
would just hide the same steps behind one name, with added failure-mode
complexity (partial copy, archived-too-early, etc.) and no real API-level
atomicity gain. Not worth building unless Notion's API changes.

### 8. "Destructive tools (delete_repo, etc.) lack any safety rail" — **real,
but softer than framed.**
`delete_repo` (`connectors/github/repo_mgmt.js`) does execute immediately with
only a plain-language "irreversible — use with caution" description and no
`dry_run`/confirmation parameter. This part is accurate. However, several
other destructive-sounding tools already went through hardening after real
incidents (see the `notion_create_page` orphan-page handling above, and the
slug-like-title guard in `notion/tools.js` after a 2026-08-07 orphan-page
audit), suggesting the team already treats safety gaps as high priority once
found — this one just hasn't been hit yet.
- **Action:** add an explicit confirmation step (e.g. require the caller to
  pass `repo` twice, or a `confirm: true` flag) to `delete_repo` specifically.
  Lower priority for other write tools (edit_file, overwrite_files) since
  those are non-destructive to history (all via commits, revertable via git).
