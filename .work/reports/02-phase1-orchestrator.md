# Phase 02 — Implement Phần 1 (orchestrator) + Kiểm chứng

> Vai trò: Coder → Test/Verify. Ghi lại thay đổi + kết quả execute thật.

## Thay đổi (Phần 1)

### 1. Log election-snapshot kèm tiếng Việt (YC #1)
- `orchestrator/scripts/main.mjs`: thêm dict `SNAPSHOT_VI` + `describeSnapshotVi(label)`.
  `logElectionSnapshot` giờ in: `Election snapshot: <label> (<diễn giải VN>)`.
- Bao phủ tất cả label: stack-ready, leader-acquired, standby-blocked, standby-no-leader,
  leader-lost, handoff-begin, handoff-before-release, handoff-complete, signal-*.

### 2. Nhật ký chuyển giao vào RTDB (YC #2)
- `lib/rtdb.mjs`: thêm path `handoffLog = <base>/handoff/log` + hàm `pushHandoffLog(phase, messageVi, data)`.
- `main.mjs`: ghi handoff log tại begin / release / complete / pipeline_error.
- `hooks/index.mjs`: ghi handoff log tại pipeline_start / hook_start / hook_done / hook_fail / pipeline_done / pipeline_aborted.
- `scripts/handoff-log.mjs` (MỚI): đọc lại timeline từ RTDB (`--json`, `--limit`, `--dry-run`, `--silent`).

### 3. Đối chiếu leader qua whoami trong CI (YC #3)
- `whoami/whoami.yml`: set `WHOAMI_NAME: ${WHOAMI_NAME:-${ORCH_NODE_ID:-whoami}}` → whoami echo `Name: <node-id>`.
  (xác nhận từ docs chính thức traefik/whoami: env `WHOAMI_NAME` → dòng `Name:` trong body).
- `orchestrator/scripts/print-leader.mjs` (MỚI): in JSON leader hiện tại.
- `scripts/runners/verify-leader-whoami.mjs` (MỚI): curl whoami mỗi 5s, so `Name:` == leader.nodeId (RTDB),
  trùng thì dừng; có in SO SÁNH ĐỐI CHIẾU. Không fail cứng trừ `VERIFY_LEADER_STRICT=1`.
- `.github/workflows/test.yml`: thêm step "Verify leader matches whoami" (timeout 120s, interval 5s).

### 4. Node info + Tailscale (YC #4)
- `lib/tailscale-info.mjs` (MỚI): `getTailscaleInfo()` đọc `tailscale status --json` qua compose exec
  → ip, ips, hostname, dnsName, os, version, tailnet, online, tags. Best-effort + `reason` khi thiếu.
- `lib/ssh-identity.mjs` (MỚI): `getSshRuntimeIdentity()` → systemUser, uid, isRoot, cwd, repoDir,
  channels (tailscale→cloudflare→hybrid), sshUsers (SSH_<n>_USER, chỉ username + cờ có key/pass).
- `lib/node-identity.mjs`: `getNodeIdentity()` thêm `runtime`; `getNodeIdentityWithTailscale()` thêm `tailscale`.
- `register.mjs`: dùng bản kèm tailscale; thêm `refreshTailscale()` (gọi lại sau khi ready).

## Kiểm chứng thực thi (execute thật)

### ✅ node --check (bắt buộc theo convention) — TẤT CẢ PASS
main.mjs, register.mjs, elect.mjs, handoff-log.mjs, print-leader.mjs,
lib/rtdb.mjs, lib/node-identity.mjs, lib/tailscale-info.mjs, lib/ssh-identity.mjs,
hooks/index.mjs, scripts/runners/verify-leader-whoami.mjs.

### ✅ docker compose config (YAML hợp lệ)
`COMPOSE_PROFILES=core docker compose config` → **CONFIG OK**.
`WHOAMI_NAME` render đúng (`whoami` khi ORCH_NODE_ID trống — fallback lồng nhau hoạt động).

### ✅ Mô phỏng election + handoff (mock RTDB, execute thật) — PASS
`.work/verify/verify-election.mjs` chạy 2 runner:
- node01 → leader term=1.
- node02 ready khi node01 còn sống → **acquired=false (standby-blocked)** — KHÔNG split-brain.
- node01 chạy pipeline handoff (upload-data, stop-cloudflared) → nhả ghế.
- node02 → leader term=2 (**term tăng đơn điệu 1→2**).
- Nhật ký chuyển giao: **9 dòng đúng thứ tự** (begin → pipeline_start → 4×hook → pipeline_done → release → complete).
- Invariants: leader cuối=node02 ✓, no split-brain ✓, term monotonic ✓.
Kết quả: `VERIFY-ELECTION: PASS ✅`.

### ✅ Hành vi WHOAMI_NAME — xác nhận bằng tài liệu chính thức
Docs traefik/whoami: bảng Flags có `name | WHOAMI_NAME | Give me a name.` → body có dòng `Name: <value>`.
Regex đối chiếu `/^Name:\s*(.+)$/m` khớp. (Runtime container không chạy được cục bộ — xem ràng buộc.)

## ⚠️ Ràng buộc môi trường (KHÔNG kiểm chứng runtime được — log rõ)
- **Docker daemon KHÔNG chạy** trong sandbox này (`/var/run/docker.sock` không tồn tại, không sudo, không rootless).
  → CHỈ chạy được: `node --check`, `docker compose config` (parse YAML), mô phỏng mock RTDB.
  → KHÔNG chạy được container thật (whoami echo, tailscale status, sshd/rsync) tại đây.
- **Không có Firebase RTDB creds** → election thật dùng mock (đã execute, PASS).
- **Không có Tailscale authkey** → `getTailscaleInfo()` sẽ trả `available:false` + reason; code đã xử lý & log rõ.
- ⟹ Các phần trên CẦN kiểm chứng thật trên **CI (GitHub Actions/Azure)** hoặc **máy có Docker daemon**.
  Hướng dẫn kiểm chứng thực tế đã ghi trong docs (Phase cuối).
