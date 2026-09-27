# GitHub Tools Consolidation — Jules Task Plan

Full design rationale lives in the Notion page `plan-madmcp-github-tools-overhaul`
(linked from the madmcp Engineering Hub). This file is the execution brief for
Jules to do the **bulk mechanical work**. A human will do a **precision pass**
afterward on the items flagged below — don't try to cleverly solve those,
just leave them working-but-flagged.

## Reference implementation (already merged, main branch)

`connectors/github/releases.js` was the pilot and is now the pattern to copy:
three separate tools (`list_releases`, `create_release`, `list_tags`) merged
into one `release_manage` tool dispatched on an `action` enum. Read that file
first — every group below follows the same shape:
- one `server.tool(name, description, zodSchema, handler)` call
- `action: z.enum([...])` as the dispatch key
- `if (action === "x") { ...; return ...; }` blocks, one per original tool's
  logic, copied over close to verbatim
- params only used by some actions get a note in their `.describe()` saying
  which action(s) they apply to (see release_manage's `tag_name`,
  `per_page` for the pattern)
- no changes needed to `connectors/github/tools.js` (the orchestrator) as
  long as the file path and `export function register(server)` shape stay
  the same

## Groups to consolidate (in this order, one PR per group against `main`,
## branch off `main` fresh for each — don't stack them on one branch)

### 1. `repo_metadata` (read-only) — connectors/github/repo.js
Merge: `list_repos`, `get_repo`, `list_contributors`, `get_repo_topics` (read
path only — no `set_topics` arg) into `repo_metadata` with
`action: list | get | contributors | topics`.
Note: `list_repos`'s user-vs-org `type` remapping logic (the try/catch that
falls back from `/users/:owner/repos` to `/orgs/:owner/repos`) must be
preserved exactly — do not simplify it away.

### 2. `repo_lifecycle` (destructive) — connectors/github/repo_mgmt.js
Merge: `create_repo`, `fork_repo`, `sync_fork`, `delete_repo` into
`repo_lifecycle` with `action: create | fork | sync_fork | delete`.
Also fold `get_repo_topics`'s **write** path (the `set_topics` arg, currently
in repo.js) in here as `action: set_topics`, since it's a mutating repo-level
operation, not metadata.
Do **NOT** include `gh_token` or `get_file_at_commit` in this file — they
move elsewhere (see below).
**FLAG FOR PRECISION PASS:** `delete_repo`'s `confirm: true` safety guard.
Copy it over exactly as-is on the `delete` action (refuse + explanatory
message if `confirm !== true`) — do not touch the guard logic itself, just
make sure it survives the merge. Leave a `// PRECISION-PASS:` comment above
it either way so it's easy to find and double check.

### 3. `repo_inspect` — new file, connectors/github/repo_inspect.js
Merge: `get_file_at_commit` (repo_mgmt.js), `diff_files` (diff.js),
`search_code` (search.js), `get_branch_protection` (review_control.js),
`list_branches`, `create_branch`, `list_commits`, `get_commit` (branches.js)
into `repo_inspect` with
`action: at_commit | diff | search | branch_protection | list_branches | create_branch | list_commits | get_commit`.
This is the biggest single merge (8 source tools) — expect the widest zod
schema. Group params by which action(s) use them in `.describe()`, same as
release_manage.
**FLAG FOR PRECISION PASS:** `search_code`'s branching logic (real
`/search/code` API vs. the local tarball-grep fallback for `ref`-scoped or
private-repo-empty-result cases) is the most complex handler in the whole
connector. Copy `search.js`'s helper functions (`fallbackCodeSearch`,
`getRepoEntries`, `parseTar`, `resolveMatchLines`, etc.) over unchanged into
the new file rather than rewriting them.
Delete `connectors/github/search.js`, `connectors/github/diff.js`,
`connectors/github/branches.js` once their contents are moved (repo_mgmt.js
stays, since `create_repo`/etc. remain there per group 2 — just remove
`get_file_at_commit` from it). Update `tools.js`'s imports accordingly (this
is the one group where `tools.js` DOES need editing: remove the
`registerSearch`/`registerDiff`/`registerBranches` imports+calls, add
`registerRepoInspect`).

### 4. `pr_read` — connectors/github/prs.js (partial)
Merge: `get_pull_requests`, `get_pr_activity`, `get_pr_mergeability`
(currently in review_control.js) into `pr_read` with
`action: list | get | activity | mergeability`.
**FLAG FOR PRECISION PASS:** `get_pr_mergeability`'s poll-and-retry loop
(4 attempts, 1.2s apart, waiting on GitHub's async `mergeable` computation)
must keep its own retry budget — don't let it share a retry loop with any
other action in the merged tool.

### 5. `pr_write` — connectors/github/prs.js (rest) + review_control.js (rest)
Merge: `create_pull_request`, `update_pull_request`, `merge_pull_request`,
`review_pull_request` (prs.js) + `request_reviewers`,
`remove_requested_reviewers`, `add_review_comment` (review_control.js) into
`pr_write` with
`action: create | update | merge | review | request_reviewers | remove_reviewers | inline_comment`.
**FLAG FOR PRECISION PASS (two items):**
1. `update_pull_request`'s `ready: true` path runs a separate GraphQL
   mutation (`markPullRequestReadyForReview`) because REST has no
   draft-to-ready field — this cannot be folded into the same PATCH request
   as title/body/state/base. Keep it as a distinct branch inside the
   `update` action, exactly as it is in prs.js today.
2. `merge_pull_request` is irreversible (no unmerge via this tool) — keep
   that framing in the merged tool's top-level description, not just buried
   in the original tool's now-deleted description.
Delete `connectors/github/review_control.js` once `get_branch_protection`
(moved to group 3), `get_pr_mergeability` (moved to group 4), and the rest
(moved here) are all relocated. `list_notifications` from this file becomes
its own standalone group (see group 8) — do not fold it into pr_write.

### 6. `issue_manage` — connectors/github/issues.js + search.js (search_issues)
Merge: `get_issue`, `list_issues`, `create_issue`, `update_issue`,
`add_issue_comment` (issues.js) + `search_issues` (search.js) into
`issue_manage` with `action: get | list | create | update | comment | search`.
**FLAG FOR PRECISION PASS:** `search_issues` is cross-repo (GitHub
issue-search query syntax, no fixed `repo` param) while every other action
here is single-repo. Make `repo`/`owner` optional in the merged schema and
add an explicit note in the tool's top-level description that `action:
search` ignores them in favor of the free-form `query` string — don't let a
caller assume `repo` scopes the search.

### 7. `ci_manage` — connectors/github/actions.js + ci_control.js
Merge: `list_workflow_runs`, `get_workflow_run_logs`, `get_job_logs`
(actions.js) + `trigger_workflow`, `rerun_workflow`, `cancel_workflow_run`,
`get_check_runs`, `get_combined_status` (ci_control.js) into `ci_manage`
with `action: list | run_logs | job_logs | trigger | rerun | cancel | checks | status`.
**FLAG FOR PRECISION PASS:** three separate poll-and-retry / "sleep and
check again" behaviors live in these source tools (`list_workflow_runs`,
`get_check_runs`, `get_combined_status` all tell the calling model to sleep
30s and recheck if pending). Keep each action's own polling guidance in its
own part of the merged description — don't merge them into one generic
"this tool may need polling" note or a caller may not know which specific
call to repeat.

### 8. `codespace_manage` — connectors/github/codespaces.js
Merge: `list_codespaces`, `get_codespace`, `list_codespace_machines`,
`create_codespace`, `start_codespace`, `stop_codespace`, `delete_codespace`
into `codespace_manage` with
`action: list | get | machines | create | start | stop | delete`.
Leave `exec_in_codespace` alone — it's already separately gated behind
`CODE_EXEC_ENABLED` and not registered by default; don't fold a
conditionally-registered tool into an always-registered one. If you want,
register it as an additional standalone tool guarded the same way it is
today, in the same file.

### 9. `notifications` — connectors/github/review_control.js → new home
`list_notifications` becomes its own standalone tool in a new small file
(e.g. `connectors/github/notifications.js`). It's user/global-scoped
(cross-repo inbox), unlike everything else that was in review_control.js —
don't merge it into any of the repo-scoped groups above.

## Explicitly OUT OF SCOPE — do not touch

- `connectors/github/files.js` (`read_file`, `list_directory`,
  `get_file_tree`, `create_repo_file`, `edit_file`, `delete_file`,
  `rename_file`, `overwrite_files`) — highest-traffic tools, each with
  distinct heavily-used param shapes. Stay exactly as they are.
- `connectors/github/clone_token.js` (`gh_token`) — stays standalone. Do not
  fold into `repo_lifecycle` or anywhere else; its one-time-use /
  self-revoking-credential warning needs to stay attached to its own tool
  description verbatim.

## Process notes

- One PR per group, each branched fresh off `main` (not stacked), same
  pattern as PR #213 (`github-tools-consolidation` → merged as the
  `release_manage` pilot).
- Every `// PRECISION-PASS:` comment left in the code should also show up as
  a bullet in that PR's description, so the human review pass has a
  checklist instead of having to re-grep the diff for the comments.
- Don't rename or restructure `tools.js`'s existing registration pattern
  beyond what's specified above for group 3 (`repo_inspect`) — every other
  group's target filename should exactly replace its predecessor(s) so
  `tools.js` needs no changes for those.
