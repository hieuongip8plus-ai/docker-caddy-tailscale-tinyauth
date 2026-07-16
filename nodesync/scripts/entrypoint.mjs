#!/usr/bin/env node
// nodesync/scripts/entrypoint.mjs
// Entrypoint container nodesync (CMD Dockerfile). Chạy như ROOT để có quyền cao
// nhất (tạo user, chạy lệnh trong/ngoài docker qua socket mount).
//
// Trình tự:
//   1) Nếu SSH_ENABLE != 1 → chỉ log rồi ngủ (idle, giữ container sống).
//   2) Cấu hình sshd_config theo config.jsonc (password auth, permit root...).
//   3) Tạo host keys nếu chưa có.
//   4) setup-users.mjs (tạo multi-user + phân quyền sudo NOPASSWD).
//   5) Start sshd foreground.
//
//   node scripts/entrypoint.mjs
//   node scripts/entrypoint.mjs --dry-run

import { spawnSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { loadConfig, nodesyncEnabled, collectSshUsers } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

function sh(cmd, argv) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd} ${argv.join(" ")}`); return { ok: true }; }
  const res = spawnSync(cmd, argv, { stdio: "inherit" });
  return { ok: res.status === 0 };
}

function writeSshdConfig(cfg) {
  const lines = [
    `Port ${cfg.sshd.port}`,
    "AddressFamily any",
    "ListenAddress 0.0.0.0",
    `PasswordAuthentication ${cfg.sshd.password_authentication ? "yes" : "no"}`,
    "PubkeyAuthentication yes",
    `PermitRootLogin ${cfg.sshd.permit_root_login ? "yes" : "prohibit-password"}`,
    "AuthorizedKeysFile .ssh/authorized_keys",
    "UsePAM no",
    // Cho phép chạy MỌI lệnh (không ForceCommand). Môi trường sync + điều khiển.
    "PermitTTY yes",
    "X11Forwarding no",
    "Subsystem sftp /usr/lib/ssh/sftp-server",
    "ClientAliveInterval 30",
    "ClientAliveCountMax 4",
  ];
  const content = lines.join("\n") + "\n";
  if (DRY_RUN) { log(`[DRY RUN] ghi /etc/ssh/sshd_config:\n${content}`); return; }
  mkdirSync("/etc/ssh", { recursive: true });
  writeFileSync("/etc/ssh/sshd_config", content);
  log("Đã ghi /etc/ssh/sshd_config theo config.jsonc");
}

function ensureHostKeys() {
  if (DRY_RUN) { log("[DRY RUN] ssh-keygen -A (tạo host keys)"); return; }
  if (!existsSync("/etc/ssh/ssh_host_ed25519_key")) {
    sh("ssh-keygen", ["-A"]);
    log("Đã tạo SSH host keys");
  } else log("SSH host keys đã có");
}

async function main() {
  const cfg = loadConfig();
  log("=== NODESYNC entrypoint ===");

  if (!nodesyncEnabled()) {
    log("SSH_ENABLE != 1 → nodesync IDLE (không mở sshd, không tạo user).");
    log("Đặt SSH_ENABLE=1 + SSH_1_USER=... để bật. Giữ container sống.");
    if (DRY_RUN) return;
    // eslint-disable-next-line no-constant-condition
    while (true) await new Promise((r) => setTimeout(r, 3600_000));
    return;
  }

  const users = collectSshUsers();
  log(`nodesync BẬT. Số user cấu hình: ${users.length} [${users.map((u) => u.user).join(", ") || "(chưa có)"}]`);

  writeSshdConfig(cfg);
  ensureHostKeys();

  // Tạo user + phân quyền.
  sh("node", ["scripts/setup-users.mjs", ...(DRY_RUN ? ["--dry-run"] : [])]);

  if (DRY_RUN) { log("[DRY RUN] sẽ exec: /usr/sbin/sshd -D -e"); return; }

  // Start sshd foreground (-D), log ra stderr (-e).
  log(`Khởi động sshd foreground trên port ${cfg.sshd.port}...`);
  const res = spawnSync("/usr/sbin/sshd", ["-D", "-e"], { stdio: "inherit" });
  process.exit(res.status ?? 0);
}

main().catch((e) => { error(`entrypoint fatal: ${e.stack || e.message}`); process.exit(1); });
