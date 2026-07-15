#!/usr/bin/env node
// CI: ask opencode to inspect collected logs, env keys, and source code.
//
// Usage: node scripts/runners/ai-agents/opencode-analyze.mjs [--dry-run] [--silent]
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "jsonc-parser";
import { envGet, envKeys } from "../../lib/env-utils.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const log = (...a) => { if (!SILENT) console.log(...a); };

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const LOG_DIR = resolve(ROOT, "ci-logs");
const ANALYSIS_DIR = resolve(LOG_DIR, "analysis");
const CONFIG_FILE = resolve(__dirname, "opencode-analyze-config.jsonc");
const PROMPT_TEMPLATE_FILE = resolve(__dirname, "opencode-analyze-prompt.md");
const OPENCODE_CONFIG_SOURCE = resolve(__dirname, "opencode.json");
const OPENCODE_CONFIG_TARGET = resolve(ROOT, "opencode.json");
const PROMPT_FILE = resolve(ANALYSIS_DIR, "opencode-prompt.md");
const REPORT_FILE = resolve(ANALYSIS_DIR, "opencode-report.md");
const RAW_FILE = resolve(ANALYSIS_DIR, "opencode-raw-output.log");
const SAFE_WORKSPACE = resolve(ANALYSIS_DIR, "opencode-workspace");
const SAFE_PROMPT_FILE = resolve(SAFE_WORKSPACE, "ci-logs/analysis/opencode-prompt.md");
const SAFE_REPORT_FILE = resolve(SAFE_WORKSPACE, "ci-logs/analysis/opencode-report.md");
const SUMMARY_FILE = process.env.GITHUB_STEP_SUMMARY;
const ENV_FILE = resolve(ROOT, ".env");

process.chdir(ROOT);

function loadConfig() {
  const defaults = {
    timeout_ms: 600000,
    services: ["caddy", "tinyauth", "whoami", "cloudflared", "tailscale"],
    code_files: [
      "docker-compose.yml",
      "docker-compose.ci.yml",
      "networks/networks.yml",
      "caddy/caddy.yml",
      "tinyauth/tinyauth.yml",
      "whoami/whoami.yml",
      "cloudflare/cloudflare.yml",
      "tailscale/tailscale.yml",
      ".github/workflows/test.yml",
      "scripts/runners/setup-env.mjs",
      "scripts/runners/start-stack.mjs",
      "scripts/runners/collect-logs.mjs",
      "scripts/wait-and-test.mjs",
    ],
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  return { ...defaults, ...parse(readFileSync(CONFIG_FILE, "utf8")) };
}

const config = loadConfig();

function readMaybe(path, limit = 12000) {
  if (!existsSync(path)) return "";
  const value = readFileSync(path, "utf8");
  const excerpt = value.length > limit ? `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} chars]` : value;
  return redactSecrets(excerpt);
}

function redactSecrets(value) {
  return value
    .replace(/^(\s*-?\s*["']?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*["']?\s*[:=]\s*).+$/gmi, "$1[REDACTED]")
    .replace(/("?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASS|AUTH|KEY|COOKIE|CREDENTIAL|ACCOUNT_ID|CLIENT_ID|CLIENT_SECRET|USERS)[A-Z0-9_]*"?=)[^",\]\s]+/gi, "$1[REDACTED]");
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (base) => {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const full = join(base, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(ROOT, full).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return out.sort();
}

function envSummary() {
  const keys = envKeys(ENV_FILE);
  const important = [
    "COMPOSE_PROFILES",
    "CF_TUNNEL_TOKEN",
    "WHOAMI_HOST",
    "DOMAIN",
    "TINYAUTH_APPURL",
    "TINYAUTH_AUTH_USERS",
    "TINYAUTH_AUTH_SECURECOOKIE",
    "CADDY_HTTP_PORT",
  ];
  const masked = important
    .filter((key) => keys.includes(key))
    .map((key) => `- ${key}: ${envGet(ENV_FILE, key) ? `set (${envGet(ENV_FILE, key).length} chars)` : "empty"}`);
  return [
    `Env file exists: ${existsSync(ENV_FILE)}`,
    `Keys: ${keys.join(", ") || "(none)"}`,
    "",
    "Important keys, masked:",
    masked.join("\n") || "(none)",
  ].join("\n");
}

function buildPrompt() {
  const logFiles = listFiles(LOG_DIR);
  const codeRefs = config.code_files.filter((file) => existsSync(resolve(ROOT, file)));
  const collectedLogs = logFiles
    .filter((file) => /(^ci-logs\/MANIFEST|compose-ps|public-url|all-services|services\/.*\.log$|inspect\/.*\.json$)/.test(file))
    .slice(0, 40)
    .map((file) => `## ${file}\n\`\`\`\n${readMaybe(resolve(ROOT, file), 16000)}\n\`\`\``)
    .join("\n\n");

  return readFileSync(PROMPT_TEMPLATE_FILE, "utf8")
    .replaceAll("{{CODE_REFS}}", codeRefs.join(", "))
    .replaceAll("{{LOG_FILES}}", logFiles.join("\n") || "(ci-logs missing)")
    .replaceAll("{{ENV_SUMMARY}}", envSummary())
    .replaceAll("{{COLLECTED_LOGS}}", collectedLogs || "(no collected logs found)");
}

function findOpencode() {
  const commands = process.platform === "win32"
    ? [["where.exe", ["opencode"]]]
    : [["bash", ["-lc", "command -v opencode"]]];
  for (const [cmd, cmdArgs] of commands) {
    try {
      const found = execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim().split(/\r?\n/)[0];
      if (found) return found;
    } catch {}
  }
  return "";
}

function writeFallbackReport(title, body) {
  const report = [
    "# Opencode CI Analysis Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Status: ${title}`,
    "",
    body,
    "",
    "## Available Evidence",
    "",
    `- Logs directory: ${existsSync(LOG_DIR) ? "present" : "missing"}`,
    `- Prompt file: ${relative(ROOT, PROMPT_FILE).replaceAll("\\", "/")}`,
    `- Env: ${envSummary().replace(/\n/g, "\n  ")}`,
  ].join("\n");
  writeFileSync(REPORT_FILE, report);
  return report;
}

function writeSafeFile(file, value) {
  const target = resolve(SAFE_WORKSPACE, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, redactSecrets(value));
}

function prepareSafeWorkspace(prompt) {
  rmSync(SAFE_WORKSPACE, { recursive: true, force: true });
  mkdirSync(SAFE_WORKSPACE, { recursive: true });

  for (const file of config.code_files) {
    const source = resolve(ROOT, file);
    if (existsSync(source)) writeSafeFile(file, readMaybe(source, 50000));
  }

  for (const file of listFiles(LOG_DIR)) {
    if (!file.startsWith("ci-logs/analysis/opencode-workspace/")) {
      writeSafeFile(file, readMaybe(resolve(ROOT, file), 50000));
    }
  }

  writeSafeFile("ci-logs/analysis/opencode-prompt.md", prompt);
}

function appendSummary(text) {
  if (!SUMMARY_FILE) return;
  try {
    writeFileSync(SUMMARY_FILE, text, { flag: "a" });
  } catch {}
}

function ensureOpencodeConfig() {
  if (existsSync(OPENCODE_CONFIG_SOURCE)) {
    copyFileSync(OPENCODE_CONFIG_SOURCE, OPENCODE_CONFIG_TARGET);
  }
}

async function runOpencode(opencodePath) {
  const shortPrompt = "Analyze this CI run. Read the attached prompt and repository files. Write the final markdown report to ci-logs/analysis/opencode-report.md.";
  return new Promise((resolve) => {
    const proc = spawn(opencodePath, ["run", shortPrompt, "--auto", "--file", SAFE_PROMPT_FILE], {
      cwd: SAFE_WORKSPACE,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      stderr += `\n[TIMEOUT] opencode exceeded ${config.timeout_ms}ms\n`;
    }, config.timeout_ms);

    proc.stdout.on("data", (data) => {
      const value = redactSecrets(data.toString());
      stdout += value;
    });
    proc.stderr.on("data", (data) => {
      const value = redactSecrets(data.toString());
      stderr += value;
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\n${error.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  const prompt = buildPrompt();
  writeFileSync(PROMPT_FILE, prompt);
  prepareSafeWorkspace(prompt);
  log(`Prompt saved: ${PROMPT_FILE}`);
  log(`Safe opencode workspace: ${SAFE_WORKSPACE}`);

  if (DRY_RUN) {
    log(`[DRY RUN] Would run opencode run <message> --auto --file ${PROMPT_FILE}`);
    return;
  }

  ensureOpencodeConfig();
  const opencodePath = findOpencode();
  if (!opencodePath) {
    writeFallbackReport("opencode not found", "The opencode CLI was not available in PATH, so agent analysis could not run.");
    appendSummary("\n## Opencode Analysis\n\nopencode not found. Fallback report written to `ci-logs/analysis/opencode-report.md`.\n");
    return;
  }

  log(`opencode: ${opencodePath}`);
  const result = await runOpencode(opencodePath);
  if (existsSync(SAFE_REPORT_FILE)) {
    writeFileSync(REPORT_FILE, redactSecrets(readFileSync(SAFE_REPORT_FILE, "utf8")));
  }
  const raw = [
    `exit_code=${result.code}`,
    "",
    "===== stdout =====",
    redactSecrets(result.stdout || "(empty)"),
    "",
    "===== stderr =====",
    redactSecrets(result.stderr || "(empty)"),
  ].join("\n");
  writeFileSync(RAW_FILE, raw);

  if (!existsSync(REPORT_FILE) || readFileSync(REPORT_FILE, "utf8").trim() === "") {
    writeFallbackReport(
      `opencode exited ${result.code}`,
      [
        "opencode did not create `ci-logs/analysis/opencode-report.md`; captured stdout/stderr below.",
        "",
        "## opencode stdout",
        "```",
        redactSecrets(result.stdout.slice(0, 20000) || "(empty)"),
        "```",
        "",
        "## opencode stderr",
        "```",
        redactSecrets(result.stderr.slice(0, 20000) || "(empty)"),
        "```",
      ].join("\n"),
    );
  }

  appendSummary("\n## Opencode Analysis\n\nReport: `ci-logs/analysis/opencode-report.md`\nRaw output: `ci-logs/analysis/opencode-raw-output.log`\n");
}

main().catch((error) => {
  mkdirSync(ANALYSIS_DIR, { recursive: true });
  writeFallbackReport("runner fatal error", error.stack || error.message);
  console.error(error.stack || error.message);
  process.exit(1);
});
