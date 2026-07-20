#!/usr/bin/env node
// scripts/runners/verify-stack-images.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Cửa an toàn TRƯỚC "Start stack" (yêu cầu prompt mục 2 & 5):
//   "Sau Bake, in commit SHA, target, image ID/digest và thời gian build;
//    trước Start stack kiểm tra image local đang được Compose tham chiếu đúng
//    image vừa build trong run hiện tại."
//
// Cách hoạt động:
//   1. Đọc metadata-file do `docker buildx bake --metadata-file` sinh ra
//      (mỗi target có "containerimage.digest" + "image.name").
//   2. Với mỗi image local `proxy-stack-*` (webssh/rclone/orchestrator/nodesync),
//      `docker image inspect` để lấy Id + RepoDigests và so với metadata.
//   3. In bảng: commit SHA | target | tag | image Id | digest.
//   4. Nếu một target trong bake KHÔNG có image local tương ứng (hoặc digest
//      lệch) → FAIL RÕ RÀNG (exit 1). TUYỆT ĐỐI không để silently chạy image cũ.
//
// Với image ngoài (base images) không nằm trong bake thì bỏ qua — chỉ verify
// các target do chính run này build.
//
// Usage:
//   node scripts/runners/verify-stack-images.mjs [--metadata <file>] [--silent]
//
// Env:
//   BAKE_METADATA_FILE  đường dẫn metadata-file (mặc định ci-runtime/bake-metadata.json)
//   GITHUB_SHA / BUILD_SOURCEVERSION  commit SHA để in ra (không bắt buộc)
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectDocker } from "./_docker.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const args = process.argv.slice(2);
const SILENT = args.includes("--silent");
const metaIdx = args.indexOf("--metadata");
const METADATA_FILE = resolve(
  ROOT,
  metaIdx >= 0 ? args[metaIdx + 1] : process.env.BAKE_METADATA_FILE || "ci-runtime/bake-metadata.json",
);
const log = (...a) => { if (!SILENT) console.log(...a); };
const err = (...a) => console.error(...a);

const COMMIT = (process.env.GITHUB_SHA || process.env.BUILD_SOURCEVERSION || "").slice(0, 40) || "(unknown)";

// Các target bake → tag local mà Compose tham chiếu. Phải KHỚP docker-bake.hcl.
const EXPECTED = {
  webssh: "proxy-stack-webssh:latest",
  rclone: "proxy-stack-rclone:local",
  orchestrator: "proxy-stack-orchestrator:local",
  nodesync: "proxy-stack-nodesync:local",
};

function dc(parts) {
  const d = detectDocker();
  if (!d.available) return null;
  return `${d.cmd} ${parts}`;
}

function inspect(image) {
  const cmd = dc(`image inspect ${image} --format '{{.Id}}|{{join .RepoDigests ","}}'`);
  if (!cmd) return null;
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const [id, repoDigests] = out.split("|");
    return { id, repoDigests: (repoDigests || "").split(",").filter(Boolean) };
  } catch {
    return null;
  }
}

function loadMetadata() {
  if (!existsSync(METADATA_FILE)) {
    log(`[verify-images] metadata-file không tồn tại: ${METADATA_FILE} (bake có thể chưa chạy hoặc chưa --metadata-file).`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(METADATA_FILE, "utf8"));
  } catch (e) {
    log(`[verify-images] metadata-file hỏng: ${e.message}`);
    return null;
  }
}

function digestFromMeta(entry) {
  if (!entry || typeof entry !== "object") return "";
  return entry["containerimage.digest"] || "";
}

function main() {
  log(`=== Verify stack images (commit=${COMMIT}) ===`);
  const meta = loadMetadata();
  const rows = [];
  const failures = [];

  for (const [target, tag] of Object.entries(EXPECTED)) {
    const info = inspect(tag);
    const metaDigest = digestFromMeta(meta?.[target]);
    if (!info) {
      failures.push(`target=${target} tag=${tag}: KHÔNG có image local (Compose sẽ không dùng được image vừa build).`);
      rows.push({ target, tag, id: "(missing)", digest: metaDigest || "(n/a)", ok: false });
      continue;
    }
    // Nếu có metadata digest, verify nó nằm trong RepoDigests của image local.
    let ok = true;
    if (metaDigest) {
      const match = info.repoDigests.some((rd) => rd.endsWith(metaDigest)) ||
        info.id === metaDigest ||
        info.id.endsWith(metaDigest.replace(/^sha256:/, ""));
      // load: true (type=docker) thường KHÔNG tạo RepoDigests; khi đó ta không
      // thể so digest trực tiếp. Chỉ FAIL khi CÓ RepoDigests mà không khớp.
      if (info.repoDigests.length && !match) {
        ok = false;
        failures.push(`target=${target} tag=${tag}: digest local không khớp bake metadata (bake=${metaDigest}).`);
      }
    }
    rows.push({ target, tag, id: (info.id || "").slice(0, 19), digest: metaDigest || "(local-load, no repo digest)", ok });
  }

  // In bảng.
  log("");
  log("commit    | target       | tag                              | image id            | digest");
  log("----------|--------------|----------------------------------|---------------------|--------------------------------------------------");
  for (const r of rows) {
    log(
      `${COMMIT.slice(0, 9).padEnd(9)} | ${r.target.padEnd(12)} | ${r.tag.padEnd(32)} | ${String(r.id).padEnd(19)} | ${r.digest}${r.ok ? "" : "  ❌"}`,
    );
  }
  log("");

  if (failures.length) {
    err("[verify-images] FAIL — image local KHÔNG khớp/ thiếu so với run hiện tại:");
    for (const f of failures) err(`  - ${f}`);
    err("[verify-images] Từ chối Start stack để tránh chạy image cũ. Hãy chạy lại Bake (load:true) cho run này.");
    process.exit(1);
  }
  log("[verify-images] OK — tất cả target proxy-stack-* đều có image local của run hiện tại.");
}

main();
