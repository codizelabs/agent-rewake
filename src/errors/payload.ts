import { randomUUID } from "node:crypto";
import { arch, platform, release } from "node:os";
import { VERSION } from "../version.js";
import { reportingEnvironment } from "./consent.js";
import type { Dsn } from "./dsn.js";
import { scrubMessage, scrubStack } from "./scrub.js";

/** What goes in `tags` (AGENTS.md: "tags (place/host … os; os version; node version; …; command)"). */
export interface ReportTags {
  /** Where this ran: "zed", "claude-code", "codex", "copilot-cli", "cli", … */
  place: string;
  /** The wrapped agent's version, when Rewake knows it. */
  agentVersion?: string;
  /** The CLI command running when the error happened ("doctor", "fire", "install", …). */
  command?: string;
  test?: boolean;
}

export interface ErrorInput {
  /** The event name: becomes the Sentry "message" (AGENTS.md). */
  name: string;
  /** An Error, when there is one, for its type/message/stack. */
  error?: unknown;
  /** A plain message, used when there's no Error (e.g. "armTimer failed, no re-arm"). */
  message?: string;
  level?: "error" | "warning" | "info";
  tags: ReportTags;
  fromSource: boolean;
  home: string;
}

export interface SentryEvent {
  event_id: string;
  timestamp: string;
  level: string;
  platform: "node";
  release: string;
  environment: "production" | "development";
  message: { formatted: string };
  tags: Record<string, string>;
  exception?: {
    values: Array<{
      type: string;
      value: string;
      stacktrace?: { frames: Array<{ filename?: string; function?: string; lineno?: number }> };
    }>;
  };
  user: { ip_address: null };
}

/** A 32-character hex event id (Sentry's `event_id`: no dashes). */
export function newEventId(): string {
  return randomUUID().replace(/-/g, "");
}

function errorTypeAndMessage(input: ErrorInput): { type: string; value: string; stack?: string } {
  const err = input.error;
  if (err instanceof Error)
    return {
      type: err.name || "Error",
      value: scrubMessage(err.message, input.home),
      ...(err.stack !== undefined && { stack: err.stack }),
    };
  if (input.message) return { type: "Error", value: scrubMessage(input.message, input.home) };
  return { type: "Error", value: input.name };
}

/** Build the event Sentry's payload wants, carrying only what's on the allow-list. */
export function buildEvent(input: ErrorInput, eventId: string, now: Date): SentryEvent {
  const { type, value, stack } = errorTypeAndMessage(input);
  const frames = scrubStack(stack);
  const tags: Record<string, string> = {
    place: input.tags.place,
    os: platform(),
    os_version: scrubMessage(release(), input.home),
    node_version: process.version,
    arch: arch(),
  };
  if (input.tags.agentVersion) tags.agent_version = input.tags.agentVersion;
  if (input.tags.command) tags.command = input.tags.command;
  if (input.tags.test) tags.test = "true";
  return {
    event_id: eventId,
    timestamp: now.toISOString(),
    level: input.level ?? "error",
    platform: "node",
    release: `agent-rewake@${VERSION}`,
    environment: reportingEnvironment(input.fromSource),
    message: { formatted: input.name },
    tags,
    ...(frames.length > 0 || input.error instanceof Error
      ? {
          exception: {
            values: [
              {
                type,
                value,
                ...(frames.length > 0 && {
                  stacktrace: {
                    frames: frames.map((f) => ({
                      ...(f.file && { filename: f.file }),
                      ...(f.function && { function: f.function }),
                      ...(f.lineno !== undefined && { lineno: f.lineno }),
                    })),
                  },
                }),
              },
            ],
          },
        }
      : {}),
    user: { ip_address: null },
  };
}

/**
 * The envelope body Sentry's ingest endpoint accepts: an envelope header line, an item header
 * line, and the event JSON — each its own line (develop.sentry.dev/sdk/data-model/envelopes).
 */
export function buildEnvelope(event: SentryEvent, dsn: Dsn): string {
  const header = {
    event_id: event.event_id,
    sent_at: new Date().toISOString(),
    dsn: `https://${dsn.publicKey}@${dsn.host}/${dsn.projectId}`,
  };
  const itemPayload = JSON.stringify(event);
  const itemHeader = {
    type: "event",
    content_type: "application/json",
    length: Buffer.byteLength(itemPayload, "utf8"),
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(itemHeader)}\n${itemPayload}\n`;
}

/** The `X-Sentry-Auth` header value (AGENTS.md's exact format). */
export function sentryAuthHeader(dsn: Dsn): string {
  return `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=agent-rewake/${VERSION}`;
}
