import { mutate } from "swr";
import type { Session } from "@open-inspect/shared";

export const SESSIONS_PAGE_SIZE = 50;
export const SIDEBAR_SESSIONS_KEY = buildSessionsPageKey({
  excludeStatus: "archived",
  limit: SESSIONS_PAGE_SIZE,
  offset: 0,
});

export interface SessionListResponse {
  sessions: Session[];
  hasMore: boolean;
}

export function buildSessionsPageKey({
  limit = SESSIONS_PAGE_SIZE,
  offset = 0,
  status,
  excludeStatus,
}: {
  limit?: number;
  offset?: number;
  status?: string;
  excludeStatus?: string;
}) {
  const searchParams = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  });

  if (status) {
    searchParams.set("status", status);
  }

  if (excludeStatus) {
    searchParams.set("excludeStatus", excludeStatus);
  }

  return `/api/sessions?${searchParams.toString()}`;
}

export function applyTitleUpdate(
  data: SessionListResponse | undefined,
  sessionId: string,
  title: string,
  updatedAt: number
): SessionListResponse | undefined {
  if (!data) return data;
  const existing = data.sessions.find((s) => s.id === sessionId);
  if (!existing || existing.title === title) return data;
  return {
    ...data,
    sessions: data.sessions.map((session) =>
      session.id === sessionId ? { ...session, title, updatedAt } : session
    ),
  };
}

export function mutateSidebarTitle(
  sessionId: string,
  title: string,
  updatedAt: number = Date.now()
) {
  return mutate<SessionListResponse>(
    SIDEBAR_SESSIONS_KEY,
    (current) => applyTitleUpdate(current, sessionId, title, updatedAt),
    { revalidate: false }
  );
}

export function mergeUniqueSessions(existing: Session[], incoming: Session[]) {
  const seen = new Set(existing.map((session) => session.id));
  const merged = [...existing];

  for (const session of incoming) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }

  return merged;
}

export function removeSessionFromList(sessions: Session[], sessionId: string) {
  return sessions.filter((session) => session.id !== sessionId);
}
