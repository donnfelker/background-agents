# Signed Commits via GitHub API — Investigation & Implementation Plan

Conversation export covering analysis of the current `git push` flow, why commits
are unverified, how Dependabot-style signed commits work, and a milestone-based
implementation plan.

---

## User

I want you to look and inspect this code base at a very deep level. You are a git optimization expert. The problem that we are currently having is that the commits are not signed by the author or the bot. We have a rule on our GitHub organization stating that all commits must be signed and verified. I believe this is because the sandbox uses get push when it should be using the Git API, like Dependabot does so that the commits show up as verified and signed. Furthermore, this will show that the bot is who made the commit. We also need to add a new coauthor line to show that the author who was working on the commit with the bot gets credit for this as well. Analyze this code base deeply to find where this change should be made. Most likely, it should be made inside of the sandbox. We should not be performing any of the push or anything like that from the control plane the sandbox should be doing all of the Git operations, formulate a plan for how to implement this, as well as how to implement support for coauthoring inside of the commit prompt for the actual author of the code.

## Assistant

### Findings

**Who creates commits today**: OpenCode (the agent) runs `git commit` as a tool call inside the sandbox during prompt execution. The bridge never commits itself — it only configures git identity then `git push`es at PR-creation time.

**Why commits are unverified**:
- `bridge.py:1573–1620` sets `user.name`/`user.email` to the *prompting user's* `scmName`/`scmEmail` (with `OpenInspect <open-inspect@noreply.github.com>` as fallback at `bridge.py:38`).
- `bridge.py:1476–1485` then runs `git push https://x-access-token:<token>@github.com/owner/repo.git HEAD:refs/heads/<branch>`.
- Because the commits are made locally inside the sandbox with no GPG/SSH key, GitHub renders them as **unverified** even though the push itself is authenticated as the GitHub App.
- Org policy rejects unverified commits → PR blocked.

**The push path**:
- `pull-request-service.ts:153–162` builds a `GitPushSpec` and calls `pushBranchToRemote`.
- `sandbox-events.ts:251–297` ships the spec over WebSocket as `{type:"push", pushSpec}`.
- `bridge.py:579 → _handle_push` does the actual `git push`. ✅ already in the sandbox.

**Co-author**: The bridge already receives `author.scmName`/`author.scmEmail` in the `prompt` command (`bridge.py:608–614`, `message-queue.ts:199–203`), so the data we need is already flowing. It's just used in the wrong place.

**No existing GitHub Git Data / GraphQL usage** in the repo. GitHub App has `Contents: Read & Write` already (`docs/GETTING_STARTED.md:214`), which is sufficient.

### How Dependabot does it (the right primitive)

To get auto-signed, GitHub-attributed commits, you cannot just push refs that you constructed locally and you cannot use the REST `/git/commits` endpoint (those aren't signed). You have to use the **GraphQL `createCommitOnBranch` mutation** with a GitHub App installation token. When a GitHub App calls it, GitHub:

- Signs the resulting commit with its own GPG key → **Verified** badge.
- Sets the author/committer to `<app-slug>[bot] <id+app-slug[bot]@users.noreply.github.com>`.
- Returns the new commit SHA atomically (CAS via `expectedHeadOid`).

`Co-authored-by: Name <email>` trailers in the message body get rendered by GitHub as additional avatars on the PR, giving the human credit.

### High-level architecture

Replace the `git push` call in `_handle_push` with a `signed_push` flow that lives **entirely in the bridge**. The control plane's only job stays the same: mint a fresh installation token and tell the bridge "push branch X for repo Y, using this token, crediting this user."

```
[control plane]
  pull-request-service builds SignedPushSpec {
    mode: "signed-graphql",
    token, owner, name, targetBranch,
    coAuthor: { name, email }   ← from prompting participant
  }
       │ WebSocket {type:"push", pushSpec}
       ▼
[sandbox bridge]  _handle_push
  1. git fetch origin <baseBranch>
  2. local_commits = git log base..HEAD --reverse  (the commits OpenCode just made)
  3. ensure remote branch exists (create from base via REST git/refs if needed)
  4. expectedHeadOid = current remote tip of target branch
  5. for each local commit, in order:
       a. compute file additions/deletions vs parent (git diff-tree -r -z)
       b. read file blobs, base64-encode additions
       c. rewrite message: append "Co-authored-by: <name> <email>" if not present
       d. POST GraphQL createCommitOnBranch with expectedHeadOid
       e. expectedHeadOid = new SHA from response
  6. git fetch origin <targetBranch> && git reset --hard FETCH_HEAD
     (local branch now matches the signed commits on the server)
  7. emit push_complete with new head SHA
```

---

## User

If the GitHub app has commit access to write does it need to use graphql or does it already do that now (use graphql). Or does the app go through the api?

## Assistant

Permission and signing are two different things.

**The App's `Contents: Read & Write` permission is what authorizes it to write — it does NOT determine whether the commit gets signed.** Signing depends on *which endpoint* you call.

Three ways an App can create a commit, all using the same installation token:

| Method | Signed by GitHub? | Used in this codebase? |
|---|---|---|
| `git push` over HTTPS (basic auth with `x-access-token`) | ❌ No — the commit was made locally on your machine; GitHub just accepts the ref update | ✅ This is what `bridge.py:1476` does today |
| REST `POST /repos/{owner}/{repo}/git/commits` | ❌ No, unless you supply your own GPG/SSH signature | ❌ Not used |
| REST `PUT /repos/{owner}/{repo}/contents/{path}` | ✅ Yes, auto-signed by GitHub as the App | ❌ Not used |
| GraphQL `createCommitOnBranch` mutation | ✅ Yes, auto-signed by GitHub as the App | ❌ Not used |

So **no, the App is not using GraphQL today** — it's authenticated via the token but is just doing a vanilla `git push`. The commit objects themselves were built locally inside the sandbox by OpenCode with no signing key, so GitHub has nothing to verify and renders them as Unverified. The App's write permission is what allows the push to succeed at all, but it doesn't retroactively sign commits that arrived over the wire pre-built.

To get the green "Verified" badge with the bot as author, you must have GitHub *construct* the commit object server-side. The two server-side construction APIs are GraphQL `createCommitOnBranch` and REST Contents. GraphQL is the right choice here because:

- It takes a batch of file additions/deletions in one call, so a multi-file commit is one round trip. The Contents endpoint is one HTTP call per file with no atomicity across files.
- It supports an `expectedHeadOid` for optimistic CAS — safer when something else might push.
- It's what Dependabot/Renovate use for the same reason.

REST Contents would work for very simple single-file changes but it's awkward for an agent that touches dozens of files per commit.

**Bottom line for the plan**: the permission is already fine; the change is replacing the `git push` call in `_handle_push` with GraphQL `createCommitOnBranch` calls (one per local commit). No GitHub App reconfiguration needed.

---

## User

Create a plan for how this should be implemented

## Assistant

# Implementation Plan: Signed Commits via GraphQL

## Scope

Replace the bridge's `git push` over HTTPS with `createCommitOnBranch` GraphQL calls, executed entirely inside the sandbox. Append `Co-authored-by` trailers crediting the prompting user. Behind a flag, keep HTTPS push as fallback.

Branch: `claude/signed-commits-git-api-nwwsX`

---

## Milestone 1 — Build the signed-push module (no wiring)

Goal: a fully unit-tested Python module the bridge can later call. No behavior change yet.

### New file: `packages/sandbox-runtime/src/sandbox_runtime/git_signed_push.py`

Public API:

```python
@dataclass(frozen=True)
class CoAuthor:
    name: str
    email: str

@dataclass(frozen=True)
class FileAddition:
    path: str
    contents_b64: str  # base64-encoded UTF-8 or binary

@dataclass(frozen=True)
class FileDeletion:
    path: str

@dataclass(frozen=True)
class LocalCommit:
    sha: str
    parent_sha: str
    message: str
    additions: list[FileAddition]
    deletions: list[FileDeletion]

@dataclass(frozen=True)
class SignedPushResult:
    new_head_oid: str
    commits_created: list[str]  # new (signed) SHAs in order

async def signed_push(
    *,
    http: httpx.AsyncClient,
    repo_dir: pathlib.Path,
    token: str,
    owner: str,
    name: str,
    target_branch: str,
    base_branch: str,
    co_author: CoAuthor | None,
    graphql_url: str = "https://api.github.com/graphql",
    rest_base_url: str = "https://api.github.com",
    log: structlog.BoundLogger,
) -> SignedPushResult: ...
```

Internal helpers (each independently testable):

- `enumerate_local_commits(repo_dir, base_sha) -> list[LocalCommit]` — runs `git rev-list --reverse <base>..HEAD`, then for each SHA: `git log -1 --format=%B%n%H%n%P` and `git diff-tree --no-renames -r -z <sha>`. Reads blob bytes for added/modified files, base64-encodes.
- `apply_coauthor_trailer(message, co_author) -> str` — idempotent. Skips if `Co-authored-by: <name> <email>` already present (case-insensitive match). Adds a blank line before the trailer block if missing per git-interpret-trailers conventions.
- `resolve_base_sha(http, token, owner, name, target_branch, base_branch) -> tuple[str, bool]` — returns `(sha, branch_exists)`. If target branch exists on remote, its tip is the base; otherwise, base branch's tip is the starting point and we'll need to create the ref.
- `create_branch_ref(http, token, owner, name, target_branch, sha)` — REST `POST /repos/{owner}/{repo}/git/refs`.
- `create_commit_on_branch(http, token, owner, name, branch, expected_head_oid, message, additions, deletions) -> str` — single GraphQL call. Returns new commit OID.
- `with_oid_retry(coro_factory, *, max_attempts=3)` — re-resolves `expectedHeadOid` and retries on `STALE_DATA`-class errors.

Behavior:
- All HTTP errors raise `SignedPushError` with `is_transient: bool`.
- GraphQL `userErrors` array is checked; non-empty → raise.
- Maximum 64MB per commit's total addition payload (warn + abort cleanly if exceeded — v1 doesn't chunk).

### New tests: `packages/sandbox-runtime/tests/test_git_signed_push.py`

Mock `httpx.AsyncClient` using `respx`. Cover:
- Trailer insertion idempotency (3 cases: absent, present once, present multiple times)
- Trailer separation by blank line when message body has no existing trailers
- `enumerate_local_commits` against a temp git repo fixture (create commits, assert payloads)
- Binary file addition (correct base64, no mojibake)
- File deletion + modification in same commit
- New branch creation path (ref doesn't exist → POST to git/refs → GraphQL)
- Existing branch path (ref exists → straight to GraphQL)
- Stale `expectedHeadOid` triggers one retry then succeeds
- GraphQL error response surfaces cleanly

**Exit criteria**: `pytest packages/sandbox-runtime/tests/test_git_signed_push.py -v` green.

---

## Milestone 2 — Extend the push spec types (control plane, no behavior change)

### Edit `packages/control-plane/src/source-control/types.ts`

Convert `GitPushSpec` to a discriminated union:

```ts
export type GitPushSpec =
  | HttpsGitPushSpec
  | SignedGraphQlGitPushSpec;

export interface HttpsGitPushSpec {
  mode: "https";
  remoteUrl: string;
  redactedRemoteUrl: string;
  refspec: string;
  targetBranch: string;
  force: boolean;
}

export interface SignedGraphQlGitPushSpec {
  mode: "signed-graphql";
  graphqlUrl: string;        // https://api.github.com/graphql
  restBaseUrl: string;       // https://api.github.com
  token: string;             // GitHub App installation token (short-lived)
  redactedToken: string;     // "<redacted>" — for logs
  owner: string;
  name: string;
  targetBranch: string;
  baseBranch: string;        // for first push (branch creation)
  coAuthor: { name: string; email: string } | null;
}
```

Extend `BuildGitPushSpecConfig` with:
```ts
coAuthor?: { name: string; email: string } | null;
baseBranch?: string;
```

### Edit `packages/control-plane/src/source-control/providers/github-provider.ts`

`buildGitPushSpec` returns `SignedGraphQlGitPushSpec`. Drop the credential-in-URL form. Pass token, owner, name, target/base branch, co-author.

### Edit `packages/control-plane/src/source-control/providers/gitlab-provider.ts`

Continue returning `HttpsGitPushSpec` with `mode: "https"`.

### Edit tests
- `github-provider.test.ts` — assert new spec shape.
- `gitlab-provider.test.ts` — assert `mode: "https"` is set.

**Exit criteria**: `npm test -w @open-inspect/control-plane` green; `npm run typecheck` green across all packages.

---

## Milestone 3 — Wire the bridge dispatcher

### Edit `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`

In `_handle_push` (line 1401), branch on `push_spec.get("mode")`:

```python
mode = push_spec.get("mode", "https")  # default for back-compat
if mode == "signed-graphql":
    await self._handle_signed_push(push_spec)
    return
# else: existing HTTPS push path stays unchanged
```

Add `_handle_signed_push(push_spec)`:
1. Validate required fields; emit `push_error` on missing.
2. Resolve `repo_dir` the same way the existing handler does.
3. `git fetch origin <baseBranch>` (best-effort; needed to compute the merge base).
4. Determine base SHA: `git merge-base origin/<baseBranch> HEAD` (or fall back to `origin/<baseBranch>` if no merge-base).
5. Call `signed_push(...)` from the new module. Pass an `httpx.AsyncClient` (reuse `self.http_client` if available).
6. On success: `git fetch origin <targetBranch>` then `git reset --hard FETCH_HEAD` so local matches remote.
7. Emit `push_complete` (with the new HEAD oid in the event payload).
8. On failure: emit `push_error` with redacted message.

### Redaction
Reuse the `_redact_git_stderr` pattern. Add the App token to the redaction set so it never appears in logs.

### Tests: `packages/sandbox-runtime/tests/test_bridge_push.py`
Add cases for the signed-graphql path:
- Happy path (mock `signed_push`, assert events emitted, assert `git reset --hard` invoked)
- Module raises `SignedPushError` → `push_error` event with redacted message
- Missing required spec fields → validation `push_error`
- HTTPS path still works (existing tests)

**Exit criteria**: bridge tests green. End-to-end smoke test on a scratch repo (manual).

---

## Milestone 4 — Plumb co-author from the prompting participant

### Edit `packages/control-plane/src/session/pull-request-service.ts`

Around line 153 (before `buildGitPushSpec`), resolve the prompting user's identity:

```ts
const prompterParticipant = await this.deps.repository.getParticipantById(promptingParticipantId);
const coAuthor = resolveCoAuthor(prompterParticipant, this.deps.sourceControlProvider.name);
```

New helper (same file, or `co-author.ts`):

```ts
function resolveCoAuthor(p: ParticipantRow | null, providerName: string): { name: string; email: string } | null {
  if (!p) return null;
  const name = p.scm_name ?? p.scm_login;
  if (!name) return null;
  const email = p.scm_email
    ?? (providerName === "github" && p.scm_user_id && p.scm_login
        ? `${p.scm_user_id}+${p.scm_login}@users.noreply.github.com`
        : null);
  if (!email) return null;
  return { name, email };
}
```

The `<id>+<login>@users.noreply.github.com` fallback is GitHub's privacy-preserving address. It still links the co-author trailer to the right GitHub account on the PR page.

Pass `coAuthor` and `baseBranch` into `buildGitPushSpec`.

### Tests: `packages/control-plane/src/session/pull-request-service.test.ts`
- Co-author resolved from `scm_name` + `scm_email`
- Co-author falls back to noreply email when `scm_email` is null
- Co-author is `null` when participant has neither name nor login
- Multiple prompts in session → uses prompter of the message that triggered the PR

**Exit criteria**: `npm test -w @open-inspect/control-plane` green.

---

## Milestone 5 — Per-prompt author tracking (multi-user sessions)

When user A and user B both prompt the same session before a PR is created, each commit should be credited to the right person. The single `coAuthor` field on the push spec isn't enough.

### Edit `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`

In `_handle_prompt` (line 590), before invoking OpenCode:

```python
pre_prompt_sha = await self._git_head_sha()
self._prompt_attributions.append(
    PromptAttribution(
        from_sha_exclusive=pre_prompt_sha,
        co_author=CoAuthor(name=scm_name, email=scm_email) if scm_name and scm_email else None,
    )
)
```

Where `self._prompt_attributions: list[PromptAttribution]` is an instance attribute. It maps a SHA boundary to the user who prompted the work that produced commits past that boundary.

### Edit `git_signed_push.py`

`signed_push` accepts `attributions: list[PromptAttribution]` instead of a single `co_author`. For each enumerated local commit, find the attribution whose `from_sha_exclusive` is an ancestor and apply that trailer.

Helper: `git merge-base --is-ancestor <attr.from_sha> <commit.sha>` to determine membership.

### Push spec
The push spec from control plane still carries the *primary* co-author (the user who triggered the PR creation). The bridge merges it with its own `_prompt_attributions` list — primary wins for any commit not already attributed by the in-bridge log.

**Exit criteria**: new test covering A-prompts-then-B-prompts → commits get separate trailers.

> If multi-user sessions are rare, Milestone 5 can ship later; Milestone 4 is sufficient for the single-prompter case.

---

## Milestone 6 — Agent-side hint (best-effort, optional)

So the agent's *local* commit messages already look right during the working loop.

### Edit `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py`

After cloning the repo and before launching OpenCode, append a short instruction to the workspace `AGENTS.md` (create if missing):

```
## Commit attribution

When you create a git commit, include this trailer at the end of the message so the
human collaborator who initiated the work gets credit on GitHub:

Co-authored-by: <name> <email>

Use the name and email of the user whose prompt you are responding to. If you don't
know them, omit the trailer — the system will add it automatically.
```

The name/email come from the same source as `_configure_git_identity` (the prompt's `author` field). Since this is generated per-session, write it once at startup using whatever identity is known then; the bridge's signed-push step is the authoritative enforcement.

This milestone is purely cosmetic for local logs and is skippable if controversial.

---

## Milestone 7 — Feature flag and rollout

### Flag

Add `OPEN_INSPECT_SIGNED_PUSH` env var to the control plane. When unset or `0`, providers emit `mode: "https"` (legacy). When `1`, GitHub provider emits `mode: "signed-graphql"`.

This lets us:
1. Merge the code with the flag off.
2. Flip on for a test org/repo.
3. Verify Verified badge + Co-authored-by rendering on a real PR.
4. Flip on globally.
5. Remove the flag + HTTPS path for GitHub in a follow-up.

### Operational verification

Manual test plan to run after Milestone 3:
- Create a session against a repo that requires signed commits.
- Prompt the agent to make a change.
- Click "Create PR".
- Assert:
  - PR exists.
  - Commit shows the Verified badge.
  - Commit author is `<app-slug>[bot]`.
  - PR shows the prompting user as a co-author (avatar + name).
  - `git log` of the remote shows `Co-authored-by:` trailer.

---

## File change summary

| File | Type | Purpose |
|---|---|---|
| `packages/sandbox-runtime/src/sandbox_runtime/git_signed_push.py` | NEW | GraphQL push module |
| `packages/sandbox-runtime/tests/test_git_signed_push.py` | NEW | Module tests |
| `packages/sandbox-runtime/src/sandbox_runtime/bridge.py` | EDIT | Dispatch + new handler |
| `packages/sandbox-runtime/tests/test_bridge_push.py` | EDIT | Dispatcher tests |
| `packages/control-plane/src/source-control/types.ts` | EDIT | Discriminated union spec |
| `packages/control-plane/src/source-control/providers/github-provider.ts` | EDIT | Emit signed-graphql spec |
| `packages/control-plane/src/source-control/providers/gitlab-provider.ts` | EDIT | Tag `mode: "https"` |
| `packages/control-plane/src/source-control/providers/github-provider.test.ts` | EDIT | Spec shape |
| `packages/control-plane/src/session/pull-request-service.ts` | EDIT | Resolve + pass co-author |
| `packages/control-plane/src/session/pull-request-service.test.ts` | EDIT | Co-author cases |
| `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py` | EDIT (M6) | AGENTS.md hint |

No new dependencies (httpx already in sandbox-runtime; respx is the test mock layer if not already present — confirm before M1).

---

## Risks & open questions to flag during review

- **Renames**: GraphQL has no rename; we emit `delete(old)` + `add(new)`. Acceptable but bloats blob payloads.
- **Submodules / symlinks / executable bits**: each addition takes an optional `fileMode`. The enumerator must preserve it from `git ls-tree`.
- **Empty commits**: GraphQL rejects commits with no changes. The enumerator skips them.
- **Merge commits**: created locally by the agent (rare). `createCommitOnBranch` makes a single-parent commit. We collapse merge commits to linear by detecting and refusing in v1 — surface as `push_error`.
- **Token expiry mid-push**: installation tokens last 1 hour. If a push takes longer (very large batch) we'd need to mint mid-flight. v1 assumes single token suffices; add expiry-aware refresh later.
- **Cost**: each commit = one GraphQL call + base64-encoded blob payload. For a 50-commit PR that's 50 calls — still fast, just worth noting.
