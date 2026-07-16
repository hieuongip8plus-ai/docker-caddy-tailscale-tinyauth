#!/usr/bin/env node
// .work/verify/verify-nodesync.mjs
// KIỂM CHỨNG THỰC THI (execute thật) luồng đồng bộ nodesync KHÔNG cần Docker:
//   - Tạo "node01" (nguồn) với >10 mẫu dữ liệu đa dạng (text, binary, nested,
//     rỗng, lớn, nhiều thư mục...).
//   - Tạo "node02" (đích) trạng thái LỆCH (thiếu file / khác nội dung / thừa).
//   - Chạy rsync THẬT (local) mô phỏng "sync node01 → node02".
//   - Chạy verify-integrity.mjs --local THẬT để đối chiếu checksum/size/time.
//   - Kiểm tra logic hold flag (hold-requests.mjs on/off) THẬT.
//   - Kiểm tra fingerprint find|sha256 (như sync.mjs) THẬT.
//
// LƯU Ý: đây KHÔNG dùng ssh/tailscale (sandbox không có sshd/tailnet). Phần
// rsync/checksum/size/quyền/cwd/hold-flag chạy THẬT 100%. Phần resolve
// tailscale/cloudflare được kiểm ở test riêng (mock output) + report ghi rõ.

import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(process.cwd(), "sandbox-nodes");
const N1 = resolve(ROOT, "node01/ci-data");
const N2 = resolve(ROOT, "node02/ci-data");
const NS = resolve(process.cwd(), "..", "..", "nodesync"); // nodesync dir

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...opts });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}

function reset() {
  if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(N1, { recursive: true });
  mkdirSync(N2, { recursive: true });
}

// >10 mẫu dữ liệu đa dạng trên node01.
function seedNode01() {
  const files = [
    ["app.db", "SQLITE_FORMAT_3\0" + "x".repeat(2048)],          // 1 binary-ish
    ["config/settings.json", JSON.stringify({ a: 1, b: "hai", nested: { c: [1, 2, 3] } }, null, 2)], // 2 nested json
    ["config/feature.flags", "flagA=true\nflagB=false\n"],       // 3
    ["logs/app.log", "line\n".repeat(500)],                       // 4 lớn hơn
    ["logs/empty.log", ""],                                        // 5 rỗng
    ["users/1.txt", "user one"],                                   // 6
    ["users/2.txt", "user two"],                                   // 7
    ["users/3.txt", "user three"],                                 // 8
    ["cache/big.bin", "B".repeat(100000)],                         // 9 ~100KB
    ["cache/small.bin", "S".repeat(10)],                           // 10
    ["notes.md", "# Ghi chú\nĐồng bộ dữ liệu giữa các node.\n"],   // 11 utf8
    ["deep/a/b/c/leaf.txt", "leaf-content"],                       // 12 sâu
    ["special name (spaces).txt", "tên file có dấu cách"],         // 13 tên đặc biệt
    [".hidden", "hidden file"],                                     // 14 file ẩn
  ];
  for (const [rel, content] of files) {
    const abs = resolve(N1, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  // 1 file có quyền đặc biệt (kiểm tra rsync -a giữ quyền).
  chmodSync(resolve(N1, "config/settings.json"), 0o640);
  return files.length;
}

// node02 lệch: thiếu vài file, khác nội dung 1 file, thừa 1 file.
function seedNode02Divergent() {
  // copy 1 phần từ node01 nhưng cố ý lệch
  mkdirSync(resolve(N2, "users"), { recursive: true });
  writeFileSync(resolve(N2, "users/1.txt"), "user one");           // giống
  writeFileSync(resolve(N2, "users/2.txt"), "USER TWO CHANGED");   // KHÁC nội dung
  // thiếu users/3.txt, thiếu app.db, cache/*, logs/*, config/*, notes.md, deep/*
  writeFileSync(resolve(N2, "obsolete.tmp"), "file thừa sẽ bị --delete xoá"); // THỪA
}

function countFiles(dir) {
  const r = sh("bash", ["-lc", `find ${JSON.stringify(dir)} -type f | wc -l`]);
  return r.ok ? Number(r.out) : -1;
}

function fingerprint(dir) {
  const r = sh("bash", ["-lc", `cd ${JSON.stringify(dir)} && find . -type f -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -d' ' -f1`]);
  return r.ok ? r.out : "ERR";
}

function main() {
  console.log("=== VERIFY-NODESYNC: thiết lập 2 node cục bộ ===");
  reset();
  const n = seedNode01();
  seedNode02Divergent();
  console.log(`node01 seed ${n} mẫu dữ liệu đa dạng. Files: node01=${countFiles(N1)} node02(lệch)=${countFiles(N2)}`);

  // Fingerprint TRƯỚC sync (như sync.mjs bước diff).
  const fpBefore1 = fingerprint(N1);
  const fpBefore2 = fingerprint(N2);
  console.log(`Fingerprint TRƯỚC: node01=${fpBefore1.slice(0, 16)} node02=${fpBefore2.slice(0, 16)} → ${fpBefore1 === fpBefore2 ? "GIỐNG" : "KHÁC (cần sync)"}`);
  if (fpBefore1 === fpBefore2) { console.error("FAIL: kỳ vọng KHÁC trước sync"); process.exit(1); }

  // ── Test hold flag THẬT (hold-requests.mjs on/off) ──
  console.log("\n=== Test hold flag (503 Retry-After) ===");
  const holdEnv = { ...process.env, SSH_WORKSPACE: resolve(ROOT, "node01"), SSH_ENABLE: "1" };
  let r = sh("node", [resolve(NS, "scripts/hold-requests.mjs"), "on"], { env: holdEnv });
  console.log(r.out || r.err);
  const flagFile = resolve(ROOT, "node01/ci-runtime/nodesync/hold.flag");
  console.log(`Cờ hold tồn tại sau ON: ${existsSync(flagFile) ? "CÓ ✅" : "KHÔNG ❌"}`);
  if (!existsSync(flagFile)) { console.error("FAIL: hold on không tạo cờ"); process.exit(1); }
  r = sh("node", [resolve(NS, "scripts/hold-requests.mjs"), "off"], { env: holdEnv });
  console.log(r.out || r.err);
  console.log(`Cờ hold tồn tại sau OFF: ${existsSync(flagFile) ? "CÓ ❌" : "KHÔNG ✅"}`);
  if (existsSync(flagFile)) { console.error("FAIL: hold off không xoá cờ"); process.exit(1); }

  // ── rsync THẬT node01 → node02 (mô phỏng sync.mjs rsyncPull) ──
  console.log("\n=== rsync THẬT node01 → node02 (-az --delete --checksum --stats) ===");
  const t0 = Date.now();
  r = sh("rsync", ["-az", "--delete", "--checksum", "--stats", "--human-readable", `${N1}/`, `${N2}/`]);
  const dt = Date.now() - t0;
  if (!r.ok) { console.error("FAIL rsync:", r.err); process.exit(1); }
  console.log(r.out.split("\n").filter((l) => /Number of|transferred|Total|size/i.test(l)).join("\n"));
  console.log(`rsync xong sau ${dt}ms`);

  // Fingerprint SAU sync.
  const fpAfter1 = fingerprint(N1);
  const fpAfter2 = fingerprint(N2);
  console.log(`Fingerprint SAU: node01=${fpAfter1.slice(0, 16)} node02=${fpAfter2.slice(0, 16)} → ${fpAfter1 === fpAfter2 ? "GIỐNG ✅" : "KHÁC ❌"}`);

  // ── verify-integrity.mjs --local THẬT ──
  console.log("\n=== verify-integrity.mjs --local (đối chiếu per-file checksum/size/time) ===");
  r = sh("node", [resolve(NS, "scripts/verify-integrity.mjs"), "--local", N1, N2, "--json"], { env: process.env });
  // In phần JSON kết quả cuối.
  const jsonLine = r.out.split("\n").filter(Boolean);
  let parsed = null;
  try { parsed = JSON.parse(jsonLine.slice(jsonLine.findIndex((l) => l.startsWith("{"))).join("\n")); } catch {}
  console.log(r.out);

  const integrityOk = parsed?.integrityOk === true && fpAfter1 === fpAfter2;
  console.log("\n==== KẾT QUẢ VERIFY-NODESYNC ====");
  console.log(JSON.stringify({
    seededSamples: n,
    fingerprintBeforeDiffered: fpBefore1 !== fpBefore2,
    rsyncMs: dt,
    fingerprintAfterMatch: fpAfter1 === fpAfter2,
    integrity: parsed?.counts,
    integrityOk,
  }, null, 2));
  console.log(integrityOk ? "VERIFY-NODESYNC: PASS ✅" : "VERIFY-NODESYNC: FAIL ❌");
  process.exit(integrityOk ? 0 : 1);
}

main();
