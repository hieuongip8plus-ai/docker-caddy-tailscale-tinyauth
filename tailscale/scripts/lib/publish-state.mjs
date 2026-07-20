// tailscale/scripts/lib/publish-state.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Idempotency cache cho tailscale publish (prompt mục 4 — Tailscale publish):
//   "Cache trạng thái tại ci-runtime/tailscale/published.json gồm services,
//    serve style, tailnet, hostname và config hash. Nếu hash khớp và
//    tailscale status/serve state xác nhận cấu hình còn tồn tại, skip API
//    PUT/POST và CLI advertise, chỉ log already published."
//
// Thuần logic (hash/format/parse) — không side-effect ngoài đọc/ghi 1 file JSON.
// Dễ unit-test: computePublishHash + shouldSkipPublish nhận input thuần.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Hash ổn định cho cấu hình publish. Đổi bất kỳ field nào (mode/style/tailnet/
 * hostname/services/autoApprove) → hash đổi → publish lại.
 */
export function computePublishHash({ cfg, services }) {
  const canonical = {
    mode: cfg.mode,
    serveStyle: cfg.serveStyle,
    autoApprove: cfg.autoApprove,
    tailnet: cfg.tailnet,
    nodeHost: cfg.nodeHost,
    services: (services || [])
      .map((s) => ({ name: s.name, upstream: s.upstream, names: [...(s.names || [])].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Đọc state cũ. Trả null nếu thiếu/hỏng. */
export function readPublishState(file) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Ghi state mới (best-effort, không throw). */
export function writePublishState(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * Quyết định có SKIP publish không.
 *   - prevState.hash phải khớp hash hiện tại, VÀ
 *   - serveConfirmed: serve state trên node còn tồn tại (TCP 443 + Web{} khớp
 *     kỳ vọng, hoặc doServe=false thì bỏ qua điều kiện này).
 * Trả { skip: boolean, reason }.
 */
export function shouldSkipPublish({ hash, prevState, serveConfirmed, cfg }) {
  if (!prevState) return { skip: false, reason: "no-previous-state" };
  if (prevState.hash !== hash) return { skip: false, reason: "config-hash-changed" };
  // Nếu cần serve (doServe) mà state trên node không xác nhận → publish lại.
  if (cfg.doServe && !serveConfirmed) return { skip: false, reason: "serve-state-missing-on-node" };
  return { skip: true, reason: "hash-match-and-state-present" };
}

/**
 * Kiểm tra serve state hiện tại có "web hosts" hay không, từ output
 * `tailscale serve status --json`. Best-effort — trả false nếu không parse được.
 * Chỉ dùng để xác nhận cấu hình serve CÒN TỒN TẠI (không so chi tiết từng host,
 * vì hash đã bao trùm nội dung; ở đây chỉ cần biết serve chưa bị clear).
 */
export function serveStatePresent(serveStatusJson) {
  try {
    const st = typeof serveStatusJson === "string" ? JSON.parse(serveStatusJson) : serveStatusJson;
    if (!st || typeof st !== "object") return false;
    const hasTCP = st.TCP && Object.keys(st.TCP).length > 0;
    const hasWeb = st.Web && Object.keys(st.Web).length > 0;
    return Boolean(hasTCP || hasWeb);
  } catch {
    return false;
  }
}
