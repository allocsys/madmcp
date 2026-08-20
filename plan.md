# Plan: GitHub Codespaces connector for madmcp

Goal: add tools to create/list/start/stop/delete GitHub Codespaces,
following the existing `connectors/github/*` module pattern exactly
(see `repo_mgmt.js` as the closest analog — same REST-CRUD shape).

Do these steps in order. Each step should be a separate commit.

---

## Step 0 — Confirm auth scope (no code)

- `GITHUB_TOKEN` (config.js) is the credential every tool below will use —
  same token as the rest of `connectors/github/`, NOT the separate
  `app_auth.js` GitHub App (that one is scoped to `contents:read` only,
  for private-repo clone tokens, and can't be reused here).
- The PAT backing `GITHUB_TOKEN` needs the **`codespace`** scope. Verify
  this before writing tools, e.g. `GET /user/codespaces` with the current
  token — a 403/insufficient-scope response means the token needs to be
  reissued with `codespace` added.
- No config.js changes expected — codespaces use the same
  `GITHUB_API`/throttle/retry constants already defined there.

## Step 1 — `connectors/github/codespaces.js`: read-only tools first

Create the file with `register(server)` export, same shape as
`repo_mgmt.js`. Implement read-only tools first so they can be tested
against a live token with zero side effects:

- `list_codespaces` — `GET /user/codespaces` (optionally
  `?repository_id=` if scoping to one repo; needs a repo-id lookup first
  via `GET /repos/{owner}/{repo}` if we want to accept `owner`/`repo`
  params instead of a raw id).
- `get_codespace` — `GET /user/codespaces/{codespace_name}`.

Use `DEFAULT_OWNER` for optional `owner` params, matching every other
module's convention.

## Step 2 — Write/lifecycle tools

Add to the same file:

- `create_codespace` — `POST /repos/{owner}/{repo}/codespaces`
  (params: `ref`/branch, `machine` type, `devcontainer_path`). Consider
  a confirmation-friendly return (name, state, web_url) rather than the
  full payload.
- `start_codespace` — `POST /user/codespaces/{codespace_name}/start`.
- `stop_codespace` — `POST /user/codespaces/{codespace_name}/stop`.
- `delete_codespace` — `DELETE /user/codespaces/{codespace_name}`.
  Irreversible — word the tool description like `delete_repo`'s ("use
  with caution") and return a 🗑️-prefixed confirmation string.
- `list_codespace_machines` — `GET /repos/{owner}/{repo}/codespaces/machines`
  (lets a caller pick a valid `machine` value before create). Part of v1,
  not deferred — add it in the same commit as the other lifecycle tools.

## Step 3 — Register the module

In `connectors/github/tools.js`:
- add `import { register as registerCodespaces } from "./codespaces.js";`
- add `registerCodespaces(server);` inside `register(server)`.

Keep alphabetical/grouping style consistent with the existing import list.

## Step 4 — Tests: `test/github-codespaces.test.js`

Follow `test/github-files.test.js` conventions:
- `vi.mock("../connectors/github/client.js", () => ({ githubRequest: vi.fn() }))`
- fake server via `makeFakeServer()` capturing `server.tools[name]`
- cover per tool: happy path (correct endpoint/method/body), and at
  least one error path (e.g. 404 on `get_codespace`,
  insufficient-scope 403 surfaced clearly, not swallowed)
- for `create_codespace`, assert the POST body only includes params
  that were actually passed (optional params shouldn't send `undefined`
  keys)

## Step 5 — Docs

- `docs/API_KEYS.md` — note the `codespace` scope requirement next to
  wherever `GITHUB_TOKEN` scopes are already documented.
- `README.md` — add codespaces tools to the tool list if the other
  GitHub tools are enumerated there (check first; mirror existing
  format).

## Step 6 — Manual smoke test

Against a real (throwaway/test) repo:
1. `create_codespace` → confirm `state` and `web_url` come back sane.
2. `list_codespaces` → confirm it appears.
3. `stop_codespace` → confirm state changes.
4. `start_codespace` → confirm it comes back up.
5. `delete_codespace` → confirm it's gone from `list_codespaces`.

Note any GitHub-side async delays (codespace creation is not
instant — similar caveat to `fork_repo`'s async note) in the tool
descriptions if observed.

## Step 7 — Deploy

- Confirm `render.yaml`/`vercel.json` need no changes (no new env vars
  beyond the scope on the existing `GITHUB_TOKEN`).
- Deploy, re-run Step 6 against the deployed instance.
