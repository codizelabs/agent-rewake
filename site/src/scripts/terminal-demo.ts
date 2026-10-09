/**
 * Plays back the recorded terminal session (TerminalDemo.astro): each recorded screen at its time,
 * with pauses over 1.4 s shortened and the long wait for the reset shown as the clock running fast.
 * It starts when it comes into view, stops when it leaves, and loops. Under prefers-reduced-motion
 * it doesn't start by itself; the controls still work.
 */
interface Data {
  zone: string;
  start: number;
  marks: { limit: number; armed: number; continued: number; end: number };
  frames: number[][];
  lines: string[];
  text: string[];
}

/** Pauses longer than this are shortened to it; the wait for the reset takes NIGHT_MS. */
const GAP_MS = 1400;
const NIGHT_MS = 3200;
const HOLD_MS = 4500;

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

for (const root of document.querySelectorAll<HTMLElement>("[data-term-demo]")) setUp(root);

function setUp(root: HTMLElement) {
  const raw = root.querySelector("[data-term-data]")?.textContent;
  const screen = root.querySelector<HTMLElement>("[data-term-screen]");
  const time = root.querySelector<HTMLElement>("[data-term-time]");
  const state = root.querySelector<HTMLElement>("[data-term-state]");
  const play = root.querySelector<HTMLButtonElement>("[data-term-play]");
  const progress = root.querySelector<HTMLInputElement>("[data-term-progress]");
  if (!raw || !screen || !time || !state || !play || !progress) return;
  const d = JSON.parse(raw) as Data;

  // The playback timeline: recorded times with long pauses shortened, and the night (the longest
  // pause between the limit and the continue) shown as the clock running fast.
  const real = d.frames.map((f) => f[0] ?? 0);
  let night = { at: -1, from: 0, to: 0 };
  for (let i = 1; i < real.length; i++) {
    const from = real[i - 1] ?? 0;
    const to = real[i] ?? 0;
    if (from >= d.marks.limit && to <= d.marks.continued + 5000 && to - from > night.to - night.from)
      night = { at: i, from, to };
  }
  const at: number[] = [0];
  for (let i = 1; i < real.length; i++) {
    const gap = (real[i] ?? 0) - (real[i - 1] ?? 0);
    at.push((at[i - 1] ?? 0) + (i === night.at ? NIGHT_MS : Math.min(gap, GAP_MS)));
  }
  const total = (at[at.length - 1] ?? 0) + HOLD_MS;
  const frameAt = (v: number) => {
    let lo = 0;
    let hi = at.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((at[mid] ?? 0) <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** The recorded time at playback time `v`: during the night, the clock runs fast. */
  const realAt = (v: number) => {
    const i = frameAt(v);
    const next = i + 1;
    if (next === night.at) {
      const from = (at[next] ?? 0) - NIGHT_MS;
      if (v >= from) return night.from + ((night.to - night.from) * (v - from)) / NIGHT_MS;
    }
    return Math.min((real[i] ?? 0) + (v - (at[i] ?? 0)), real[next] ?? Number.POSITIVE_INFINITY);
  };
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: d.zone, hour: "numeric", minute: "2-digit" });
  const first = (re: RegExp) => Math.max(0, d.text.findIndex((t) => re.test(t)));
  const chapters: Record<string, number> = {
    limit: at[first(/hit your .*limit/)] ?? 0,
    ask: at[first(/Continue this session automatically/)] ?? 0,
    continued: at[first(/Sent automatically by Agent Rewake/)] ?? 0,
  };
  const stateAt = (r: number) =>
    r >= d.marks.continued
      ? "Continued by Rewake"
      : night.at > 0 && r >= night.from
        ? "Waiting for the reset"
        : r >= d.marks.limit
          ? "Usage limit reached"
          : "Working";

  let v = total - HOLD_MS;
  let shown = -1;
  let playing = false;
  let last = 0;
  let wanted = !reduce.matches;
  let visible = false;

  const render = () => {
    const i = frameAt(v);
    if (i !== shown) {
      shown = i;
      screen.innerHTML = (d.frames[i] ?? [])
        .slice(1)
        .map((id) => d.lines[id] ?? "")
        .join("");
    }
    const r = realAt(v);
    const s = stateAt(r);
    time.textContent = clock.format(d.start + r);
    state.textContent = s;
    root.dataset.state = s === "Waiting for the reset" ? "night" : "";
    progress.value = String(Math.round((v / total) * 1000));
  };
  const tick = (now: number) => {
    if (!playing) return;
    v += now - last;
    last = now;
    if (v >= total) v = 0;
    render();
    requestAnimationFrame(tick);
  };
  const setPlaying = (on: boolean) => {
    if (on === playing) return;
    playing = on;
    play.setAttribute("aria-label", on ? "Pause the recording" : "Play the recording");
    root.classList.toggle("is-playing", on);
    if (on) {
      if (v >= total - HOLD_MS) v = 0;
      last = performance.now();
      requestAnimationFrame(tick);
    }
  };
  const seek = (to: number) => {
    v = Math.max(0, Math.min(to, total - 1));
    render();
  };

  play.addEventListener("click", () => {
    wanted = !playing;
    setPlaying(wanted);
  });
  for (const b of root.querySelectorAll<HTMLButtonElement>("[data-term-seek]"))
    b.addEventListener("click", () => {
      seek(chapters[b.dataset.termSeek ?? ""] ?? 0);
      wanted = true;
      setPlaying(true);
    });
  progress.addEventListener("input", () => seek((Number(progress.value) / 1000) * total));
  new IntersectionObserver(
    ([entry]) => {
      visible = !!entry?.isIntersecting;
      setPlaying(visible && wanted);
    },
    { threshold: 0.25 },
  ).observe(root);
  document.addEventListener("visibilitychange", () => setPlaying(!document.hidden && visible && wanted));
}
