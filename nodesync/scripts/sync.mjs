#!/usr/bin/env node
// nodesync/scripts/sync.mjs
// LUỒNG ĐỒNG BỘ DỮ LIỆU node02 ← node01 (YÊU CẦU chính Phần 2).
//
// Khi node02 khởi động:
//   1) (đã pull remote store trước — do start-stack litestream/rclone; ở đây
//      chỉ VERIFY và log). Có thể ép pull bằng --pull.
//   2) DIFF với node01 qua SSH (checksum từng sync_path).
//   3) Nếu KHÁC BIỆT: yêu cầu node01 BẬT hold (503 Retry-After) → rsync trực
//      tiếp node01 → node02 → node01 TẮT hold.
//   4) Xong → in báo cáo (file nào đổi, thời gian, kích thước) → app start tiếp.
//
// Fallback kênh: Tailscale → Cloudflare → Hybrid (lib/ssh.mjs).
//
//   node scripts/sync.mjs                 # chạy full luồng
//   node scripts/sync.mjs --dry-run       # in kế hoạch, không rsync/ssh thật
//   node scripts/sync.mjs --silent
//   node scripts/sync.mjs --local-demo    # chế độ demo cục bộ (không ssh), xem verify
//
// Env chính: xem .env.example (SSH_*, NODESYNC_PEER_*).

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, workspaceDir, enabledChannels, peerConfig, nodesyncEnabled, collectSshUsers } from "./lib/env.mjs";
import { resolvePeer, sshBaseArgs, run } from "./lib/ssh.mjs";
import { log, warn, error, stepTimer } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const LOCAL_DEMO = args.includes("--local-demo");

const cfg = loadConfig();
const WS = workspaceDir();

// Chạy 1 lệnh, trả kết quả (tôn trọng --dry-run).
function exec(cmd, argv, { timeout = 60000 } = {}) {
  if (DRY_RUN) { log(`[DRY RUN] ${cmd} ${argv.join(" ")}`); return { ok: true, out: "", err: "", status: 0 }; }
  const res = spawnSync(cmd, argv, { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 });
  return { ok: res.status === 0, out: (res.stdout || "").trim(), err: (res.stderr || "").trim(), status: res.status };
}

// Checksum tổng hợp 1 path (sha256 của danh sách file+size+mtime → so nhanh).
function localFingerprint(pathRel) {
  const abs = resolve(WS, pathRel);
  if (!existsSync(abs)) return { path: pathRel, exists: false, fingerprint: "MISSING" };
  // find + sha256sum (ổn định, có sẵn trong alpine coreutils/busybox).
  const cmd = `cd ${JSON.stringify(WS)} && find ${JSON.stringify(pathRel)} -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -d' ' -f1`;
  const r = exec("sh", ["-lc", cmd]);
  return { path: pathRel, exists: true, fingerprint: r.ok ? r.out : "ERR" };
}

// Lấy fingerprint của peer qua ssh (chạy cùng lệnh find|sha256 trên node01).
function remoteFingerprint(sshTarget, sshArgs, pathRel) {
  const remoteCmd = `cd ${JSON.stringify(cfg.remote_workspace || WS)} && find ${JSON.stringify(pathRel)} -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -d' ' -f1`;
  const r = exec("ssh", [...sshArgs, sshTarget, remoteCmd], { timeout: cfg.diff_timeout_seconds * 1000 });
  return { path: pathRel, fingerprint: r.ok ? r.out : "ERR", err: r.err };
}

// Gọi node01 bật/tắt hold qua ssh.
function remoteHold(sshTarget, sshArgs, onoff) {
  const remoteCmd = `cd ${JSON.stringify(cfg.remote_workspace || WS)} && node nodesync/scripts/hold-requests.mjs ${onoff} --silent`;
  const r = exec("ssh", [...sshArgs, sshTarget, remoteCmd], { timeout: 30000 });
  if (r.ok) log(`node01 hold → ${onoff.toUpperCase()} (OK)`);
  else warn(`node01 hold → ${onoff} có thể thất bại: ${r.err}`);
  return r.ok;
}

// rsync 1 path từ node01 về node02.
function rsyncPull(sshTarget, sshArgs, pathRel) {
  const t = stepTimer(`rsync path "${pathRel}" từ node01`);
  const srcRoot = cfg.remote_workspace || WS;
  const src = `${sshTarget}:${srcRoot.replace(/\/$/, "")}/${pathRel}/`;
  const dest = `${resolve(WS, pathRel)}/`;
  const rsh = `ssh ${sshArgs.join(" ")}`;
  const argv = [...cfg.rsync_options, "-e", rsh, src, dest];
  if (!DRY_RUN) { try { spawnSync("mkdir", ["-p", dest]); } catch {} }
  const r = exec("rsync", argv, { timeout: cfg.sync_timeout_seconds * 1000 });
  if (r.ok) {
    // Trích vài dòng --stats để log số file / bytes.
    const stats = (r.out || "").split(/\r?\n/).filter((l) => /Number of|Total|transferred|size/i.test(l)).slice(0, 6);
    t.end(`(${stats.join(" | ") || "no-stats"})`);
    return { path: pathRel, ok: true, stats };
  }
  t.fail(r.err || `exit ${r.status}`);
  return { path: pathRel, ok: false, err: r.err };
}

async function main() {
  log("=== NODESYNC: bắt đầu luồng đồng bộ node02 ← node01 ===");
  log(`workspace=${WS} sync_paths=[${cfg.sync_paths.join(", ")}]`);

  if (!nodesyncEnabled()) {
    log("SSH_ENABLE != 1 → nodesync tắt. Bỏ qua sync (app sẽ start bình thường).");
    process.exit(0);
  }

  // Bước 1: (đã pull remote store trước qua litestream/rclone). Log xác nhận.
  const t0 = stepTimer("Bước 1: xác nhận remote store đã pull (litestream/rclone)");
  for (const p of cfg.sync_paths) {
    const abs = resolve(WS, p);
    log(`  ${p}: ${existsSync(abs) ? "có mặt" : "CHƯA có (sẽ tạo khi sync)"}`);
  }
  t0.end();

  // Chế độ demo cục bộ: không ssh, chỉ minh hoạ fingerprint (dùng khi không có peer/tailnet).
  if (LOCAL_DEMO) {
    warn("LOCAL_DEMO: không có peer thật — chỉ tính fingerprint cục bộ để minh hoạ. Xem verify-integrity.mjs để kiểm chứng sync 2 node.");
    for (const p of cfg.sync_paths) log(`  fingerprint(${p}) = ${localFingerprint(p).fingerprint}`);
    process.exit(0);
  }

  // Bước 2: resolve peer (fallback Tailscale→Cloudflare→Hybrid).
  const channels = enabledChannels(cfg);
  const peer = peerConfig();
  if (peer.user === "") {
    const u1 = collectSshUsers()[0];
    if (u1) peer.user = u1.user;
  }
  log(`Kênh enable (thứ tự fallback): [${channels.join(" → ") || "(none)"}]; peer.user=${peer.user || "(chưa set)"}`);
  const { resolved, attempts } = resolvePeer(channels, peer);
  if (!resolved) {
    error("Không resolve được node01 qua bất kỳ kênh nào. Chi tiết từng kênh:");
    attempts.forEach((a) => error(`  - ${a.channel}: ${a.reason}`));
    error("→ DEBUG: kiểm tra tailnet đã join chưa (tailscale status), hoặc set NODESYNC_PEER_HOST cho kênh hybrid.");
    // Không chặn app start: node02 chạy độc lập với dữ liệu remote đã pull.
    process.exit(cfg.fail_hard ? 1 : 0);
  }

  const sshArgs = sshBaseArgs(resolved, {
    user: peer.user, port: peer.port,
    connectTimeout: cfg.ssh_connect_timeout_seconds,
  });
  const sshTarget = `${peer.user}@${resolved.host}`;

  // Bước 3: diff từng path.
  const tDiff = stepTimer("Bước 2: DIFF dữ liệu với node01 (checksum)");
  const diffs = [];
  for (const p of cfg.sync_paths) {
    const local = localFingerprint(p);
    const remote = remoteFingerprint(sshTarget, sshArgs, p);
    const differ = local.fingerprint !== remote.fingerprint;
    diffs.push({ path: p, local: local.fingerprint, remote: remote.fingerprint, differ });
    log(`  ${p}: local=${local.fingerprint?.slice(0, 12)} remote=${remote.fingerprint?.slice(0, 12)} → ${differ ? "KHÁC (cần sync)" : "GIỐNG"}`);
  }
  tDiff.end();

  const toSync = diffs.filter((d) => d.differ).map((d) => d.path);
  if (toSync.length === 0) {
    log("Không có path nào khác biệt → KHÔNG cần sync. App có thể start ngay.");
    process.exit(0);
  }

  // Bước 4: node01 bật hold → rsync → tắt hold.
  log(`Cần sync ${toSync.length} path: [${toSync.join(", ")}]`);
  const tHold = stepTimer("Bước 3: yêu cầu node01 BẬT treo request (503 Retry-After)");
  remoteHold(sshTarget, sshArgs, "on");
  tHold.end();

  const results = [];
  const tSync = stepTimer("Bước 4: rsync dữ liệu node01 → node02");
  for (const p of toSync) results.push(rsyncPull(sshTarget, sshArgs, p));
  tSync.end();

  const tOff = stepTimer("Bước 5: yêu cầu node01 TẮT treo request");
  remoteHold(sshTarget, sshArgs, "off");
  tOff.end();

  // Báo cáo.
  const okAll = results.every((r) => r.ok);
  log("=== BÁO CÁO SYNC ===");
  results.forEach((r) => log(`  ${r.ok ? "✔" : "✘"} ${r.path}${r.ok ? "" : " — " + r.err}`));
  log(`Kết quả: ${okAll ? "TẤT CẢ OK ✅" : "CÓ LỖI ❌"}. App ${okAll ? "sẵn sàng start" : "nên retry / start với dữ liệu remote"}.`);
  process.exit(okAll ? 0 : (cfg.fail_hard ? 1 : 0));
}

main().catch((e) => { error(`sync fatal: ${e.stack || e.message}`); process.exit(1); });
