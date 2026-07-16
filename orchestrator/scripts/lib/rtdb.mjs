// orchestrator/scripts/lib/rtdb.mjs
// Kết nối Firebase Realtime Database bằng Service Account JSON (base64).
//
// Env:
//   ORCH_RTDB_SERVICE_ACCOUNT  base64 của service account JSON (khuyến nghị)
//   ORCH_RTDB_SERVICE_ACCOUNT_FILE  đường dẫn tới file JSON (thay thế)
//   ORCH_RTDB_URL              databaseURL, vd https://<project>.firebaseio.com
//   ORCH_STACK                 tên stack (namespace), default "default"
//
// Trả về { db, rootRef, paths } — mọi path đều nằm dưới /orchestrator/<stack>.

import { readFileSync } from "node:fs";
import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { log, error } from "./log.mjs";

function loadServiceAccount() {
  const b64 = process.env.ORCH_RTDB_SERVICE_ACCOUNT;
  const file = process.env.ORCH_RTDB_SERVICE_ACCOUNT_FILE;
  let raw;
  if (b64 && b64.trim()) {
    raw = Buffer.from(b64.trim(), "base64").toString("utf8");
  } else if (file && file.trim()) {
    raw = readFileSync(file.trim(), "utf8");
  } else {
    throw new Error(
      "Missing credentials: set ORCH_RTDB_SERVICE_ACCOUNT (base64) or ORCH_RTDB_SERVICE_ACCOUNT_FILE",
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Service account JSON parse failed: ${e.message}`);
  }
}

let _cached = null;

export function connectRtdb() {
  if (_cached) return _cached;

  const databaseURL =
    process.env.ORCH_RTDB_URL ||
    process.env.FIREBASE_DATABASE_URL ||
    "";
  if (!databaseURL) {
    throw new Error("Missing ORCH_RTDB_URL (Realtime Database URL).");
  }

  const serviceAccount = loadServiceAccount();
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL,
  });

  const db = getDatabase();
  const stack = (process.env.ORCH_STACK || process.env.DOMAIN || "default").replace(/[.#$/[\]]/g, "-");
  const base = `orchestrator/${stack}`;

  const paths = {
    base,
    leader: `${base}/leader`,
    lock: `${base}/lock`, // dùng transaction để election
    nodes: `${base}/nodes`,
    node: (id) => `${base}/nodes/${id}`,
    handoff: `${base}/handoff`,
    handoffLog: `${base}/handoff/log`, // nhật ký chuyển giao (timeline append)
    events: `${base}/events`,
  };

  log(`RTDB connected: project=${serviceAccount.project_id} stack=${stack}`);
  _cached = { db, rootRef: db.ref(base), paths, stack };
  return _cached;
}

// serverTimestamp helper (ghi giờ theo server RTDB, tránh lệch giờ runner)
export { ServerValue } from "firebase-admin/database";

// Ghi 1 event vào audit log /events (push, kèm timestamp).
export async function pushEvent(type, data = {}) {
  try {
    const { db, paths } = connectRtdb();
    const { ServerValue } = await import("firebase-admin/database");
    await db.ref(paths.events).push({
      type,
      at: ServerValue.TIMESTAMP,
      nodeId: process.env.ORCH_NODE_ID || null,
      ...data,
    });
  } catch (e) {
    error(`pushEvent(${type}) failed: ${e.message}`);
  }
}

// Ghi 1 dòng NHẬT KÝ CHUYỂN GIAO vào /handoff/log (timeline, append theo push).
// Phục vụ yêu cầu Phần 1 #2: "ghi nhận nhật ký chuyển giao giữa 2 runner vào
// rtdb để xem log thực thi có đúng không".
//
//   phase   : mã pha (vd "begin", "pipeline_start", "hook", "release", "complete")
//   messageVi : diễn giải tiếng Việt ngắn gọn bước này
//   data    : context thêm (from, to, term, hook, ok...)
export async function pushHandoffLog(phase, messageVi, data = {}) {
  try {
    const { db, paths } = connectRtdb();
    const { ServerValue } = await import("firebase-admin/database");
    const entry = {
      phase,
      messageVi,
      at: ServerValue.TIMESTAMP,
      nodeId: process.env.ORCH_NODE_ID || null,
      ...data,
    };
    await db.ref(paths.handoffLog).push(entry);
    log(`Handoff log ← [${phase}] ${messageVi}`);
  } catch (e) {
    error(`pushHandoffLog(${phase}) failed: ${e.message}`);
  }
}
