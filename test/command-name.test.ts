import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { armedText } from "../src/hosts/closed.js";
import { copilotHost } from "../src/hosts/copilot/host.js";
import { NPX_COMMAND, rewake, rewakeOnPath, setRewakeCommand } from "../src/util/command.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the command Rewake tells people to run", () => {
  it("is agent-rewake only when that's on PATH", () => {
    const bin = mkdtempSync(join(tmpdir(), "rewake-bin-"));
    dirs.push(bin);
    // This computer's own PATH form (a Windows folder can't sit in a ":"-separated PATH).
    const native = process.platform === "win32" ? "agent-rewake.cmd" : "agent-rewake";
    const env = { PATH: [join(bin, "nowhere"), bin].join(delimiter) };
    expect(rewakeOnPath(env, process.platform)).toBe(false);
    writeFileSync(join(bin, native), "");
    expect(rewakeOnPath(env, process.platform)).toBe(true);
    const win = join(bin, "win");
    mkdirSync(win);
    writeFileSync(join(win, "agent-rewake.cmd"), "");
    expect(rewakeOnPath({ Path: `C:\\nowhere;${win}` }, "win32")).toBe(true);
  });

  it("gives npx users a command that works", () => {
    setRewakeCommand(NPX_COMMAND);
    expect(rewake("continue --cancel")).toBe("npx @codizelabs/agent-rewake continue --cancel");
    expect(armedText(copilotHost, "/work/shop", Date.now() + 3_600_000, Date.now())).toContain(
      "To cancel all planned resumes: npx @codizelabs/agent-rewake continue --cancel",
    );
  });
});
