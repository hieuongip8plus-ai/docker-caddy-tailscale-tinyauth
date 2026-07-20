# CI Workflow Optimization — docker-caddy-tailscale-tinyauth

Tài liệu tóm tắt lần tái cấu trúc CI theo `prompt-docker-caddy-tailscale-tinyauth-20260720080307.md`.

Nguyên tắc tối cao: **Tính đúng đắn > tốc độ.** Khi source/Dockerfile/lockfile/compose
thay đổi, stack BẮT BUỘC chạy image build từ commit hiện tại — không bao giờ silently
chạy image cũ.

## Thay đổi theo từng phần

### 1. Workflow `.github/workflows/test.yml` (tái cấu trúc 9 phase)
- Gom step thành 9 phase có tiền tố `P1..P8` + timestamp `ts:start/ts:end` để đo thực tế.
- `permissions` giảm xuống tối thiểu: `contents: read`, `actions: write`, `id-token: write`.
- Bật `concurrency` theo branch (KHÔNG cancel-in-progress vì keep-alive giữ stack có chủ đích).
- Phase 4 gọi `setup-host.mjs` (điều phối song song an toàn) thay 5 step tuần tự.
- Phase 5 chèn `verify-stack-images.mjs` TRƯỚC Start stack (cửa an toàn image).

### 2. Docker cache (BuildKit gha, bỏ tar image cache mặc định)
- **Bỏ hẳn** tar image cache (`actions/cache` + `docker load` ~29s/413MB) khỏi đường mặc định.
- Luôn `docker/setup-buildx-action@v3` + `docker/bake-action@v6` với:
  - `source: .` — build từ checkout local (v6 mặc định build remote git ref!).
  - `load: true` — Compose dùng image local `proxy-stack-*` vừa build.
  - `type=gha` scope riêng từng target (`webssh`/`rclone`/`orchestrator`/`nodesync`).
- `docker-bake.hcl`: thêm `variable "GIT_SHA"` → label revision (truy vết commit; không phá cache).
- `verify-stack-images.mjs`: verify image local khớp run hiện tại; FAIL RÕ RÀNG nếu thiếu/lệch.
- Helper tar cũ (`cache-docker-build-github.mjs`/`-azure.mjs`) giữ lại làm fallback explicit, KHÔNG mặc định.

### 3. Setup Host & SSH
- `setup-host.mjs` điều phối:
  - `ssh:env` (materialize) chạy TRƯỚC.
  - Nhánh A ghi .env tuần tự (tránh race): `smoke-data` → `tinyauth-ci-user`.
  - Nhánh B SSH tuần tự: `setup-users` → `setup-nodesync-ssh`.
  - Hai nhánh chạy SONG SONG với nhau.
- `setup-nodesync-ssh.mjs`:
  - Chỉ cài `openssh-server` KHI THIẾU `sshd` (không cài lại rsync/sshpass).
  - Đọc `/etc/ssh/ssh_host_ed25519_key.pub` trực tiếp thay `ssh-keyscan` qua network
    (giữ manifest format tương thích: prefix `127.0.0.1`).
  - Tạo riêng host key ed25519, chỉ khi chưa tồn tại (không `ssh-keygen -A`).
  - Chỉ restart sshd khi drop-in THỰC SỰ đổi; luôn `sshd -t` trước (re)start.

### 4. Start stack / Tailscale / leader election
- Tách logic trùng giữa `up.mjs` và `start-stack.mjs` vào `scripts/lib/stack-lib.mjs`
  (single source of truth).
- **Bỏ hard-wait 8s** (`TS_MESH_WARMUP_SECONDS`) → probe SOCKS5 `nc -z` tới predecessor,
  retry ngắn có backoff, thoát ngay khi OK (KHÔNG throw — sync.mjs còn tự warmup + fallback).
- **Bỏ `sleep(3000)`** chờ RTDB timestamp → discover ngay.
- **Node đầu tiên** (predecessor.json `source=null`) → skip probe/rsync; sync.mjs ghi
  `sync-ok(first-runner)`; orchestrator giành leader trống (term=1).
- `waitForHealthy` poll 750ms (thay 2s), giữ nguyên tiêu chí healthy.
- `sleep 3` kiểm tra cloudflared → poll `waitForServiceRunning` (fail fast).
- `publish.mjs` idempotent: cache `ci-runtime/tailscale/published.json` (config hash);
  skip API PUT/POST + CLI advertise nếu hash khớp và serve state còn tồn tại.

### 5. An toàn & nghiệm thu
- In commit SHA + image digest trước Start stack; verify image từ chối chạy image cũ.
- Secrets mask; log không in token/password/private key.
- `always()` cleanup + collect/upload logs giữ nguyên; teardown không che lỗi gốc.

## Bất biến được giữ
- **TCP 2222** (tailscale serve → host sshd:22) không bị bất kỳ thay đổi nào đụng tới.
- Publish lỗi chỉ warning, không làm gãy stack/sync.
- Thứ tự an toàn cho node có predecessor: transport → discover → sync xong → cloudflared.

## Kiểm thử
- `npm test` → 49 unit test (stack-lib 25 + publish-state 12 + publish-lib 12) PASS.
- Không có Docker/GitHub runner trong môi trường dev → xác thực qua `--dry-run` + unit test
  + review 3 lớp. CI thực tế cần chạy trên GitHub Actions để nghiệm thu end-to-end.

## File thay đổi
| File | Loại |
|------|------|
| `.github/workflows/test.yml` | sửa (9 phase) |
| `.github/workflows/docker-bake.hcl` | sửa (GIT_SHA label) |
| `scripts/lib/stack-lib.mjs` | mới (single source of truth) |
| `scripts/runners/setup-host.mjs` | mới (điều phối Setup Host) |
| `scripts/runners/verify-stack-images.mjs` | mới (cửa an toàn image) |
| `scripts/runners/setup-nodesync-ssh.mjs` | viết lại (tối ưu SSH) |
| `scripts/runners/start-stack.mjs` | sửa (bỏ hard-wait, dùng stack-lib) |
| `scripts/up.mjs` | sửa (đồng bộ start-stack) |
| `tailscale/scripts/publish.mjs` | sửa (idempotent) |
| `tailscale/scripts/lib/publish-state.mjs` | mới (idempotency cache) |
| `scripts/test/stack-lib.test.mjs` | mới (unit test) |
| `tailscale/test/publish-state.test.mjs` | mới (unit test) |
| `package.json` | thêm script `test` |
