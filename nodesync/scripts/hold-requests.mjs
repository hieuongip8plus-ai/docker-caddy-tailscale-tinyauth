#!/usr/bin/env node
// nodesync/scripts/hold-requests.mjs
// Bật/tắt chế độ "treo request" trong lúc đang sync dữ liệu (YÊU CẦU).
//
// Mặc định (config.hold.mode = "retry-after"): tạo/xoá 1 FILE CỜ trong workspace.
// Caddy đọc file cờ này (qua snippet import) → khi tồn tại thì trả 503 +
// Retry-After để client/node02 retry sau. Khi sync xong → xoá cờ → phục vụ lại.
//
//   node scripts/hold-requests.mjs on     # bật treo (tạo cờ)
//   node scripts/hold-requests.mjs off    # tắt treo (xoá cờ)
//   node scripts/hold-requests.mjs status # xem trạng thái
//   node scripts/hold-requests.mjs on --dry-run
//   node scripts/hold-requests.mjs on --silent

import { writeFileSync, existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig, workspaceDir } from "./lib/env.mjs";
import { log, warn, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const action = args.find((a) => ["on", "off", "status"].includes(a)) || "status";

function flagPath() {
  const cfg = loadConfig();
  return resolve(workspaceDir(), cfg.hold.flag_file);
}

function main() {
  const cfg = loadConfig();
  const file = flagPath();
  const retryAfter = cfg.hold.retry_after_seconds;

  if (action === "status") {
    const on = existsSync(file);
    log(`Hold mode: ${on ? "BẬT (đang treo request)" : "TẮT (phục vụ bình thường)"} — file cờ: ${file}`);
    if (on) { try { log(`Nội dung cờ: ${readFileSync(file, "utf8").trim()}`); } catch {} }
    process.exit(on ? 10 : 0); // exit 10 = đang treo (tiện script khác kiểm tra)
  }

  if (action === "on") {
    log(`Bật treo request (mode=${cfg.hold.mode}, Retry-After=${retryAfter}s)`);
    if (DRY_RUN) { log(`[DRY RUN] tạo file cờ ${file}`); return; }
    mkdirSync(dirname(file), { recursive: true });
    const payload = JSON.stringify({ hold: true, since: new Date().toISOString(), retryAfter, mode: cfg.hold.mode });
    writeFileSync(file, payload + "\n");
    log(`Đã tạo cờ treo → Caddy sẽ trả 503 + Retry-After: ${retryAfter} cho request tới node này.`);
    return;
  }

  if (action === "off") {
    log("Tắt treo request (xoá file cờ)");
    if (DRY_RUN) { log(`[DRY RUN] xoá file cờ ${file}`); return; }
    if (existsSync(file)) { rmSync(file, { force: true }); log("Đã xoá cờ treo → node phục vụ request bình thường trở lại."); }
    else log("Không có cờ treo (đã ở trạng thái phục vụ bình thường).");
    return;
  }
}

try { main(); }
catch (e) { error(`hold-requests lỗi: ${e.message}`); process.exit(1); }
