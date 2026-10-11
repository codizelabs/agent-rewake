import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionLock } from "../core/lock.js";
import { writeFileAtomic } from "../core/store.js";
import { ensurePrivateDir } from "../util/paths.js";

/**
 * Several sessions limited on one account reset together, so their resumes fall due in the same
 * minute. Started at once they compete for the computer and, on a fresh quota, can hit the limit
 * again together. So a resume that is about to start waits for:
 *
 * - a free place: at most `MAX_CONCURRENT_RESUMES` resumed sessions run at once (the others wait,
 *   and start as a place frees up); and
 * - its turn: each starts `STAGGER_MS` after the one before, never waiting more than
 *   `MAX_STAGGER_WAIT_MS` for that.
 *
 * Places are lock files in the state folder, so every Rewake process on the computer shares them,
 * and a process that dies frees its place (the lock records its process id).
 */
export const MAX_CONCURRENT_RESUMES = 2;
export const STAGGER_MS = 5_000;
export const MAX_STAGGER_WAIT_MS = 60_000;
/** How long a resume waits for a free place before it is put back to try again later. */
export const SLOT_WAIT_MS = 10 * 60_000;
const SLOT_POLL_MS = 3_000;
const START_KEY = "resume-start";
const START_FILE = "resume-start.json";

export interface SlotOptions {
  stateDir: string;
  /** Tests: the clock and the pause (default: real). */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  max?: number;
  staggerMs?: number;
  maxWaitMs?: number;
  pollMs?: number;
}

let staggerNow = STAGGER_MS;

/** Tests of other things fire several resumes in a row: they set the gap to 0 (test/setup.ts). */
export function setStagger(ms: number): void {
  staggerNow = ms;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** When the last resume started, or 0. */
function lastStart(stateDir: string): number {
  try {
    const n = Number(readFileSync(join(stateDir, "locks", START_FILE), "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Wait for a place and for this resume's turn. Returns the function that gives the place back, or
 * undefined when no place freed up within `maxWaitMs` (the caller tries again later).
 */
export async function takeSlot(o: SlotOptions): Promise<(() => void) | undefined> {
  const clock = o.clock ?? Date.now;
  const sleep = o.sleep ?? realSleep;
  const max = o.max ?? MAX_CONCURRENT_RESUMES;
  const lock = new SessionLock(o.stateDir);
  const began = clock();
  let key: string | undefined;
  for (;;) {
    for (let i = 1; i <= max && !key; i++)
      if (lock.acquire(`resume-slot:${i}`)) key = `resume-slot:${i}`;
    if (key) break;
    if (clock() - began >= (o.maxWaitMs ?? SLOT_WAIT_MS)) return undefined;
    await sleep(o.pollMs ?? SLOT_POLL_MS);
  }
  const place = key;
  const release = () => lock.release(place);
  try {
    // One at a time through the turn-taking, so two that got places together don't both start now.
    const gap = o.staggerMs ?? staggerNow;
    const deadline = clock() + MAX_STAGGER_WAIT_MS;
    while (!lock.acquire(START_KEY) && clock() < deadline) await sleep(200);
    const mine = lock.holds(START_KEY);
    try {
      const wait = Math.min(lastStart(o.stateDir) + gap - clock(), deadline - clock());
      if (wait > 0) await sleep(wait);
      writeFileAtomic(ensurePrivateDir(join(o.stateDir, "locks")), START_FILE, `${clock()}\n`);
    } finally {
      if (mine) lock.release(START_KEY);
    }
  } catch (err) {
    release();
    throw err;
  }
  return release;
}
