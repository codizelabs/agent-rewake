import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Wakefulness } from "../src/util/keep-awake.js";

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

describe("Wakefulness", () => {
  it("does nothing where it isn't supported, or when the setting says never", () => {
    const off = new Wakefulness({ platform: "linux" });
    expect(off.supported).toBe(false);
    expect(off.set(true, "plugged-in")).toBe(false);
    const missing = new Wakefulness({ platform: "darwin", program: "/nonexistent/caffeinate" });
    expect(missing.supported).toBe(false);
    expect(missing.set(true, "always")).toBe(false);
  });

  it.runIf(process.platform === "darwin")(
    "holds with caffeinate tied to a process, lets go, and ends with that process",
    async () => {
      // A stand-in for Rewake, so the test never ties a hold to the test runner itself.
      const owner = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      if (owner.pid === undefined) throw new Error("no stand-in process");
      const wake = new Wakefulness({ pid: owner.pid });
      expect(wake.supported).toBe(true);
      expect(wake.set(true, "never")).toBe(false);
      expect(wake.set(true, "always")).toBe(true);
      await settle();
      expect(wake.holding).toBe(true);
      // Same mode again: the same hold, not a second one.
      expect(wake.set(true, "always")).toBe(true);
      wake.release();
      await settle();
      expect(wake.holding).toBe(false);
      // Taken again, then the owner dies: caffeinate -w ends on its own.
      expect(wake.set(true, "plugged-in")).toBe(true);
      owner.kill("SIGKILL");
      await settle(2500);
      expect(wake.holding).toBe(false);
    },
    10_000,
  );
});
