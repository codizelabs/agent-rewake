import { describe, expect, it } from "vitest";
import {
  backoffMs,
  decideArm,
  decideFire,
  FAR_RESET_MS,
  type FireContext,
  LATE_MS,
  MAX_REARMS,
  RESET_MARGIN_MS,
} from "../src/core/resume.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3_600_000;

describe("decideArm", () => {
  it("never arms a billing limit, whatever the setting", () => {
    for (const auto of ["ask", "always", "never"] as const)
      expect(decideArm({ now: NOW, resetsAt: NOW + HOUR, isBilling: true, auto })).toEqual({
        action: "none",
        why: "billing",
      });
  });

  it("does nothing when the person chose never", () => {
    expect(decideArm({ now: NOW, resetsAt: NOW + HOUR, isBilling: false, auto: "never" })).toEqual({
      action: "none",
      why: "never",
    });
  });

  it("arms with always, at the reset plus the margin", () => {
    expect(decideArm({ now: NOW, resetsAt: NOW + HOUR, isBilling: false, auto: "always" })).toEqual(
      {
        action: "arm",
        fireAt: NOW + HOUR + RESET_MARGIN_MS,
      },
    );
  });

  it("offers instead with ask", () => {
    expect(decideArm({ now: NOW, resetsAt: NOW + HOUR, isBilling: false, auto: "ask" })).toEqual({
      action: "offer",
      why: "ask",
    });
  });

  it("asks about a reset more than a day away, even with always", () => {
    expect(
      decideArm({ now: NOW, resetsAt: NOW + FAR_RESET_MS + 1, isBilling: false, auto: "always" }),
    ).toEqual({ action: "offer", why: "far-reset" });
    // Exactly a day is still within.
    expect(
      decideArm({ now: NOW, resetsAt: NOW + FAR_RESET_MS, isBilling: false, auto: "always" })
        .action,
    ).toBe("arm");
  });

  it("offers when no reset time is known", () => {
    expect(decideArm({ now: NOW, isBilling: false, auto: "always" })).toEqual({
      action: "offer",
      why: "no-reset-time",
    });
  });

  it("does nothing for a reset that has already passed", () => {
    expect(
      decideArm({ now: NOW, resetsAt: NOW - RESET_MARGIN_MS, isBilling: false, auto: "always" }),
    ).toEqual({ action: "none", why: "passed" });
  });
});

describe("decideFire", () => {
  const base = (over: Partial<FireContext> = {}): FireContext => ({
    resume: { dueAt: NOW, status: "scheduled" },
    now: NOW,
    alreadySent: false,
    ...over,
  });

  it("sends when nothing stands in the way", () => {
    expect(decideFire(base())).toEqual({ action: "send" });
    expect(decideFire(base({ usageAllowed: true }))).toEqual({ action: "send" });
  });

  it("never sends twice", () => {
    expect(decideFire(base({ alreadySent: true }))).toEqual({ action: "skip", why: "sent" });
  });

  it("skips a cancelled resume", () => {
    expect(decideFire(base({ resume: { dueAt: NOW, status: "cancelled" } }))).toEqual({
      action: "skip",
      why: "cancelled",
    });
  });

  it("skips when the agent's own auto-continue already continued", () => {
    expect(decideFire(base({ nativeContinued: true }))).toEqual({ action: "skip", why: "native" });
  });

  it("skips when the person typed after the limit", () => {
    expect(decideFire(base({ userTypedSince: true }))).toEqual({ action: "skip", why: "typed" });
  });

  it("only notifies when the session is open (no second writer)", () => {
    expect(decideFire(base({ sessionOpen: true }))).toEqual({ action: "notify", why: "open" });
  });

  it("only notifies when the session changed after the limit, by something Rewake can't see", () => {
    expect(decideFire(base({ changedSince: true }))).toEqual({ action: "notify", why: "changed" });
    // The person typing in it is the clearer fact: nothing to tell them.
    expect(decideFire(base({ changedSince: true, userTypedSince: true }))).toEqual({
      action: "skip",
      why: "typed",
    });
    expect(decideFire(base({ changedSince: true, sessionOpen: true }))).toEqual({
      action: "notify",
      why: "open",
    });
  });

  it("only notifies when more than 30 minutes late", () => {
    expect(decideFire(base({ now: NOW + LATE_MS + 1 }))).toEqual({ action: "notify", why: "late" });
    expect(decideFire(base({ now: NOW + LATE_MS }))).toEqual({ action: "send" });
  });

  it("waits for a later reset the usage check reports", () => {
    expect(decideFire(base({ usageAllowed: false, newResetsAt: NOW + 2 * HOUR }))).toEqual({
      action: "wait",
      until: NOW + 2 * HOUR + RESET_MARGIN_MS,
      why: "still-limited",
    });
  });

  it("notifies instead of waiting for a later reset more than a day away", () => {
    expect(decideFire(base({ usageAllowed: false, newResetsAt: NOW + FAR_RESET_MS + 1 }))).toEqual({
      action: "notify",
      why: "far-reset",
    });
  });

  it("backs off when still limited with no new reset time, then gives up", () => {
    const at = (rearms: number) =>
      decideFire(
        base({ usageAllowed: false, resume: { dueAt: NOW, status: "scheduled", rearms } }),
      );
    expect(at(0)).toEqual({ action: "wait", until: NOW + 2 * 60_000, why: "still-limited" });
    expect(at(3)).toEqual({ action: "wait", until: NOW + 20 * 60_000, why: "still-limited" });
    expect(at(MAX_REARMS)).toEqual({ action: "skip", why: "expired" });
  });

  it("ignores a reported reset that has already passed", () => {
    expect(decideFire(base({ usageAllowed: false, newResetsAt: NOW - 1 }))).toEqual({
      action: "wait",
      until: NOW + 2 * 60_000,
      why: "still-limited",
    });
  });

  it("checks in order: sent, cancelled, native, typed, open, late", () => {
    expect(
      decideFire(
        base({ alreadySent: true, nativeContinued: true, userTypedSince: true, sessionOpen: true }),
      ),
    ).toEqual({ action: "skip", why: "sent" });
    expect(decideFire(base({ userTypedSince: true, sessionOpen: true }))).toEqual({
      action: "skip",
      why: "typed",
    });
  });
});

describe("backoffMs", () => {
  it("grows and then stays at the last step", () => {
    expect([0, 1, 2, 3, 9, -1].map(backoffMs)).toEqual(
      [2, 5, 10, 20, 20, 2].map((m) => m * 60_000),
    );
  });
});

describe("the rules Zed's add-on shares with the previews", () => {
  const NOW = Date.parse("2026-10-07T12:00:00Z");
  it("with 'always' and no reset time, waits the chosen time instead of asking", () => {
    expect(
      decideArm({ now: NOW, isBilling: false, auto: "always", noResetDelayMs: 3_600_000 }),
    ).toEqual({
      action: "arm",
      fireAt: NOW + 3_600_000,
    });
    expect(
      decideArm({ now: NOW, isBilling: false, auto: "ask", noResetDelayMs: 3_600_000 }),
    ).toEqual({
      action: "offer",
      why: "no-reset-time",
    });
  });

  it("takes its own late threshold (Zed: 15 minutes, the previews: 30)", () => {
    const resume = { dueAt: NOW - 20 * 60_000, status: "scheduled" };
    expect(decideFire({ resume, now: NOW, alreadySent: false }).action).toBe("send");
    expect(decideFire({ resume, now: NOW, alreadySent: false, lateMs: 15 * 60_000 })).toEqual({
      action: "notify",
      why: "late",
    });
  });
});
