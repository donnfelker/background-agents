import type { SessionRow } from "./types";

export function createTestSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: null,
    title: "Session Title",
    repo_owner: "acme",
    repo_name: "repo",
    repo_id: 123,
    base_branch: "main",
    branch_name: "feature/test",
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "anthropic/claude-haiku-4-5",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
    spawn_depth: 0,
    code_server_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    title_manually_set: 0,
    title_auto_rename_attempted_at: null,
    created_at: 1000,
    updated_at: 2000,
    ...overrides,
  };
}
