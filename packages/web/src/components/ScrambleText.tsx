"use client";

import { useEffect, useRef, useState } from "react";

interface ScrambleTextProps {
  text: string;
  speed?: number;
  scrambleChars?: string;
  className?: string;
  onComplete?: () => void;
}

const DEFAULT_SCRAMBLE_CHARS = "!<>-_\\/[]{}—=+*^?#________";
const DEFAULT_SPEED = 1;
const TOTAL_DURATION_MS = 800;

interface Slot {
  from: string;
  to: string;
  startMs: number;
  endMs: number;
  current: string;
}

function randChar(pool: string): string {
  return pool[Math.floor(Math.random() * pool.length)] ?? "";
}

export function ScrambleText({
  text,
  speed = DEFAULT_SPEED,
  scrambleChars = DEFAULT_SCRAMBLE_CHARS,
  className,
  onComplete,
}: ScrambleTextProps) {
  const [displayed, setDisplayed] = useState(text);
  const previousTextRef = useRef(text);
  const rafRef = useRef<number | null>(null);
  const onCompleteRef = useRef(onComplete);

  useEffect(() => {
    onCompleteRef.current = onComplete;
  });

  useEffect(() => {
    const previous = previousTextRef.current;
    if (text === previous) {
      // Covers reverts mid-animation: a cancelled tick can leave displayed on a
      // scrambled intermediate even when text === previous.
      setDisplayed(text);
      return;
    }

    if (typeof window === "undefined") {
      previousTextRef.current = text;
      setDisplayed(text);
      return;
    }

    const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion) {
      previousTextRef.current = text;
      setDisplayed(text);
      onCompleteRef.current?.();
      return;
    }

    const length = Math.max(previous.length, text.length);
    const totalMs = TOTAL_DURATION_MS / Math.max(speed, 0.01);
    // Last position starts this far into the animation; the remainder is the
    // reveal window so the whole thing finishes at totalMs.
    const staggerWindowMs = totalMs * 0.5;
    const minRevealMs = totalMs * 0.35;
    const revealJitterMs = totalMs * 0.15;
    const startJitterMs = totalMs * 0.08;

    const slots: Slot[] = [];
    for (let i = 0; i < length; i++) {
      const from = previous[i] ?? "";
      const to = text[i] ?? "";
      const progress = length > 1 ? i / (length - 1) : 0;
      // Earlier positions resolve sooner; add jitter so the wave isn't rigid.
      const jitter = (Math.random() - 0.5) * startJitterMs;
      const startMs = Math.max(0, progress * staggerWindowMs + jitter);
      const endMs = Math.min(totalMs, startMs + minRevealMs + Math.random() * revealJitterMs);
      slots.push({ from, to, startMs, endMs, current: from });
    }

    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

    const tick = () => {
      const elapsed = now() - startedAt;
      let complete = 0;
      let output = "";
      for (const slot of slots) {
        if (elapsed >= slot.endMs) {
          complete++;
          output += slot.to;
          slot.current = slot.to;
        } else if (elapsed >= slot.startMs) {
          if (!slot.current || Math.random() < 0.4) {
            slot.current = randChar(scrambleChars);
          }
          output += slot.current;
        } else {
          output += slot.from;
        }
      }
      setDisplayed(output);
      if (complete === slots.length || elapsed >= totalMs) {
        setDisplayed(text);
        previousTextRef.current = text;
        rafRef.current = null;
        onCompleteRef.current?.();
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [text, speed, scrambleChars]);

  return (
    <span className={className} aria-label={text}>
      <span aria-hidden="true">{displayed}</span>
    </span>
  );
}

export default ScrambleText;
