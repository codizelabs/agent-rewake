import { join } from "node:path";
import { writeFileAtomic } from "../core/store.js";
import { readJsonFile } from "../util/fs.js";
import { ensurePrivateDir } from "../util/paths.js";
import type { Dsn } from "./dsn.js";
import { buildEnvelope, type SentryEvent, sentryAuthHeader } from "./payload.js";

/**
 * Never in the hot path (AGENTS.md: hooks have a budget of seconds, proxy mode owns stdout, so
 * nothing here ever awaits the network from a hook or the proxy). `enqueue` only appends to a
 * local file; `flush` is the only thing that talks to Sentry, called from the end of a
 * non-hook command, with a bounded timeout, and never thrown from.
 */

const QUEUE_FILE = "error-queue.json";
const CAP_FILE = "error-report-cap.json";
const DAILY_CAP = 20;
const FLUSH_TIMEOUT_MS = 3000;

interface CapState {
  day: string;
  count: number;
  fingerprints: string[];
}

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function readCap(stateDir: string, now: number): CapState {
  try {
    const raw = readJsonFile(join(stateDir, CAP_FILE)) as CapState;
    if (raw && raw.day === today(now)) return raw;
  } catch {
    // fall through to a fresh day
  }
  return { day: today(now), count: 0, fingerprints: [] };
}

function writeCap(stateDir: string, cap: CapState): void {
  try {
    writeFileAtomic(ensurePrivateDir(stateDir), CAP_FILE, `${JSON.stringify(cap)}\n`);
  } catch {
    // Losing the cap file just means the next event re-checks a fresh count; never fatal.
  }
}

/** A fingerprint for de-duplicating identical errors within the same day. */
export function fingerprint(event: SentryEvent): string {
  const exc = event.exception?.values[0];
  return `${event.tags.place}:${exc?.type ?? ""}:${exc?.value ?? ""}:${event.message.formatted}`;
}

/**
 * Whether this event may be queued at all today: at most 20 sent events per day per install, and
 * no two identical fingerprints the same day (AGENTS.md: "Sentry's own rate limit may not be in
 * force, so this cap matters"). Recording the attempt (even when capped) still happens in the
 * local ledger — only sending to Sentry is capped.
 */
export function underCap(stateDir: string, event: SentryEvent, now: number): boolean {
  const cap = readCap(stateDir, now);
  const fp = fingerprint(event);
  if (cap.count >= DAILY_CAP) return false;
  if (cap.fingerprints.includes(fp)) return false;
  return true;
}

export function recordSent(stateDir: string, event: SentryEvent, now: number): void {
  const cap = readCap(stateDir, now);
  const fp = fingerprint(event);
  writeCap(stateDir, {
    day: cap.day,
    count: cap.count + 1,
    fingerprints: [...cap.fingerprints, fp],
  });
}

function readQueue(stateDir: string): SentryEvent[] {
  try {
    const value = readJsonFile(join(stateDir, QUEUE_FILE));
    return Array.isArray(value) ? (value as SentryEvent[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(stateDir: string, events: SentryEvent[]): void {
  try {
    writeFileAtomic(ensurePrivateDir(stateDir), QUEUE_FILE, `${JSON.stringify(events)}\n`);
  } catch {
    // A lost queue write just means that event isn't retried; never throw from here.
  }
}

/** Add one event to the local queue. Synchronous, fast, and never throws: safe in a hot path. */
export function enqueue(stateDir: string, event: SentryEvent): void {
  try {
    const events = readQueue(stateDir);
    events.push(event);
    writeQueue(stateDir, events.slice(-DAILY_CAP * 2));
  } catch {
    // Dropped silently: a failed send (or queue write) is just lost, per AGENTS.md.
  }
}

export type FetchLike = typeof fetch;

/**
 * Send everything queued, respecting the daily cap and de-dup, bounded by a 3-second timeout per
 * event. Never throws, never retries in a loop: whatever doesn't go out this time stays queued for
 * the next flush. Call only from the end of a non-hook, non-proxy command.
 */
export async function flushQueue(
  stateDir: string,
  dsn: Dsn,
  now: number,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<{ sent: number; left: number }> {
  const pending = readQueue(stateDir);
  if (pending.length === 0) return { sent: 0, left: 0 };
  const remaining: SentryEvent[] = [];
  let sent = 0;
  for (const event of pending) {
    if (!underCap(stateDir, event, now)) {
      continue; // over the cap or a duplicate today: dropped, not retried forever
    }
    const ok = await sendOne(event, dsn, fetchImpl, timeoutMs);
    if (ok) {
      recordSent(stateDir, event, now);
      sent++;
    } else {
      remaining.push(event);
    }
  }
  writeQueue(stateDir, remaining);
  return { sent, left: remaining.length };
}

/** POST one envelope. Never throws: a network error, timeout or non-2xx just returns false. */
export async function sendOne(
  event: SentryEvent,
  dsn: Dsn,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(dsn.envelopeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": sentryAuthHeader(dsn),
      },
      body: buildEnvelope(event, dsn),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
