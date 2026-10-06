// Captures the site's images from the built site: feature stills (each scene's
// final frame), the social preview, and the README's hero GIF. Needs Playwright and ffmpeg:
//   npm run build && npx astro preview &   then   node scripts/capture.mjs [playwright module path]
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.argv[2] ?? "playwright");
const ORIGIN = process.env.SITE_ORIGIN ?? "http://localhost:4321";
const HOME = `${ORIGIN}/agent-rewake/`;
const out = new URL("../public/images/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

// 1. Stills: every scene's final frame, light and dark (reduced motion shows the final state).
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({
    viewport: { width: 1360, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await page.goto(HOME, { waitUntil: "networkidle" });
  const names = ["resume", "after-resume", "schedule", "repeat", "agent", "schedules-page", "settings"];
  const scenes = await page.$$("figure.scene");
  for (const [i, el] of scenes.entries()) {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const target = (await el.$(".zed, .term")) ?? el;
    await target.screenshot({ path: join(out, `${names[i] ?? `scene-${i}`}-${scheme}.png`) });
  }
  await page.close();
}

// 2. Social preview: the hero at 1280×640 (GitHub, Open Graph, X).
{
  const page = await browser.newPage({
    viewport: { width: 1280, height: 640 },
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.goto(HOME, { waitUntil: "networkidle" });
  await page.addStyleTag({
    content: ".top{display:none}.hero{padding-top:56px}.status-pill,.note{display:none}",
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: new URL("../public/social-preview.png", import.meta.url).pathname });
  await page.close();
}

// 3. Hero GIF: one loop of the live animation, cropped to the Zed window.
{
  const dir = mkdtempSync(join(tmpdir(), "rewake-video-"));
  const ctx = await browser.newContext({
    viewport: { width: 1360, height: 900 },
    colorScheme: "dark",
    recordVideo: { dir, size: { width: 1360, height: 900 } },
  });
  const page = await ctx.newPage();
  await page.goto(HOME, { waitUntil: "networkidle" });
  const box = await (await page.$(".hero figure .zed"))?.boundingBox();
  await page.waitForTimeout(22_500);
  await ctx.close();
  const video = join(dir, readdirSync(dir).find((f) => f.endsWith(".webm")) ?? "");
  if (box) {
    const crop = `crop=${Math.round(box.width)}:${Math.round(box.height)}:${Math.round(box.x)}:${Math.round(box.y)}`;
    const vf = `${crop},fps=8,scale=600:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`;
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.2", "-t", "21.3", "-i", video, "-vf", vf, join(out, "rewake-demo.gif")]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.2", "-t", "21.3", "-i", video, "-vf", `${crop},scale=1080:-2`, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", join(out, "rewake-demo.mp4")]);
  }
  rmSync(dir, { recursive: true, force: true });
}

await browser.close();
console.log(`images in ${out}`);
