/**
 * Plays the illustrations ("scenes") step by step while they're on screen. Without JavaScript, or
 * with prefers-reduced-motion, a scene shows its final state, which is complete on its own.
 *
 * Inside an element with [data-scene] (and data-steps="ms,ms,…": how long each step holds):
 *   [data-at="n"]     shown from step n on
 *   [data-only="n,m"] shown only at those steps (data-final: also in the static final state)
 *   [data-until="n"]  shown before step n
 * Scenes loop, pausing on the last step. Off screen, they stop.
 */
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

function nums(v: string | null): number[] {
  return (v ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x));
}

function render(scene: HTMLElement, step: number) {
  scene.dataset.step = String(step);
  for (const el of scene.querySelectorAll<HTMLElement>("[data-at],[data-only],[data-until]")) {
    let on = true;
    if (el.dataset.at !== undefined) on &&= step >= Number(el.dataset.at);
    if (el.dataset.only !== undefined) on &&= nums(el.dataset.only).includes(step);
    if (el.dataset.until !== undefined) on &&= step < Number(el.dataset.until);
    el.classList.toggle("rw-off", !on);
  }
}

function play(scene: HTMLElement) {
  const holds = nums(scene.dataset.steps);
  if (holds.length === 0) return;
  let step = 0;
  let timer: number | undefined;
  let visible = false;
  let paused = false;
  const tick = () => {
    render(scene, step);
    const hold = holds[step] ?? 2000;
    timer = window.setTimeout(() => {
      step = step + 1 >= holds.length ? 0 : step + 1;
      if (visible && !paused) tick();
    }, hold);
  };
  const start = () => {
    if (timer !== undefined || paused || reduce.matches) return;
    scene.classList.add("is-live");
    tick();
  };
  const stop = () => {
    window.clearTimeout(timer);
    timer = undefined;
  };
  new IntersectionObserver(
    ([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
      else stop();
    },
    { threshold: 0.35 },
  ).observe(scene);
  reduce.addEventListener("change", () => {
    if (reduce.matches) {
      stop();
      scene.classList.remove("is-live");
    } else if (visible) start();
  });
  // Pause / Play (WCAG 2.2.2: anything that moves for more than 5 seconds can be paused).
  const button = scene.querySelector<HTMLButtonElement>("[data-pause]");
  if (button) {
    button.hidden = reduce.matches;
    button.addEventListener("click", () => {
      paused = !paused;
      button.textContent = paused ? "Play" : "Pause";
      button.setAttribute("aria-pressed", String(paused));
      if (paused) stop();
      else if (visible) start();
    });
    reduce.addEventListener("change", () => {
      button.hidden = reduce.matches;
    });
  }
}

// Calm reveals for sections: content is visible without JavaScript; the script only adds motion.
function reveals() {
  if (reduce.matches) return;
  const els = document.querySelectorAll<HTMLElement>("[data-reveal]");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
    },
    { threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
  );
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.top > window.innerHeight) {
      el.classList.add("rw-pre");
      io.observe(el);
    } else el.classList.add("is-in");
  }
}

for (const scene of document.querySelectorAll<HTMLElement>("[data-scene]")) play(scene);
reveals();
