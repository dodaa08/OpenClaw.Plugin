import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject } from "./types/types.js";

export function resolveOpenClawDir(): string {
  const explicit = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) return explicit;
  const home = process.env.OPENCLAW_HOME?.trim();
  if (home) return join(home, ".openclaw");
  return join(homedir(), ".openclaw");
}

export function getErrorMessage(payload: JsonObject, fallback: string): string {
  if (typeof payload.error === "string" && payload.error.length > 0) return payload.error;
  if (typeof payload.message === "string" && payload.message.length > 0) return payload.message;
  return fallback;
}

