// nodesync/scripts/lib/shared/redact-utils.mjs
// Secret redaction for CI logs and docker inspect output.
// Loads rules from scripts/lib/redact-utils.jsonc (repo root). Falls back to defaults if missing.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(__dirname, "..", "..", "..", "..", "scripts", "lib", "redact-utils.jsonc");

const DEFAULTS = {
  env_keywords: [
    { pattern: "TOKEN",           mode: "contains" },
    { pattern: "SECRET",          mode: "contains" },
    { pattern: "PASSWORD",        mode: "contains" },
    { pattern: "PASS",            mode: "contains" },
    { pattern: "AUTH",            mode: "contains" },
    { pattern: "KEY",             mode: "contains" },
    { pattern: "COOKIE",          mode: "contains" },
    { pattern: "CREDENTIAL",      mode: "contains" },
    { pattern: "CLIENT_ID",       mode: "contains" },
    { pattern: "CLIENT_SECRET",   mode: "contains" },
    { pattern: "USERS",           mode: "contains" },
    { pattern: "SERVICE_ACCOUNT", mode: "contains" },
    { pattern: "ACCOUNT_ID",      mode: "contains" },
  ],
  field_patterns: [
    { pattern: "access-key-id",    mode: "contains" },
    { pattern: "secret-access-key", mode: "contains" },
  ],
};

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kwToRegexFragment({ pattern, mode }) {
  const e = esc(pattern);
  switch (mode) {
    case "starts_with": return e;
    case "ends_with":   return `[A-Z0-9_]*${e}`;
    case "exact":       return e;
    case "contains":
    default:            return `[A-Z0-9_]*${e}[A-Z0-9_]*`;
  }
}

function fieldToRegexFragment({ pattern, mode }) {
  const e = esc(pattern);
  switch (mode) {
    case "starts_with": return e;
    case "ends_with":   return `[a-z0-9_-]*${e}`;
    case "exact":       return e;
    case "contains":
    default:            return `[a-z0-9_-]*${e}[a-z0-9_-]*`;
  }
}

let _envPart = null;
let _fieldPart = null;

function ensureParts() {
  if (_envPart) return;
  let cfg;
  try {
    cfg = { ...DEFAULTS, ...parseJsonc(readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    cfg = DEFAULTS;
  }
  _envPart = cfg.env_keywords.map(kwToRegexFragment).join("|");
  _fieldPart = cfg.field_patterns.map(fieldToRegexFragment).join("|");
}

export function redactSecrets(value) {
  ensureParts();
  return String(value)
    .replace(new RegExp(`^(\\s*-?\\s*["']?[A-Z0-9_]*(?:${_envPart})[A-Z0-9_]*["']?\\s*[:=]\\s*).+$`, "gmi"), "$1[REDACTED]")
    .replace(new RegExp(`("?[A-Z0-9_]*(?:${_envPart})[A-Z0-9_]*"?=)[^",\\]\\s]+`, "gi"), "$1[REDACTED]")
    .replace(new RegExp(`((?:${_fieldPart}):\\s*).+`, "gi"), "$1[REDACTED]");
}
