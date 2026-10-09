// Records the landing page's terminal demo from the real Claude Code, offline, the way the e2e
// tests run it (test/claude-code-loop.test.ts): Rewake installed with Claude Code's own plugin
// commands, Claude Code in a pseudo-terminal against the local model mock (test/e2e/mock-llm.mjs),
// macOS's sandbox denying every other connection, a made-up token. The session hits its limit,
// Rewake asks, the person picks "continue", and after the reset Rewake continues the same session.
// Every byte Claude Code draws goes through a terminal emulator (@xterm/headless), and each screen
// it shows is saved with its time: site/src/demos/claude-code.json.
//
// The reset falls at 3:00 AM in a well-known city, at the next half hour where that's true, so the
// run may wait an hour or more: Claude Code and Rewake print the real times, and nothing is edited
// afterwards. Needs macOS, `npm run build` at the root and `npm ci` in test/agents.
//
//   node site/scripts/record-terminal.mjs
//   DEMO_QUICK=1 DEMO_OUT=/tmp/try.json node site/scripts/record-terminal.mjs   (a minute's reset)
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import xterm from "@xterm/headless";
import { startMock } from "../../test/e2e/mock-llm.mjs";

const root = join(import.meta.dirname, "..", "..");
const bundle = join(root, "dist", "agent-rewake.js");
const agents = join(root, "test", "agents", "node_modules", ".bin");
const claude = join(agents, "claude");
const out = process.env.DEMO_OUT ?? join(root, "site", "src", "demos", "claude-code.json");
const COLS = 80;
const ROWS = 24;
const SANDBOX = `(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*"))`;
const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "darwin") throw new Error("The recorder needs macOS (its network sandbox).");

// Places people know, so the time in the demo reads as someone's night, not a puzzle.
const ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Sao_Paulo",
  "America/St_Johns",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Adelaide",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** The next half hour, at least `lead` ms away, that is 3:00 AM in one of ZONES. */
function nightReset(lead) {
  const half = 30 * 60_000;
  for (let at = Math.ceil((Date.now() + lead) / half) * half; ; at += half)
    for (const zone of ZONES) {
      const local = new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(at);
      if (local === "03:00") return { at, zone };
    }
}

function run(argv, env, cwd) {
  return new Promise((resolve, reject) =>
    execFile("/usr/bin/sandbox-exec", ["-p", SANDBOX, ...argv], { env, cwd, timeout: 120_000 }, (err, so, se) =>
      err ? reject(new Error(`${so}${se}`)) : resolve(`${so}${se}`),
    ),
  );
}

/** A colour as the page reads it: "" (default), "p<index>" (palette) or "#rrggbb". */
function colour(mode, value) {
  if (mode === 0) return "";
  if (mode === 0x1000000 || mode === 0x2000000) return `p${value}`;
  return `#${value.toString(16).padStart(6, "0")}`;
}

/** The screen as lines of runs: [text, fg, bg, flags], flags b(old) d(im) i(talic) r(everse). */
function snapshot(term) {
  const buffer = term.buffer.active;
  const cell = buffer.getNullCell();
  const lines = [];
  for (let y = 0; y < ROWS; y++) {
    const line = buffer.getLine(buffer.viewportY + y);
    const runs = [];
    let current;
    for (let x = 0; line && x < COLS; x++) {
      line.getCell(x, cell);
      if (cell.getWidth() === 0) continue;
      const fg = colour(cell.getFgColorMode(), cell.getFgColor());
      const bg = colour(cell.getBgColorMode(), cell.getBgColor());
      const flags = `${cell.isBold() ? "b" : ""}${cell.isDim() ? "d" : ""}${cell.isItalic() ? "i" : ""}${cell.isInverse() ? "r" : ""}`;
      const ch = cell.getChars() || " ";
      if (current && current[1] === fg && current[2] === bg && current[3] === flags) current[0] += ch;
      else runs.push((current = [ch, fg, bg, flags]));
    }
    // Trailing plain spaces carry nothing.
    while (runs.length) {
      const last = runs[runs.length - 1];
      if (last[2] || last[3].includes("r")) break;
      last[0] = last[0].replace(/ +$/, "");
      if (last[0]) break;
      runs.pop();
    }
    lines.push(runs);
  }
  return { lines };
}

// The real path: Claude Code shortens the folder to ~/… only when it matches HOME exactly.
const home = realpathSync(mkdtempSync(join(tmpdir(), "rewake-demo-")));
const mock = await startMock();
try {
  const reset = process.env.DEMO_QUICK
    ? { at: Date.now() + 90_000, zone: "Europe/London" }
    : nightReset(4 * 60_000);
  console.log(`Reset at ${new Date(reset.at).toISOString()} (3:00 AM in ${reset.zone}), ${Math.round((reset.at - Date.now()) / 60_000)} minutes from now.`);

  const work = join(home, "billing-service");
  mkdirSync(work);
  const config = join(home, ".claude");
  const env = {
    PATH: [agents, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    HOME: home,
    TZ: reset.zone,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    COLUMNS: String(COLS),
    LINES: String(ROWS),
    CLAUDE_CONFIG_DIR: config,
    AGENT_REWAKE_STATE_DIR: join(home, "state"),
    ANTHROPIC_BASE_URL: mock.url,
    CLAUDE_CODE_OAUTH_TOKEN: "rewake-demo-not-a-real-token",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
  };
  await run([process.execPath, bundle, "install", "--only", "claude-code", "--yes"], env, home);
  const profile = join(config, ".claude.json");
  writeFileSync(
    profile,
    JSON.stringify({
      ...JSON.parse(readFileSync(profile, "utf8")),
      hasCompletedOnboarding: true,
      hasSeenAutoDefaultNotice: true,
      theme: "dark",
      projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    }),
  );
  // Claude Code's own "continue automatically at usage limit" off: Rewake asks instead.
  const settings = join(config, "settings.json");
  writeFileSync(settings, JSON.stringify({ ...JSON.parse(readFileSync(settings, "utf8")), autoContinueAtUsageLimit: false }));

  const term = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
  const frames = [];
  const marks = {};
  const start = Date.now();
  let last = "";
  let pending = false;
  const capture = () => {
    pending = false;
    const s = snapshot(term);
    const key = JSON.stringify(s);
    if (key === last) return;
    last = key;
    frames.push({ t: Date.now() - start, ...s });
  };
  const cmd = ["/usr/bin/sandbox-exec", "-p", SANDBOX, claude].map(quote).join(" ");
  // script(1) wants a pipe on its input, not the socket Node gives a child: hence `cat |`.
  const child = spawn("/bin/sh", ["-c", `cat | exec /usr/bin/script -q /dev/null ${cmd}`], {
    cwd: work,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let text = "";
  const feed = (c) => {
    text += c.toString("utf8");
    term.write(c, () => {
      if (!pending) {
        pending = true;
        setTimeout(capture, 40);
      }
    });
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  const plain = () =>
    text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]/g, "").replace(/\s+/g, "");
  const until = async (re, ms) => {
    const end = Date.now() + ms;
    while (!re.test(plain())) {
      if (Date.now() > end) throw new Error(`Timed out waiting for ${re}`);
      await sleep(200);
    }
  };
  /** Types as a person does: one key at a time, a little unevenly. */
  const type = async (s) => {
    for (const ch of s) {
      child.stdin.write(ch);
      await sleep(45 + Math.round(Math.random() * 70));
    }
    await sleep(350);
    child.stdin.write("\r");
  };

  await until(/ClaudeCodev\d/, 30_000);
  await sleep(1500);
  // The model takes a few seconds, as a real one does, so Claude Code shows real durations.
  mock.set({
    think: true,
    reply:
      "I'll split the scheduler in two: a store that owns the schedule file, and a delivery loop that sends each message when it's due. Starting with the store, then the tests.",
  });
  await type("Split the scheduler into a store and a delivery loop, then run the tests");
  await until(/thenthetests\./, 60_000);
  await sleep(2500);

  // The limit: the next request is refused until 3:00 AM in this zone.
  mock.set({ mode: "limit", until: reset.at, claim: "five_hour" });
  await type("Go on with the delivery loop");
  await until(/hityoursessionlimit/, 30_000);
  marks.limit = Date.now() - start;
  await until(/Whatdoyouwanttodo\?/, 15_000);
  await sleep(1800);
  child.stdin.write("\r"); // Claude Code's own question: stop and wait for the reset.
  await until(/Continuethissessionautomatically/, 15_000);
  await sleep(2200);
  child.stdin.write("\r"); // Rewake's question: continue at the reset.
  await sleep(4000);
  marks.armed = Date.now() - start;

  // The night: Rewake continues the same session a minute after the reset.
  mock.set({
    reply:
      "Picking up where I stopped. The store is in place; the delivery loop now runs on its own timer. Running the tests next.",
  });
  await until(/SentautomaticallybyAgentRewake/, reset.at - Date.now() + 5 * 60_000);
  marks.continued = Date.now() - start;
  await until(/Pickingupwhere/, 90_000);
  await sleep(4000);
  marks.end = Date.now() - start;
  capture();

  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    `${JSON.stringify({
      agent: "Claude Code",
      version: execFileSync(claude, ["--version"], { encoding: "utf8" }).trim(),
      zone: reset.zone,
      reset: reset.at,
      start,
      cols: COLS,
      rows: ROWS,
      marks,
      frames,
    })}\n`,
  );
  console.log(`${frames.length} screens, ${Math.round(marks.end / 1000)} s, written to ${out}`);
} finally {
  await mock.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
