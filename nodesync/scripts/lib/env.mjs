// nodesync/scripts/lib/env.mjs
// Đọc cấu hình nodesync từ ENV + config.jsonc.
//
// QUY TẮC (kiến trúc dynamic hiện hành — xem report 06/07):
//   - Sidecar là client/controller: KHÔNG tạo user, KHÔNG chạy sshd. SSH server
//     được bootstrap trên CI runner (scripts/runners/setup-nodesync-ssh.mjs),
//     dùng 1 keypair Ed25519 chung, key-only (không password/không root).
//     Keypair: SSH_1_PRIVATE_KEY / SSH_1_PUBLIC_KEY (có thể *_B64=1).
//   - Kênh: SSH_CHANNEL_TAILSCALE_ENABLE / _CLOUDFLARE_ENABLE / _HYBRID_ENABLE.
//   - KHÔNG parse .env bằng regex thô — env đã có sẵn trong process.env (Compose
//     inject qua env_file).

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Giải mã base64 nếu cờ *_B64 bật; ngược lại trả nguyên văn.
function maybeB64(value, isB64) {
  if (value == null) return value;
  if (!isB64) return value;
  try {
    return Buffer.from(String(value).trim(), "base64").toString("utf8");
  } catch {
    return value;
  }
}

function truthy(v, def = "0") {
  const s = String(v ?? def).toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// Nạp config.jsonc (mặc định), cho phép override vài field bằng env.
export function loadConfig() {
  const file = resolve(__dirname, "..", "..", "config.jsonc");
  const defaults = {
    channel_priority: ["tailscale", "cloudflare", "hybrid"],
    sync_paths: [],
    rsync_options: ["-az", "--delete", "--checksum", "--safe-links", "--stats", "--human-readable"],
    ssh_connect_timeout_seconds: 10,
    sync_timeout_seconds: 600,
    diff_timeout_seconds: 120,
  };
  let cfg = defaults;
  if (existsSync(file)) {
    try {
      cfg = { ...defaults, ...parseJsonc(readFileSync(file, "utf8")) };
    } catch {
      cfg = defaults;
    }
  }
  // Override bằng env (nếu có).
  if (Object.hasOwn(process.env, "NODESYNC_SYNC_PATHS")) {
    cfg.sync_paths = process.env.NODESYNC_SYNC_PATHS.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return cfg;
}

// Thư mục workspace mount (chứa dữ liệu cần sync + file cờ hold).
export function workspaceDir() {
  return process.env.SSH_WORKSPACE || process.env.ORCH_REPO_DIR || "/workspace";
}

// Kênh nào được bật + thứ tự ưu tiên fallback.
export function enabledChannels(config = loadConfig(), env = process.env) {
  const flags = {
    tailscale: truthy(env.SSH_CHANNEL_TAILSCALE_ENABLE, "1"), // mặc định bật tailscale
    cloudflare: truthy(env.SSH_CHANNEL_CLOUDFLARE_ENABLE, "0"),
    hybrid: truthy(env.SSH_CHANNEL_HYBRID_ENABLE, "0"),
  };
  return (config.channel_priority || ["tailscale", "cloudflare", "hybrid"]).filter((c) => flags[c]);
}

// nodesync có được bật không (SSH_ENABLE=1).
export function nodesyncEnabled(env = process.env) {
  return truthy(env.SSH_ENABLE, "0");
}

export { truthy, maybeB64 };
