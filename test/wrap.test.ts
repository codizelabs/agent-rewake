import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeHttp from "node:http";
import { createServer } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BinaryTarget,
  downloadBinaryAgent,
  enableProxy,
  findBinaryAgent,
  packageExecutable,
  parseWrapArgs,
  registryAgent,
  splitPackageSpec,
  wrapArgs,
  wrappedAgentCommand,
  zedBinaryDir,
} from "../src/wrap.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rewake-wrap-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("wrap arguments", () => {
  it("round-trips both kinds of target and keeps Zed's extra arguments apart", () => {
    const custom = { kind: "command" as const, command: "/bin/agent", args: ["--acp", "a b"] };
    expect(parseWrapArgs([...wrapArgs(custom), "--cli", "login"])).toEqual({
      target: custom,
      extra: ["--cli", "login"],
    });
    expect(parseWrapArgs(["--wrap-registry", "codex-acp"])).toEqual({
      target: { kind: "registry", id: "codex-acp" },
      extra: [],
    });
    expect(parseWrapArgs(["doctor"])).toBeUndefined();
    expect(parseWrapArgs(["--wrap-registry"])).toEqual({
      error: "missing value after --wrap-registry",
    });
    expect(parseWrapArgs(["--wrap-command", "{}"])).toHaveProperty("error");
  });

  it("splits package specs the way npm writes them", () => {
    expect(splitPackageSpec("@agentclientprotocol/codex-acp@2.1.1")).toEqual([
      "@agentclientprotocol/codex-acp",
      "2.1.1",
    ]);
    expect(splitPackageSpec("cline@3.0.68")).toEqual(["cline", "3.0.68"]);
    expect(splitPackageSpec("@scope/pkg")).toEqual(["@scope/pkg", undefined]);
  });
});

describe("registry agents", () => {
  it("reads Zed's cached registry and finds the package's executable", async () => {
    const registry = join(dir, "external_agents", "registry");
    mkdirSync(registry, { recursive: true });
    writeFileSync(
      join(registry, "registry.json"),
      JSON.stringify({
        agents: [
          {
            id: "gemini",
            name: "Gemini CLI",
            distribution: { npx: { package: "@google/gemini-cli@0.62.0", args: ["--acp"] } },
          },
          { id: "cursor", distribution: { binary: {} } },
        ],
      }),
    );
    const env = { AGENT_REWAKE_ZED_DATA_DIR: dir };
    expect(registryAgent("gemini", env)).toEqual({
      kind: "npx",
      name: "Gemini CLI",
      npx: { package: "@google/gemini-cli@0.62.0", args: ["--acp"], env: {} },
    });
    expect(registryAgent("cursor", env)).toEqual({
      kind: "other",
      name: undefined,
      types: ["binary"],
    });
    await expect(
      wrappedAgentCommand({ kind: "registry", id: "cursor" }, [], env, join(dir, "state")),
    ).rejects.toThrow(/no build for this computer/);

    const pkg = join(dir, "x", "node_modules", "@google", "gemini-cli");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      join(pkg, "package.json"),
      JSON.stringify({ bin: { gemini: "dist/index.js", other: "o.js" } }),
    );
    expect(packageExecutable(join(dir, "x"), "@google/gemini-cli")).toBe(
      join(pkg, "dist", "index.js"),
    );
  });
});

// Launch every agent the way Zed would.
describe("launching any registry agent", () => {
  const PLATFORM = "linux-x86_64";
  function registry(agents: unknown[]) {
    const reg = join(dir, "external_agents", "registry");
    mkdirSync(reg, { recursive: true });
    writeFileSync(join(reg, "registry.json"), JSON.stringify({ agents }));
    return { AGENT_REWAKE_ZED_DATA_DIR: dir, AGENT_REWAKE_PLATFORM: PLATFORM };
  }
  const opencode = (target: Partial<BinaryTarget> = {}) => ({
    id: "opencode",
    name: "OpenCode",
    version: "1.18.34",
    distribution: {
      binary: {
        [PLATFORM]: {
          archive: "https://example.test/opencode-linux-x64.tar.gz",
          cmd: "./opencode",
          args: ["acp"],
          ...target,
        },
      },
    },
  });

  it("runs Zed's installed copy of an npx agent whatever its version, without installing", async () => {
    const env = registry([
      {
        id: "codex-acp",
        name: "Codex",
        version: "2.1.1",
        distribution: { npx: { package: "@agentclientprotocol/codex-acp@2.1.1" } },
      },
    ]);
    // Zed's version ceiling left an older copy (1.12.0); Zed would run it, so Rewake does too.
    const pkg = join(dir, "external_agents", "registry", "npx", "codex-acp", "node_modules");
    mkdirSync(join(pkg, "@agentclientprotocol", "codex-acp"), { recursive: true });
    writeFileSync(
      join(pkg, "@agentclientprotocol", "codex-acp", "package.json"),
      JSON.stringify({ version: "1.12.0", bin: { "codex-acp": "dist/index.js" } }),
    );
    const cmd = await wrappedAgentCommand(
      { kind: "registry", id: "codex-acp" },
      [],
      env,
      join(dir, "state"),
    );
    expect(cmd.args[0]).toBe(join(pkg, "@agentclientprotocol", "codex-acp", "dist", "index.js"));
    expect(existsSync(join(dir, "state", "agents", "npx"))).toBe(false); // no npm install
  });

  it("runs a binary agent from Zed's own directory, with the registry's args and env", async () => {
    const env = registry([opencode({ env: { OPENCODE_X: "1" } })]);
    const agent = opencode().distribution.binary[PLATFORM] as BinaryTarget;
    const zed = zedBinaryDir("opencode", "1.18.34", { ...agent, env: {}, args: [] }, env);
    expect(zed).toMatch(
      /external_agents[\\/]registry[\\/]opencode[\\/]v_1\.18\.34_[0-9a-f]{16}_[0-9a-f]{16}$/,
    );
    mkdirSync(zed, { recursive: true });
    writeFileSync(join(zed, "opencode"), "#!/bin/sh\n");
    const cmd = await wrappedAgentCommand(
      { kind: "registry", id: "opencode" },
      ["--extra"],
      env,
      join(dir, "state"),
    );
    expect(cmd.command).toBe(join(zed, "opencode"));
    expect(cmd.args).toEqual(["acp", "--extra"]);
    expect(cmd.env.OPENCODE_X).toBe("1");
  });

  it("prefers the binary build over npx, as Zed does", () => {
    const env = registry([
      {
        ...opencode(),
        id: "kilo",
        distribution: { ...opencode().distribution, npx: { package: "@kilocode/cli@7.8.3" } },
      },
    ]);
    expect(registryAgent("kilo", env)?.kind).toBe("binary");
    expect(registryAgent("kilo", { ...env, AGENT_REWAKE_PLATFORM: "windows-aarch64" })?.kind).toBe(
      "npx",
    );
  });

  it("downloads, checks and unpacks a binary agent Zed hasn't installed", async () => {
    // A real .tar.gz holding ./opencode, made with the system tar (Windows' own tar.exe, as
    // Rewake uses: Git's GNU tar reads "C:" as a remote host).
    const tar =
      process.platform === "win32"
        ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
        : "tar";
    const src = join(dir, "src");
    mkdirSync(src);
    writeFileSync(join(src, "opencode"), "#!/bin/sh\necho hi\n");
    const archive = join(dir, "a.tar.gz");
    expect(spawnSync(tar, ["-czf", archive, "-C", src, "opencode"]).status).toBe(0);
    const bytes = readFileSync(archive);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const fakeFetch = (async () => new Response(bytes)) as unknown as typeof fetch;

    const env = registry([opencode({ sha256 })]);
    const cmd = await wrappedAgentCommand(
      { kind: "registry", id: "opencode" },
      [],
      env,
      join(dir, "state"),
      undefined,
      fakeFetch,
    );
    expect(cmd.command).toBe(
      join(dir, "state", "agents", "bin", "opencode", "v_1.18.34", "opencode"),
    );
    expect(readFileSync(cmd.command, "utf8")).toContain("echo hi");
    // Next time it's found without downloading.
    const target = opencode({ sha256 }).distribution.binary[PLATFORM] as BinaryTarget;
    expect(
      findBinaryAgent(
        "opencode",
        "1.18.34",
        { ...target, env: {}, args: [] },
        join(dir, "state"),
        env,
      ),
    ).toBe(cmd.command);

    // A checksum mismatch is refused, and nothing is left behind.
    const bad = registry([{ ...opencode({ sha256: "0".repeat(64) }), id: "goose" }]);
    await expect(
      wrappedAgentCommand(
        { kind: "registry", id: "goose" },
        [],
        bad,
        join(dir, "state"),
        undefined,
        fakeFetch,
      ),
    ).rejects.toThrow(/doesn't match the registry's checksum/);
    expect(existsSync(join(dir, "state", "agents", "bin", "goose", "v_1.18.34"))).toBe(false);
  });

  it("refuses a download that isn't https, or a command path that leaves the folder", async () => {
    const target = (o: Partial<BinaryTarget>): BinaryTarget => ({
      archive: "https://example.test/agent",
      cmd: "./agent",
      args: [],
      env: {},
      ...o,
    });
    const never = (async () => {
      throw new Error("must not download");
    }) as unknown as typeof fetch;
    await expect(
      downloadBinaryAgent(
        "agent",
        "1",
        target({ archive: "http://example.test/agent" }),
        join(dir, "state"),
        never,
      ),
    ).rejects.toThrow(/isn't https/);
    await expect(
      downloadBinaryAgent("agent", "1", target({ cmd: "./../escape" }), join(dir, "state"), never),
    ).rejects.toThrow(/isn't inside the download/);
    await expect(
      downloadBinaryAgent("agent", "1", target({ cmd: "/abs/escape" }), join(dir, "state"), never),
    ).rejects.toThrow(/isn't inside the download/);
  });
});

describe("Rewake's own agent download and proxy settings (G71)", () => {
  it("passes the proxy variables to Node's fetch, and only those", () => {
    const seen: Record<string, string>[] = [];
    const http = { setGlobalProxyFromEnv: (e: Record<string, string>) => void seen.push(e) };
    expect(enableProxy({ PATH: "/bin" }, http)).toBe("none");
    expect(seen).toEqual([]);
    expect(
      enableProxy(
        { HTTPS_PROXY: "http://p:3128", no_proxy: "localhost", SECRET_TOKEN: "x", PATH: "/bin" },
        http,
      ),
    ).toBe("used");
    expect(seen).toEqual([{ HTTPS_PROXY: "http://p:3128", no_proxy: "localhost" }]);
  });

  it("a proxy variable on a Node.js that can't switch it on at run time is said, not hidden", () => {
    expect(enableProxy({ HTTP_PROXY: "http://p:3128" }, {})).toBe("unsupported");
    // Started with NODE_USE_ENV_PROXY=1 (Node.js 22.21+, 24+): already in use.
    expect(enableProxy({ HTTP_PROXY: "http://p:3128", NODE_USE_ENV_PROXY: "1" }, {})).toBe("used");
    // A NO_PROXY alone names no proxy.
    expect(enableProxy({ NO_PROXY: "localhost" }, {})).toBe("none");
  });

  it("a failed download says Rewake couldn't download it, what the proxy did, and what to do", async () => {
    const refuse = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const target: BinaryTarget = {
      archive: "https://example.test/a.tar.gz",
      cmd: "./a",
      args: [],
      env: {},
    };
    const fail = (proxy: "none" | "used" | "unsupported") =>
      downloadBinaryAgent("a", "1", target, join(dir, "state"), refuse, proxy).catch(
        (e: Error) => e.message,
      );
    const none = await fail("none");
    expect(none).toContain("Rewake couldn't download it.");
    expect(none).toContain("A proxy or firewall may be blocking it.");
    expect(none).toContain("open the agent once in Zed without Rewake");
    expect(await fail("used")).toContain("Rewake used your proxy settings.");
    const unsupported = await fail("unsupported");
    expect(unsupported).toContain("can't send Rewake's download through it");
    expect(unsupported).toContain("NODE_USE_ENV_PROXY=1");
    expect(unsupported).not.toContain("Check your network");
  });

  // Node.js 24.14 and newer can be switched to a proxy at run time; older ones only at start.
  it.skipIf(typeof nodeHttp.setGlobalProxyFromEnv !== "function")(
    "downloads through the proxy the environment names",
    async () => {
      const src = join(dir, "src");
      mkdirSync(src);
      writeFileSync(join(src, "agent"), "#!/bin/sh\necho via-proxy\n");
      const tarFile = join(dir, "a.tar.gz");
      const tar =
        process.platform === "win32"
          ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
          : "tar";
      expect(spawnSync(tar, ["-czf", tarFile, "-C", src, "agent"]).status).toBe(0);
      const bytes = readFileSync(tarFile);

      // Node tunnels through the proxy with CONNECT (also for http: URLs); this proxy sends the
      // tunnel to a local server holding the archive, whatever host was asked for.
      const requested: string[] = [];
      const origin = createServer((_req, res) => res.end(bytes));
      await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
      const proxy = createServer();
      proxy.on("connect", (req, socket, head) => {
        requested.push(req.url ?? "");
        const up = connect((origin.address() as { port: number }).port, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          up.write(head);
          up.pipe(socket);
          socket.pipe(up);
        });
        up.on("error", () => socket.destroy());
        socket.on("error", () => up.destroy());
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
      const port = (proxy.address() as { port: number }).port;
      try {
        const reg = join(dir, "external_agents", "registry");
        mkdirSync(reg, { recursive: true });
        writeFileSync(
          join(reg, "registry.json"),
          JSON.stringify({
            agents: [
              {
                id: "viaproxy",
                name: "Via proxy",
                version: "1.0.0",
                distribution: {
                  binary: {
                    "linux-x86_64": {
                      archive: "http://downloads.invalid/agent.tar.gz",
                      cmd: "./agent",
                      args: [],
                    },
                  },
                },
              },
            ],
          }),
        );
        const cmd = await wrappedAgentCommand(
          { kind: "registry", id: "viaproxy" },
          [],
          {
            AGENT_REWAKE_ZED_DATA_DIR: dir,
            AGENT_REWAKE_PLATFORM: "linux-x86_64",
            HTTP_PROXY: `http://127.0.0.1:${port}`,
            // The fake download is plain http; real ones must be https.
            AGENT_REWAKE_TEST_ALLOW_HTTP: "1",
          },
          join(dir, "state"),
        );
        expect(requested).toEqual(["downloads.invalid:80"]);
        expect(readFileSync(cmd.command, "utf8")).toContain("via-proxy");
      } finally {
        proxy.close();
        origin.close();
        proxy.closeAllConnections();
        origin.closeAllConnections();
        // Back to no proxy for the rest of this file.
        nodeHttp.setGlobalProxyFromEnv?.({});
      }
    },
  );
});
