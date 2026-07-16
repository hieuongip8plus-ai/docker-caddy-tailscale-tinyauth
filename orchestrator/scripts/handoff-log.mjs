// orchestrator/scripts/handoff-log.mjs
// Đọc NHẬT KÝ CHUYỂN GIAO (handoff timeline) từ RTDB để kiểm chứng luồng
// chuyển giao giữa các runner có đúng thứ tự không (yêu cầu Phần 1 #2).
//
//   node scripts/handoff-log.mjs            # in toàn bộ timeline (mới→cũ giới hạn)
//   node scripts/handoff-log.mjs --limit 50 # số dòng tối đa
//   node scripts/handoff-log.mjs --json     # xuất JSON thô
//   node scripts/handoff-log.mjs --dry-run  # chỉ in path sẽ đọc, không kết nối
//   node scripts/handoff-log.mjs --silent   # không in (dùng khi test)

import { connectRtdb } from "./lib/rtdb.mjs";
import { log, error } from "./lib/log.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SILENT = args.includes("--silent");
const AS_JSON = args.includes("--json");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 100 : 100;

const out = (...a) => { if (!SILENT) console.log(...a); };

async function main() {
  if (DRY_RUN) {
    out(`[DRY RUN] Sẽ đọc handoff log tại: orchestrator/<stack>/handoff/log (limit=${LIMIT}). Cần ORCH_RTDB_URL + creds khi chạy thật.`);
    process.exit(0);
  }

  const { db, paths, stack } = connectRtdb();

  const snap = await db.ref(paths.handoffLog).limitToLast(LIMIT).get();
  const val = snap.val() || {};
  // RTDB push keys sắp theo thời gian tăng dần → chuyển sang mảng theo thứ tự.
  const entries = Object.entries(val)
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => (a.at || 0) - (b.at || 0));

  if (AS_JSON) {
    out(JSON.stringify(entries, null, 2));
    process.exit(0);
  }

  out(`\n=== Nhật ký chuyển giao (handoff log) — stack="${stack}" — ${entries.length} dòng ===`);
  if (entries.length === 0) {
    out("(chưa có nhật ký chuyển giao nào — có thể chưa xảy ra handoff)");
  }
  for (const e of entries) {
    const t = e.at ? new Date(e.at).toISOString() : "(no-time)";
    const from = e.from ? ` from=${e.from}` : "";
    const to = e.to ? ` to=${e.to}` : "";
    const hook = e.hook ? ` hook=${e.hook}` : "";
    const term = e.term !== undefined ? ` term=${e.term}` : "";
    out(`  [${t}] (${e.phase})${from}${to}${hook}${term}\n      → ${e.messageVi || ""}`);
  }
  out("");
  process.exit(0);
}

main().catch((e) => {
  error(`handoff-log failed: ${e.message}`);
  process.exit(1);
});
