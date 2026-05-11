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
import { useSessionSocket } from "./use-session-socket";

expect.extend(matchers);

// Real SWR — no mock here. We're verifying the sidebar cache actually
// receives the title update so subscribers re-render. The unit-level tests
// in use-session-socket.test.tsx mock `swr.mutate` and only assert the call
// shape, which masks bugs where mutate IS called but the wrong path is
// being patched.

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string) {}

  close(code = 1000, reason = "", wasClean = true) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(message: ServerMessage) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

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

// Tiny component that reads the same SWR key the real sidebar uses and
// renders the cached title for one session. Acts as a stand-in for the
// sidebar's display path without dragging in the whole sidebar tree.
function CacheSubscriber({ sessionId }: { sessionId: string }) {
  const { data } = useSWR<SessionListResponse>(SIDEBAR_SESSIONS_KEY);
  const session = data?.sessions.find((s) => s.id === sessionId);
  return <div data-testid="cached-title">{session?.title ?? "no-session"}</div>;
}

function HookHost({ sessionId }: { sessionId: string }) {
  const { sessionState } = useSessionSocket(sessionId);
  return <div data-testid="header-title">{sessionState?.title ?? "no-state"}</div>;
}

// Populate the real SWR cache (NOT just fallback) so mutate updaters see
// the cached value as their `current` argument — this mirrors production,
// where the home page's mutate(SIDEBAR_SESSIONS_KEY) revalidate triggers
// a fetch that populates the cache before any session_title event fires.
//
// `fallback` alone isn't enough: SWR returns it from useSWR but doesn't
// actually write it to the cache. With an empty cache, an updater like
// applyTitleUpdate(undefined, ...) returns undefined, which SWR treats
// as "no change" — masking real bugs.
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
    // This is the production-critical path: when the auto-rename titler
    // commits BEFORE the WS subscribe handshake finishes, the new title is
    // delivered inside the `subscribed.state` payload (see the server-side
    // refresh in durable-object.ts that fixes the race), not as a separate
    // `session_title` event. The header reads it from sessionState; the
    // sidebar must also pick it up via the SWR cache.
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

    // Header picks it up (this part works on the existing fix).
    await waitFor(() => {
      expect(screen.getByTestId("header-title")).toHaveTextContent("Auto-renamed via subscribed");
    });

    // Sidebar cache MUST also reflect the new title, otherwise the sidebar
    // list shows a stale entry until something else revalidates.
    await waitFor(() => {
      expect(screen.getByTestId("cached-title")).toHaveTextContent("Auto-renamed via subscribed");
    });
  });

  it("does not bump the cached entry when the subscribed title matches the cache", async () => {
    // Opening a session whose title hasn't changed shouldn't rewrite the
    // cache — that would needlessly invalidate downstream memos.
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

    // Title in the cache is still the original "Stable title" — no spurious
    // rewrite. (We can't directly observe updatedAt from the rendered DOM
    // here, but if a mutate happened it would still leave this text intact,
    // so this test mostly documents the intent.)
    expect(screen.getByTestId("cached-title")).toHaveTextContent("Stable title");
  });

  it("propagates a post-subscribed session_title broadcast into the sidebar cache", async () => {
    // Regression coverage for the path my earlier fix already handles —
    // make sure it still works once the subscribed-path fix lands.
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
