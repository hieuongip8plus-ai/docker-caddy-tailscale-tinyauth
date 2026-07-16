// orchestrator/scripts/print-leader.mjs
// In thông tin leader hiện tại từ RTDB dưới dạng JSON 1 dòng — dùng cho CI đối
// chiếu (scripts/runners/verify-leader-whoami.mjs).
//
//   node scripts/print-leader.mjs           # in { nodeId, term, host, publicUrl, heartbeatAgeMs }
//   node scripts/print-leader.mjs --silent  # chỉ in JSON (không log kết nối)
//   node scripts/print-leader.mjs --dry-run # không kết nối

import { getLeader } from "./elect.mjs";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");

async function main() {
  if (DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true }));
    process.exit(0);
  }
  const leader = await getLeader();
  if (!leader || !leader.nodeId) {
    console.log(JSON.stringify({ nodeId: null }));
    process.exit(0);
  }
  console.log(JSON.stringify({
    nodeId: leader.nodeId,
    term: leader.term ?? null,
    host: leader.host ?? null,
    publicUrl: leader.publicUrl ?? null,
    heartbeatAgeMs: Date.now() - (leader.heartbeat || 0),
  }));
  process.exit(0);
}

main().catch((e) => {
  // In JSON lỗi để caller phân biệt "không có leader" vs "lỗi kết nối".
  console.log(JSON.stringify({ nodeId: null, error: e.message }));
  process.exit(0);
});
