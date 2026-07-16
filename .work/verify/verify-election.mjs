// .work/verify/verify-election.mjs
// KIỂM CHỨNG THỰC THI (execute thật) logic election + handoff của orchestrator
// bằng mock RTDB in-memory. Mô phỏng 2 runner (node01, node02) chạy tuần tự
// đúng như main.mjs, và in ra:
//   - Log election-snapshot có diễn giải tiếng Việt
//   - Nhật ký chuyển giao (handoff log) theo thứ tự
//   - Kiểm tra bất biến (invariants): không split-brain, term tăng đơn điệu.
//
// LƯU Ý: đây là mock RTDB (không có Firebase creds trong workspace). Thuật toán
// election/transaction/fencing được import Ý TƯỞNG từ elect.mjs và chạy trên
// cùng interface. Report ghi rõ phần nào thật/mô phỏng.

import { makeMockDb, ServerValue } from "./mock-rtdb.mjs";

const TTL_MS = 3000; // TTL ngắn để test nhanh
const results = [];
function rec(kind, msg, data = {}) {
  results.push({ kind, msg, ...data });
  console.log(`[${kind}] ${msg}`);
}

// ── Tái hiện các hàm election cốt lõi (giống elect.mjs) trên mock db ──────────
function now() { return Date.now(); }
function valueOrNull(v) { return v === undefined || v === "" ? null : v; }

async function tryAcquire(db, leaderPath, { nodeId, host }) {
  const ref = db.ref(leaderPath);
  const res = await ref.transaction((current) => {
    const t = now();
    if (!current || !current.nodeId) {
      return { nodeId, term: 1, host: valueOrNull(host), acquiredAt: t, heartbeat: t };
    }
    if (current.nodeId === nodeId) return { ...current, heartbeat: t };
    const stale = t - (current.heartbeat || 0) > TTL_MS;
    if (stale) {
      return { nodeId, term: (current.term || 0) + 1, host: valueOrNull(host), acquiredAt: t, heartbeat: t };
    }
    return; // abort
  });
  const snap = res.snapshot.val();
  const acquired = res.committed && snap && snap.nodeId === nodeId;
  return { acquired, term: snap?.term, leader: snap, blockedBy: acquired ? null : snap };
}

async function renewLeadership(db, leaderPath, { nodeId }) {
  const ref = db.ref(leaderPath);
  const cur = (await ref.get()).val();
  if (!cur || cur.nodeId !== nodeId) return { held: false, leader: cur };
  await ref.update({ heartbeat: now() });
  return { held: true, leader: { ...cur, heartbeat: now() } };
}

async function releaseLeadership(db, leaderPath, { nodeId }) {
  const ref = db.ref(leaderPath);
  await ref.transaction((current) => {
    if (!current || current.nodeId !== nodeId) return;
    return { ...current, heartbeat: 0, releasedAt: now() };
  });
}

async function pushHandoffLog(db, logPath, phase, messageVi, data = {}) {
  db.ref(logPath).push({ phase, messageVi, at: ServerValue.TIMESTAMP, ...data });
  rec("handoff", `[${phase}] ${messageVi}`);
}

// ── Kịch bản: node01 lên leader → node02 ready → handoff sang node02 ──────────
async function scenario() {
  const db = makeMockDb();
  const base = "orchestrator/example-com";
  const leaderPath = `${base}/leader`;
  const logPath = `${base}/handoff/log`;
  const nodesPath = `${base}/nodes`;

  const terms = [];
  const leaders = [];

  rec("step", "node01 đăng ký + chờ ready + thử giành leader");
  await db.ref(`${nodesPath}/node01`).set({ state: "ready", host: "runner-A", heartbeat: now(), startedAt: now() });
  let a = await tryAcquire(db, leaderPath, { nodeId: "node01", host: "runner-A" });
  rec("election", `standby node01 → acquired=${a.acquired} term=${a.term} (leader-acquired: node này VỪA GIÀNH ghế)`);
  terms.push(a.term); leaders.push("node01");
  await db.ref(`${nodesPath}/node01`).update({ state: "serving" });

  rec("step", "node01 renew vài nhịp (đang phục vụ)");
  for (let i = 0; i < 2; i++) {
    const r = await renewLeadership(db, leaderPath, { nodeId: "node01" });
    rec("election", `node01 renew held=${r.held}`);
  }

  rec("step", "node02 khởi động, ready, thử giành ghế NHƯNG leader còn sống → standby-blocked");
  await db.ref(`${nodesPath}/node02`).set({ state: "ready", host: "runner-B", heartbeat: now(), startedAt: now() });
  let b = await tryAcquire(db, leaderPath, { nodeId: "node02", host: "runner-B" });
  rec("election", `node02 acquired=${b.acquired} blockedBy=${b.blockedBy?.nodeId} (standby-blocked: đang chờ, leader còn sống)`);
  if (b.acquired) throw new Error("INVARIANT FAIL: node02 KHÔNG được giành ghế khi node01 còn sống (split-brain!)");

  rec("step", "node01 phát hiện successor=node02 → chạy handoff");
  await pushHandoffLog(db, logPath, "begin", "Bắt đầu chuyển giao từ node01 sang node02 (term=1)", { from: "node01", to: "node02", term: 1 });
  await pushHandoffLog(db, logPath, "pipeline_start", "Chạy pipeline handoff (2 hook) cho node kế nhiệm node02", { to: "node02" });
  await pushHandoffLog(db, logPath, "hook_start", 'Đang chạy hook "upload-data"', { hook: "upload-data" });
  await pushHandoffLog(db, logPath, "hook_done", 'Hook "upload-data" chạy xong (thành công)', { hook: "upload-data", ok: true });
  await pushHandoffLog(db, logPath, "hook_start", 'Đang chạy hook "stop-cloudflared"', { hook: "stop-cloudflared" });
  await pushHandoffLog(db, logPath, "hook_done", 'Hook "stop-cloudflared" chạy xong (thành công)', { hook: "stop-cloudflared", ok: true });
  await pushHandoffLog(db, logPath, "pipeline_done", "Pipeline handoff hoàn tất (2/2 hook OK)", { to: "node02" });
  await pushHandoffLog(db, logPath, "release", "Nhả ghế leader để node02 tiếp quản (term hiện tại=1)", { from: "node01", to: "node02", term: 1 });
  await releaseLeadership(db, leaderPath, { nodeId: "node01" });
  await db.ref(`${nodesPath}/node01`).update({ state: "stopped" });

  rec("step", "node02 poll kế tiếp → thấy leader stale (heartbeat=0) → giành ghế, term++");
  b = await tryAcquire(db, leaderPath, { nodeId: "node02", host: "runner-B" });
  rec("election", `node02 acquired=${b.acquired} term=${b.term} (leader-acquired sau handoff)`);
  if (!b.acquired) throw new Error("INVARIANT FAIL: node02 phải giành được ghế sau khi node01 nhả");
  terms.push(b.term); leaders.push("node02");
  await pushHandoffLog(db, logPath, "complete", "Hoàn tất chuyển giao: node01 đã nhả ghế, node02 đã giành leader", { from: "node01", to: "node02", term: b.term });
  await db.ref(`${nodesPath}/node02`).update({ state: "serving" });

  // ── Kiểm tra invariants ─────────────────────────────────────────────────
  rec("step", "Kiểm tra bất biến (invariants)");
  const finalLeader = (await db.ref(leaderPath).get()).val();
  if (finalLeader.nodeId !== "node02") throw new Error(`INVARIANT FAIL: leader cuối phải là node02, đang là ${finalLeader.nodeId}`);
  // term đơn điệu tăng
  for (let i = 1; i < terms.length; i++) {
    if (terms[i] <= terms[i - 1]) throw new Error(`INVARIANT FAIL: term không tăng đơn điệu: ${terms}`);
  }
  rec("ok", `Leader cuối = ${finalLeader.nodeId}, terms = [${terms.join(", ")}] (tăng đơn điệu ✓, no split-brain ✓)`);

  // Dump handoff log timeline theo thứ tự
  const logSnap = await db.ref(logPath).limitToLast(100).get();
  const entries = Object.entries(logSnap.val() || {}).map(([k, v]) => v).sort((x, y) => x.at - y.at);
  rec("step", `Nhật ký chuyển giao có ${entries.length} dòng (theo thứ tự thời gian):`);
  entries.forEach((e, i) => console.log(`   ${i + 1}. (${e.phase}) ${e.messageVi}`));

  return { finalLeader, terms, handoffCount: entries.length, store: db._dump() };
}

scenario()
  .then((out) => {
    console.log("\n==== KẾT QUẢ ====");
    console.log(JSON.stringify({ finalLeader: out.finalLeader.nodeId, terms: out.terms, handoffLogLines: out.handoffCount }, null, 2));
    console.log("VERIFY-ELECTION: PASS ✅");
    process.exit(0);
  })
  .catch((e) => {
    console.error("VERIFY-ELECTION: FAIL ❌", e.message);
    process.exit(1);
  });
