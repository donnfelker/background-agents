// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import useSWR, { mutate, SWRConfig } from "swr";
import type {
  ServerMessage,
  Session,
  SessionState as SharedSessionState,
} from "@open-inspect/shared";
import { SIDEBAR_SESSIONS_KEY, type SessionListResponse } from "@/lib/session-list";
import { FakeWebSocket } from "./test-fixtures";
import { useSessionSocket } from "./use-session-socket";

expect.extend(matchers);

// Uses real SWR (no mock) so cache mutations are observable end-to-end.

function createSessionState(overrides: Partial<SharedSessionState> = {}): SharedSessionState {
  return {
    id: "session-1",
    title: "Session 1",
    repoOwner: "acme",
    repoName: "web-app",
    baseBranch: "main",
    branchName: "feature/x",
    status: "active",
    sandboxStatus: "ready",
    messageCount: 0,
    createdAt: 1,
    ...overrides,
  };
}

function createSubscribedMessage(state: SharedSessionState): ServerMessage {
  return {
    type: "subscribed",
    sessionId: state.id,
    state,
    artifacts: [],
    participantId: "participant-1",
    participant: { participantId: "participant-1", name: "Test User" },
    replay: { events: [], hasMore: false, cursor: null },
    spawnError: null,
  };
}

function createCachedSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    title: "Old cached title",
    repoOwner: "acme",
    repoName: "web-app",
    parentSessionId: null,
    spawnSource: "user",
    spawnDepth: 0,
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  } as Session;
}

function CacheSubscriber({ sessionId }: { sessionId: string }) {
  const { data } = useSWR<SessionListResponse>(SIDEBAR_SESSIONS_KEY);
  const session = data?.sessions.find((s) => s.id === sessionId);
  return <div data-testid="cached-title">{session?.title ?? "no-session"}</div>;
}

function HookHost({ sessionId }: { sessionId: string }) {
  const { sessionState } = useSessionSocket(sessionId);
  return <div data-testid="header-title">{sessionState?.title ?? "no-state"}</div>;
}

// Populate the real SWR cache (fallback alone isn't written to the cache,
// so updaters see `undefined` and SWR treats their return as no-op).
async function renderHarness(sessionId: string, cached: Session[]) {
  await mutate<SessionListResponse>(
    SIDEBAR_SESSIONS_KEY,
    { sessions: cached, hasMore: false },
    { revalidate: false }
  );
  return render(
    <SWRConfig
      value={{
        dedupingInterval: 0,
        revalidateOnFocus: false,
      }}
    >
      <HookHost sessionId={sessionId} />
      <CacheSubscriber sessionId={sessionId} />
    </SWRConfig>
  );
}

describe("useSessionSocket → sidebar SWR cache propagation", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ token: "ws-token" }))
    );
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("client-id");
  });

  afterEach(async () => {
    cleanup();
    // Clear the default SWR cache so state doesn't leak between tests.
    await mutate(SIDEBAR_SESSIONS_KEY, undefined, { revalidate: false });
    vi.restoreAllMocks();
  });

  it("propagates a subscribed-delivered title into the sidebar SWR cache", async () => {
    await renderHarness("session-1", [createCachedSession({ title: "Old cached title" })]);

    await waitFor(() => {
      expect(screen.getByTestId("cached-title")).toHaveTextContent("Old cached title");
    });

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(
        createSubscribedMessage(createSessionState({ title: "Auto-renamed via subscribed" }))
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("header-title")).toHaveTextContent("Auto-renamed via subscribed");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cached-title")).toHaveTextContent("Auto-renamed via subscribed");
    });
  });

  it("does not bump the cached entry when the subscribed title matches the cache", async () => {
    await renderHarness("session-1", [createCachedSession({ title: "Stable title" })]);

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage(createSessionState({ title: "Stable title" })));
    });

    await waitFor(() => {
      expect(screen.getByTestId("header-title")).toHaveTextContent("Stable title");
    });

    expect(screen.getByTestId("cached-title")).toHaveTextContent("Stable title");
  });

  it("propagates a post-subscribed session_title broadcast into the sidebar cache", async () => {
    await renderHarness("session-1", [createCachedSession({ title: "Old cached title" })]);

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
      socket.receive(createSubscribedMessage(createSessionState({ title: "Old cached title" })));
    });

    act(() => {
      socket.receive({ type: "session_title", title: "Renamed after subscribe" });
    });

    await waitFor(() => {
      expect(screen.getByTestId("cached-title")).toHaveTextContent("Renamed after subscribe");
    });
  });
});
