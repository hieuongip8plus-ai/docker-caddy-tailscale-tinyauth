// orchestrator/scripts/lib/ssh-identity.mjs
// Thu thập thông tin "runtime / nodesync" của node hiện tại để ghi vào node
// record RTDB — phục vụ yêu cầu:
//   "Trong phần orchestrator phải có thêm các thông tin này để chỗ này xử lý
//    như user, cwd đang làm việc..."
//
// Gồm:
//   - SSH users cấu hình qua env đa người dùng SSH_<n>_USER
//   - Kênh sync đang bật + thứ tự fallback (Tailscale → Cloudflare → Hybrid)
//   - user hệ thống hiện tại (whoami), cwd, có phải root/privileged không
//
// KHÔNG log/ghi secret (pass, private key) — chỉ ghi username + metadata.

import { spawnSync } from "node:child_process";

// Đọc user hệ thống hiện tại (an toàn).
function currentUser() {
  const fromEnv = process.env.USER || process.env.LOGNAME;
  if (fromEnv) return fromEnv;
  const res = spawnSync("whoami", { encoding: "utf8", timeout: 5000 });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

// uid (0 = root). process.getuid không có trên Windows.
function currentUid() {
  try {
    return typeof process.getuid === "function" ? process.getuid() : -1;
  } catch {
    return -1;
  }
}

// Nhặt danh sách SSH user đa người dùng theo pattern SSH_<n>_USER.
// (Chỉ lấy USERNAME — tuyệt đối không lấy PASS/PRIVATE_KEY.)
export function collectSshUsers() {
  const users = [];
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^SSH_(\d+)_USER$/);
    if (m && v) {
      const idx = Number(m[1]);
      users.push({
        index: idx,
        user: v,
        // Cho biết có được cấp key/pass không (không ghi giá trị).
        hasPassword: !!process.env[`SSH_${idx}_PASS`],
        hasPublicKey: !!process.env[`SSH_${idx}_PUBLIC_KEY`],
        hasPrivateKey: !!process.env[`SSH_${idx}_PRIVATE_KEY`],
        // Quyền: cho phép chạy mọi lệnh (sudo NOPASSWD) — mặc định true theo yêu cầu.
        privileged: String(process.env[`SSH_${idx}_PRIVILEGED`] ?? "1").toLowerCase() !== "0",
      });
    }
  }
  return users.sort((a, b) => a.index - b.index);
}

function channelEnabled(name, def = "0") {
  const v = String(process.env[`SSH_CHANNEL_${name}_ENABLE`] ?? def).toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// Thứ tự ưu tiên fallback: Tailscale → Cloudflare → Hybrid (chỉ liệt kê kênh bật).
export function activeChannels() {
  const order = [];
  if (channelEnabled("TAILSCALE", "1")) order.push("tailscale");
  if (channelEnabled("CLOUDFLARE", "0")) order.push("cloudflare");
  if (channelEnabled("HYBRID", "0")) order.push("hybrid");
  return order;
}

/**
 * Thông tin runtime/nodesync để ghi vào node record.
 *   {
 *     systemUser, uid, isRoot, cwd, repoDir,
 *     nodesyncEnabled, channels: [...], primaryChannel,
 *     sshUsers: [{ index, user, hasPassword, hasPublicKey, hasPrivateKey, privileged }],
 *   }
 */
export function getSshRuntimeIdentity() {
  const uid = currentUid();
  const channels = activeChannels();
  const sshEnable = String(process.env.SSH_ENABLE ?? "0").toLowerCase();
  return {
    systemUser: currentUser(),
    uid,
    isRoot: uid === 0,
    cwd: process.cwd(),
    repoDir: process.env.ORCH_REPO_DIR || process.env.SSH_WORKSPACE || "/workspace",
    nodesyncEnabled: sshEnable === "1" || sshEnable === "true" || sshEnable === "yes",
    channels,
    primaryChannel: channels[0] || null,
    sshUsers: collectSshUsers(),
  };
}
