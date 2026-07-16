// nodesync/scripts/lib/log.mjs
// Logger cho nodesync: prefix + redact secret + hỗ trợ --silent.
// Format: [nodesync <iso>] ...  (đồng bộ phong cách với orchestrator).

const SILENT = process.argv.includes("--silent");

// Che secret hay lộ: SSH password, private key, token, base64 key.
// Lưu ý: KHÔNG che chuỗi "NOPASSWD" trong sudoers (không phải secret).
export function redact(value) {
  return String(value ?? "")
    .replace(/(SSH_\d+_PASS(WORD)?|SSH_\d+_PRIVATE_KEY|SSH_PASSWORD|SSH_PRIVATE_KEY)=([^\s;&]+)/gi, "$1=<hidden>")
    .replace(/(-----BEGIN [^-]+-----)[\s\S]*?(-----END [^-]+-----)/g, "$1<hidden>$2")
    .replace(/(?<!NO)(password|passwd|secret|token|apikey|api_key|private_key)"?\s*[:=]\s*"?[^"\s,}]+/gi, "$1=<hidden>");
}

function ts() { return new Date().toISOString(); }

export function log(...args) {
  if (SILENT) return;
  console.log(`[nodesync ${ts()}]`, ...args.map((a) => redact(typeof a === "string" ? a : JSON.stringify(a))));
}
export function warn(...args) {
  if (SILENT) return;
  console.warn(`[nodesync ${ts()}] WARN`, ...args.map((a) => redact(typeof a === "string" ? a : JSON.stringify(a))));
}
export function error(...args) {
  console.error(`[nodesync ${ts()}] ERROR`, ...args.map((a) => redact(typeof a === "string" ? a : JSON.stringify(a))));
}

// Log "bước có mốc thời gian" — dùng đo thời lượng sync (yêu cầu: log bao lâu).
export function stepTimer(labelVi) {
  const start = Date.now();
  log(`▶ ${labelVi} — bắt đầu`);
  return {
    end(extraVi = "") {
      const ms = Date.now() - start;
      log(`✔ ${labelVi} — xong sau ${ms}ms ${extraVi}`.trim());
      return ms;
    },
    fail(errVi) {
      const ms = Date.now() - start;
      error(`✘ ${labelVi} — LỖI sau ${ms}ms: ${errVi}`);
      return ms;
    },
  };
}
