// nodesync/scripts/lib/ssh.mjs
// Kênh kết nối SSH giữa các node + RESOLVE peer đúng cách cho từng kênh.
//
// FALLBACK: Tailscale → Cloudflare → Hybrid (theo config.channel_priority +
// kênh nào được enable). Mỗi kênh trả về "target" (host/proxy) để chạy ssh/rsync.
//
// ── RESOLVE DNS TAILSCALE (theo tài liệu chính thức) ─────────────────────────
// Stack dùng userspace mode + `--accept-dns=false` ⇒ MagicDNS .ts.net KHÔNG
// resolve qua /etc/resolv.conf. Cách ĐÚNG (docs):
//   1) Ưu tiên LocalAPI: `tailscale status --json` → map hostname/dnsName → IP
//      100.x.y.z. Đây là nguồn tin cậy nhất trong userspace.
//   2) `tailscale ip -4 <host>` cũng resolve host→IP qua tailnet.
//   3) Nếu bật accept-dns + có Quad100 (100.100.100.100) thì .ts.net resolve
//      qua system DNS được — nhưng ta KHÔNG phụ thuộc vào điều này.
//   Docs: quad100, magicdns, userspace-networking, tailscale-ssh.
//
// ── CLOUDFLARE ───────────────────────────────────────────────────────────────
// Dùng `cloudflared access ssh --hostname <h>` làm ProxyCommand để tunnel SSH
// qua edge Cloudflare (không phụ thuộc tailnet). Cần cấu hình ingress SSH.
//
// ── HYBRID ────────────────────────────────────────────────────────────────────
// Kết nối trực tiếp IP/host cấu hình (NODESYNC_PEER_HOST) — dùng khi 2 kênh
// trên không sẵn, hoặc trong test (2 container cùng docker network).

import { spawnSync } from "node:child_process";
import { log, warn, error } from "./log.mjs";

// Chạy 1 lệnh, trả { ok, out, err }.
export function run(cmd, args, { timeout = 15000, input } = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", timeout, input, maxBuffer: 16 * 1024 * 1024 });
  return {
    ok: res.status === 0,
    status: res.status,
    out: (res.stdout || "").toString().trim(),
    err: (res.stderr || res.error?.message || "").toString().trim(),
  };
}

function tryJson(s) { try { return JSON.parse(s); } catch { return null; } }

// Resolve peer qua TAILSCALE. Trả { channel, host, reason, method }.
// host = IP tailnet (ưu tiên) hoặc FQDN .ts.net.
export function resolveTailscale(peer) {
  // 1) tailscale status --json (LocalAPI) — đúng userspace + accept-dns=false.
  const status = run(["tailscale"][0], ["status", "--json"], { timeout: 12000 });
  if (status.ok && status.out) {
    const j = tryJson(status.out);
    if (j && j.Peer) {
      const want = (peer.tailscaleHost || "").toLowerCase();
      for (const p of Object.values(j.Peer)) {
        const host = (p.HostName || "").toLowerCase();
        const dns = (p.DNSName || "").replace(/\.$/, "").toLowerCase();
        if (want && (host === want || dns === want || dns.startsWith(`${want}.`))) {
          const ip = (p.TailscaleIPs || []).find((x) => x.includes(".")) || (p.TailscaleIPs || [])[0];
          if (ip) return { channel: "tailscale", host: ip, method: "status-json", reason: null };
          if (p.DNSName) return { channel: "tailscale", host: p.DNSName.replace(/\.$/, ""), method: "status-json-dns", reason: null };
        }
      }
    }
  } else {
    return { channel: "tailscale", host: null, method: "status-json", reason: `tailscale status --json thất bại: ${status.err || "no output"} (tailnet chưa join / thiếu authkey / tailscale-cli không có)` };
  }

  // 2) tailscale ip -4 <host>
  if (peer.tailscaleHost) {
    const ipq = run("tailscale", ["ip", "-4", peer.tailscaleHost], { timeout: 10000 });
    if (ipq.ok && ipq.out) {
      const ip = ipq.out.split(/\r?\n/)[0].trim();
      if (ip) return { channel: "tailscale", host: ip, method: "ip-4", reason: null };
    }
  }

  return { channel: "tailscale", host: null, method: "none", reason: `không resolve được peer "${peer.tailscaleHost || "(chưa cấu hình NODESYNC_PEER_TAILSCALE_HOST)"}" qua tailnet` };
}

// Resolve peer qua CLOUDFLARE (cloudflared access ssh ProxyCommand).
export function resolveCloudflare(peer) {
  if (!peer.cloudflareHost) {
    return { channel: "cloudflare", host: null, reason: "chưa cấu hình NODESYNC_PEER_CLOUDFLARE_HOST" };
  }
  const has = run("sh", ["-lc", "command -v cloudflared"], { timeout: 8000 });
  if (!has.ok) {
    return { channel: "cloudflare", host: null, reason: "không tìm thấy binary cloudflared trong container" };
  }
  // Không resolve ra IP — dùng ProxyCommand. host = hostname cloudflare.
  return {
    channel: "cloudflare",
    host: peer.cloudflareHost,
    proxyCommand: `cloudflared access ssh --hostname ${peer.cloudflareHost}`,
    reason: null,
  };
}

// Resolve peer qua HYBRID / trực tiếp (IP/host cấu hình).
export function resolveHybrid(peer) {
  if (!peer.directHost) {
    return { channel: "hybrid", host: null, reason: "chưa cấu hình NODESYNC_PEER_HOST (host trực tiếp)" };
  }
  return { channel: "hybrid", host: peer.directHost, reason: null };
}

// Thử lần lượt các kênh đã enable → trả kênh đầu tiên resolve thành công.
// channels: mảng ["tailscale","cloudflare","hybrid"] (đã lọc enable + đúng thứ tự).
export function resolvePeer(channels, peer) {
  const attempts = [];
  for (const ch of channels) {
    let r;
    if (ch === "tailscale") r = resolveTailscale(peer);
    else if (ch === "cloudflare") r = resolveCloudflare(peer);
    else if (ch === "hybrid") r = resolveHybrid(peer);
    else { r = { channel: ch, host: null, reason: "kênh không hỗ trợ" }; }

    attempts.push(r);
    if (r.host) {
      log(`Resolve peer OK qua kênh "${ch}" → ${r.host}${r.method ? ` (method=${r.method})` : ""}`);
      return { resolved: r, attempts };
    }
    warn(`Kênh "${ch}" không dùng được → fallback. Lý do: ${r.reason}`);
  }
  error("Tất cả kênh đều thất bại — không resolve được peer.");
  return { resolved: null, attempts };
}

// Dựng options ssh (ProxyCommand cho cloudflare, StrictHostKeyChecking off cho
// tự động hoá, timeout). Trả mảng args dùng chung cho ssh/rsync -e.
export function sshBaseArgs(resolved, { user, port = 22, connectTimeout = 10, identityFile } = {}) {
  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", `ConnectTimeout=${connectTimeout}`,
    "-o", "LogLevel=ERROR",
    "-p", String(port),
  ];
  if (identityFile) args.push("-i", identityFile);
  if (resolved?.proxyCommand) args.push("-o", `ProxyCommand=${resolved.proxyCommand}`);
  return args;
}
