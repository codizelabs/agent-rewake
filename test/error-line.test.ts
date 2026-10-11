import { describe, expect, it } from "vitest";
import { errorLine } from "../src/util/error-line.js";

describe("errorLine", () => {
  it("keeps the last line that says something, without colours or stack frames", () => {
    expect(
      errorLine(
        "starting\n\u001b[31mError: No session, task, or name matched 'abc'.\u001b[0m\n    at run (x.js:1:1)\n\n",
        "/Users/me",
      ),
    ).toBe("Error: No session, task, or name matched 'abc'.");
    expect(errorLine("\n  \n", "/Users/me")).toBeUndefined();
    expect(errorLine("Error: boom\n    at x (y.js:1:1)\n\nNode.js v24.14.1\n", "/Users/me")).toBe(
      "Error: boom",
    );
  });

  it("hides the home folder, keys and tokens, and stays short", () => {
    expect(errorLine("can't read /Users/me/.copilot/config.json", "/Users/me")).toBe(
      "can't read ~/.copilot/config.json",
    );
    const line = errorLine(
      "401 for key=sk-ant-abcdef0123456789 token: ghp_0123456789abcdefghij Bearer abc.def",
      "/Users/me",
    ) as string;
    expect(line).not.toMatch(/sk-ant|ghp_|abc\.def/);
    expect(errorLine("x".repeat(500), "/Users/me")?.length).toBeLessThanOrEqual(200);
    expect(errorLine("signed in as me@example.com", "/Users/me")).toBe("signed in as …");
  });

  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  it.each([
    ["api_key=abc123def456 was rejected", "api_key=… was rejected"],
    ["password=hunter2", "password=…"],
    ["bad key AKIAIOSFODNN7EXAMPLE here", "bad key … here"],
    ["Authorization: Basic dXNlcjpwYXNzd29yZA== failed", "Authorization: Basic … failed"],
    ["Authorization: Bearer abc.def-ghi", "Authorization: Bearer …"],
    ["GH_TOKEN: ghp_abcdefghijklmnop12345", "GH_TOKEN=…"],
    ["client_secret = s3cr3t-value", "client_secret=…"],
    ["sign in as me@example.com", "sign in as …"],
  ])("cuts a secret out: %s", (input, expected) => {
    expect(errorLine(input, "/home/me")).toBe(expected);
  });

  it("strips every terminal escape, including links and titles", () => {
    const link = `${ESC}]8;;https://example.com${BEL}the docs${ESC}]8;;${BEL}`;
    expect(errorLine(`see ${link} now`, "/home/me")).toBe("see the docs now");
    expect(errorLine(`${ESC}]0;title${BEL}${ESC}[31mred${ESC}[0m`, "/home/me")).toBe("red");
    expect(errorLine(`a${String.fromCharCode(0)}b${String.fromCharCode(8)}c`, "/home/me")).toBe(
      "abc",
    );
  });
});
