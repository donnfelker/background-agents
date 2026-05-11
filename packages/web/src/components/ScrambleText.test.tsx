// @vitest-environment jsdom
/// <reference types="@testing-library/jest-dom" />

import { act, cleanup, render } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrambleText } from "./ScrambleText";

expect.extend(matchers);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setMatchMedia(matches: boolean) {
  window.matchMedia = vi.fn().mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }) as unknown as typeof window.matchMedia;
}

describe("ScrambleText", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
    });
    setMatchMedia(false);
  });

  it("renders the initial text without scrambling on mount", () => {
    const { container } = render(<ScrambleText text="Hello world" />);
    const root = container.querySelector("span[aria-label]");
    expect(root).not.toBeNull();
    expect(root).toHaveAttribute("aria-label", "Hello world");
    expect(root?.textContent).toBe("Hello world");
  });

  it("keeps aria-label in sync with the resolved text prop", () => {
    const { container, rerender } = render(<ScrambleText text="One" />);
    expect(container.querySelector("span[aria-label]")).toHaveAttribute("aria-label", "One");

    rerender(<ScrambleText text="Two" />);
    expect(container.querySelector("span[aria-label]")).toHaveAttribute("aria-label", "Two");
  });

  it("animates to the new text and fires onComplete after the duration", () => {
    const onComplete = vi.fn();
    const { container, rerender } = render(<ScrambleText text="aaaa" onComplete={onComplete} />);

    rerender(<ScrambleText text="bbbb" onComplete={onComplete} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.querySelector("span[aria-label]")?.textContent).toBe("bbbb");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("respects prefers-reduced-motion: updates instantly and fires onComplete", () => {
    setMatchMedia(true);

    const onComplete = vi.fn();
    const { container, rerender } = render(<ScrambleText text="from" onComplete={onComplete} />);

    rerender(<ScrambleText text="to" onComplete={onComplete} />);

    expect(container.querySelector("span[aria-label]")?.textContent).toBe("to");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("regression: mid-animation re-render with a new onComplete identity does not cancel the in-flight animation", () => {
    const onCompleteA = vi.fn();
    const onCompleteB = vi.fn();

    const { container, rerender } = render(<ScrambleText text="aaaa" onComplete={onCompleteA} />);

    rerender(<ScrambleText text="bbbb" onComplete={onCompleteA} />);

    act(() => {
      vi.advanceTimersByTime(100);
    });
    rerender(<ScrambleText text="bbbb" onComplete={onCompleteB} />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.querySelector("span[aria-label]")?.textContent).toBe("bbbb");
    expect(onCompleteB).toHaveBeenCalledTimes(1);
    expect(onCompleteA).not.toHaveBeenCalled();
  });

  it("regression: reverting text mid-animation snaps displayed back to the original value", () => {
    const { container, rerender } = render(<ScrambleText text="aaaa" />);

    rerender(<ScrambleText text="bbbb" />);
    act(() => {
      vi.advanceTimersByTime(200);
    });

    rerender(<ScrambleText text="aaaa" />);

    expect(container.querySelector("span[aria-label]")?.textContent).toBe("aaaa");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.querySelector("span[aria-label]")?.textContent).toBe("aaaa");
  });

  it("regression: rapid successive text changes still resolve to the latest target", () => {
    const { container, rerender } = render(<ScrambleText text="aaaa" />);

    rerender(<ScrambleText text="bbbb" />);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    rerender(<ScrambleText text="cccc" />);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.querySelector("span[aria-label]")?.textContent).toBe("cccc");
  });
});
