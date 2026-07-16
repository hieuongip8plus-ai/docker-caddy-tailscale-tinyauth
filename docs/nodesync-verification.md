# nodesync — hướng dẫn triển khai & kiểm chứng thực tế

Tài liệu này hướng dẫn **triển khai** dịch vụ `nodesync` và **kiểm chứng** đồng bộ
dữ liệu giữa 2 node bằng `ls` / checksum / size / time, kèm **kết quả execute thật**.

---

## 1. Triển khai

### 1.1 Cấu hình `.env`

```dotenv
SSH_ENABLE=1
COMPOSE_PROFILES=full

# Multi-user
SSH_1_USER=sync
SSH_1_PASS_B64=1
SSH_1_PASS=c3luY3Bhc3M=          # base64 -w0 của "syncpass"
SSH_1_PUBLIC_KEY=ssh-ed25519 AAAA... sync@ci
SSH_1_PRIVILEGED=1

# Kênh + fallback (Tailscale → Cloudflare → Hybrid)
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1

# Peer node01
NODESYNC_PEER_TAILSCALE_HOST=proxy-stack-a
NODESYNC_PEER_HOST=node01
NODESYNC_PEER_USER=sync
NODESYNC_SYNC_PATHS=ci-data,ci-runtime
```

### 1.2 Khởi động

```bash
COMPOSE_PROFILES=full docker compose up -d nodesync
docker compose logs -f nodesync
```

---

## 2. Log tiêu biểu ở từng node

### node01 (nguồn — leader)
```
[nodesync ...] === NODESYNC entrypoint ===
[nodesync ...] nodesync BẬT. Số user cấu hình: 1 [sync]
[nodesync ...] Đã ghi /etc/ssh/sshd_config theo config.jsonc
[nodesync ...] Đã tạo SSH host keys
[nodesync ...] Tạo user "sync" (index=1, privileged=true)
[nodesync ...]   đã đặt password cho "sync" (giá trị ẩn)
[nodesync ...]   ghi authorized_keys cho "sync"
[nodesync ...]   cấp sudo NOPASSWD:ALL cho "sync" (chạy MỌI lệnh)
[nodesync ...] Khởi động sshd foreground trên port 22...
```
Khi được node02 gọi bật treo:
```
[nodesync ...] Bật treo request (mode=retry-after, Retry-After=15s)
[nodesync ...] Đã tạo cờ treo → Caddy/node sẽ trả 503 + Retry-After: 15
... (sau khi node02 sync xong) ...
[nodesync ...] Đã xoá cờ treo → node phục vụ request bình thường trở lại.
```

### node02 (đích — vừa boot, chạy `sync.mjs`)
```
[nodesync ...] === NODESYNC: bắt đầu luồng đồng bộ node02 ← node01 ===
[nodesync ...] workspace=/workspace sync_paths=[ci-data, ci-runtime]
[nodesync ...] ▶ Bước 1: xác nhận remote store đã pull (litestream/rclone) — bắt đầu
[nodesync ...] Resolve peer OK qua kênh "tailscale" → 100.x.y.z (method=status-json)
[nodesync ...] ▶ Bước 2: DIFF dữ liệu với node01 (checksum) — bắt đầu
[nodesync ...]   ci-data: local=abcd... remote=ef01... → KHÁC (cần sync)
[nodesync ...] ▶ Bước 3: yêu cầu node01 BẬT treo request (503 Retry-After)
[nodesync ...] node01 hold → ON (OK)
[nodesync ...] ▶ Bước 4: rsync dữ liệu node01 → node02
[nodesync ...] ▶ rsync path "ci-data" từ node01 — bắt đầu
[nodesync ...] ✔ rsync path "ci-data" từ node01 — xong sau 164ms (Number of files: 8 | ...)
[nodesync ...] node01 hold → OFF (OK)
[nodesync ...] === BÁO CÁO SYNC ===
[nodesync ...]   ✔ ci-data
[nodesync ...] Kết quả: TẤT CẢ OK ✅. App sẵn sàng start.
```

Nếu Tailscale không sẵn → log fallback rõ ràng:
```
[nodesync ...] WARN Kênh "tailscale" không dùng được → fallback. Lý do: tailscale status --json thất bại: ... (tailnet chưa join / thiếu authkey / tailscale-cli không có)
[nodesync ...] Resolve peer OK qua kênh "hybrid" → node01
```

---

## 3. Kiểm chứng bằng `ls` / checksum / size / time (KẾT QUẢ EXECUTE THẬT)

Dưới đây là **kết quả chạy thật** (rsync 3.2.7 + sha256sum GNU coreutils) mô phỏng
node02 lệch (chỉ có `users/1.txt`) đồng bộ từ node01:

### TRƯỚC sync
```
node01/ci-data:
-rw-r--r-- 9   app.db
-rw-r--r-- 8   config.json
drwxr-xr-x     logs/      (app.log 692B)
drwxr-xr-x     users/     (1.txt 9B, 2.txt 9B)

node02/ci-data:
drwxr-xr-x     users/     (1.txt 9B)     ← THIẾU app.db, config.json, logs/, users/2.txt
```

### rsync node01 → node02 (`-az --delete --checksum --stats`)
```
Number of files: 8 (reg: 5, dir: 3)
Number of created files: 5 (reg: 4, dir: 1)
Number of regular files transferred: 4
Total transferred file size: 718 bytes
```

### SAU sync — checksum đối chiếu
```
node01/ci-data & node02/ci-data đều có:
  <sha256> ./app.db
  <sha256> ./config.json
  <sha256> ./logs/app.log
  <sha256> ./users/1.txt
  <sha256> ./users/2.txt

fingerprint tổng:
  node01: 8f6561fac7843f630a449424c6c7f9ccedecd5fca432ee4ff16076bfa3797aee
  node02: 8f6561fac7843f630a449424c6c7f9ccedecd5fca432ee4ff16076bfa3797aee   ← TRÙNG ✅
```

⟹ **Toàn vẹn**: sau sync, 2 node có **cùng danh sách file, cùng size, cùng
checksum, cùng mtime** (rsync `-a` giữ thời gian). File thừa ở node02 (nếu có) bị
`--delete` dọn sạch.

### Lệnh tự kiểm chứng (chạy trong container / host)
```bash
# So per-file checksum + size + time giữa 2 data dir đã sync:
node nodesync/scripts/verify-integrity.mjs --local <dirA> <dirB>

# Hoặc thủ công:
diff <(cd A && find . -type f -exec sha256sum {} + | sort) \
     <(cd B && find . -type f -exec sha256sum {} + | sort) && echo "TOÀN VẸN"
```

---

## 4. Bộ test tự động (execute thật, không cần Docker)

| Script | Nội dung | Kết quả |
|--------|----------|---------|
| `.work/verify/verify-nodesync.mjs` | 14 mẫu dữ liệu đa dạng, hold-flag, rsync, verify-integrity | **PASS ✅** |
| `.work/verify/verify-nodesync-scenarios.mjs` | **13 kịch bản** (rỗng/thiếu/khác/thừa/sâu/unicode/lớn/nhiều file/ẩn/quyền/mix/no-op) | **PASS 13/13 ✅** |

```bash
cd .work/verify
node verify-nodesync.mjs
node verify-nodesync-scenarios.mjs
```

---

## 5. Ràng buộc kiểm chứng cục bộ (trung thực)

- **rsync / checksum / size / time / hold-flag / phân quyền(dry-run) / resolve
  fallback / parse multi-user**: chạy **THẬT 100%** trong sandbox (đã có kết quả).
- **sshd runtime + tailnet thật + cloudflared**: sandbox **không có Docker daemon**
  (không `/var/run/docker.sock`, không sudo/rootless) và **không có tailscale
  authkey / cloudflare token** → phần này cần kiểm chứng trên **CI hoặc host có
  Docker + creds**. Code đã log `reason` rõ ràng khi thiếu môi trường (xem §2).
- Khi chạy trên host có Docker: `docker compose --profile full up -d`, rồi
  `docker compose exec nodesync ssh sync@<peer> 'echo ok'` để xác nhận SSH thật.
