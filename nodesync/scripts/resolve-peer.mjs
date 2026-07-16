#!/usr/bin/env node
// nodesync/scripts/resolve-peer.mjs
// CLI kiểm tra RESOLVE peer node01 qua các kênh (Tailscale → Cloudflare →
// Hybrid) — in kênh nào dùng được, kênh nào fallback và LÝ DO.
//
// Dùng để debug DNS resolve Tailscale (yêu cầu: resolve dns phù hợp tailscale).
//
//   node scripts/resolve-peer.mjs           # thử resolve theo kênh enable
//   node scripts/resolve-peer.mjs --json
//   node scripts/resolve-peer.mjs --dry-run # chỉ in cấu hình, không gọi tailscale/cloudflared
//   node scripts/resolve-peer.mjs --silent

import { loadConfig, enabledChannels, peerConfig } from "./lib/env.mjs";
import { resolvePeer } from "./lib/ssh.mjs";
import { log, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const AS_JSON = args.includes("--json");

function main() {
  const cfg = loadConfig();
  const channels = enabledChannels(cfg);
  const peer = peerConfig();

  log(`Kênh enable (thứ tự fallback): [${channels.join(" → ") || "(none)"}]`);
  log(`Peer cfg: tailscaleHost=${peer.tailscaleHost || "-"} cloudflareHost=${peer.cloudflareHost || "-"} directHost=${peer.directHost || "-"} port=${peer.port} user=${peer.user || "-"}`);

  if (DRY_RUN) {
    log("[DRY RUN] không gọi tailscale/cloudflared. Kết thúc.");
    process.exit(0);
  }

  const { resolved, attempts } = resolvePeer(channels, peer);

  if (AS_JSON) {
    console.log(JSON.stringify({ resolved, attempts }, null, 2));
    process.exit(resolved ? 0 : 2);
  }

  log("--- Chi tiết từng kênh ---");
  attempts.forEach((a) => {
    if (a.host) log(`  ✔ ${a.channel}: ${a.host}${a.method ? ` (method=${a.method})` : ""}`);
    else log(`  ✘ ${a.channel}: ${a.reason}`);
  });

  if (resolved) {
    log(`KẾT QUẢ: dùng kênh "${resolved.channel}" → ${resolved.host}`);
    process.exit(0);
  }
  error("KẾT QUẢ: không kênh nào resolve được peer (xem lý do ở trên để debug).");
  process.exit(2);
}

try { main(); }
catch (e) { error(`resolve-peer lỗi: ${e.message}`); process.exit(1); }
