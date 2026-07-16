# nodesync — đồng bộ dữ liệu giữa các node qua SSH

Sidecar cho phép các **node (runner CI)** chép file và chạy lệnh cho nhau qua
**SSH**, để **đồng bộ dữ liệu** khi chuyển ca. Kết hợp với `orchestrator`
(leader/standby): khi **node02** khởi động, nó sẽ **pull remote store → so khác
biệt với node01 qua SSH → sync trực tiếp từ node01 → rồi mới start app**.

Một phương án hợp nhất, **config-driven**, có **fallback kênh**:

```
Tailscale  →  Cloudflare  →  Hybrid (trực tiếp)
   (ưu tiên)     (dự phòng)      (fallback cuối / test)
```

Bật từng kênh bằng env `SSH_CHANNEL_*_ENABLE`. Kênh nào tắt/lỗi → tự fallback
sang kênh kế tiếp, có log rõ **lý do fallback**.

---

## Bật dịch vụ

```dotenv
SSH_ENABLE=1
COMPOSE_PROFILES=full          # hoặc: core,nodesync

# Multi-user (tạo nhiều user theo index)
SSH_1_USER=sync
SSH_1_PASS_B64=1
SSH_1_PASS=c3luY3Bhc3M=        # base64 -w0 của "syncpass"
SSH_1_PUBLIC_KEY=ssh-ed25519 AAAA... sync@ci
SSH_1_PRIVILEGED=1             # sudo NOPASSWD:ALL (chạy MỌI lệnh) — mặc định 1

SSH_2_USER=admin
SSH_2_PASS=adminpass

# Kênh + fallback
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=0
SSH_CHANNEL_HYBRID_ENABLE=1

# Peer node01
NODESYNC_PEER_TAILSCALE_HOST=proxy-stack-a   # hostname tailnet
NODESYNC_PEER_HOST=node01                     # host trực tiếp (hybrid/test)
NODESYNC_PEER_USER=sync
```

```bash
COMPOSE_PROFILES=full docker compose up -d nodesync
docker compose logs -f nodesync
```

---

## Multi-user `SSH_<n>_*`

| Env | Ý nghĩa |
|-----|---------|
| `SSH_<n>_USER` | tên user (bắt buộc để tạo user index n) |
| `SSH_<n>_PASS` / `_PASSWORD` | mật khẩu (đặt `_B64=1` nếu base64) |
| `SSH_<n>_PUBLIC_KEY` | ghi vào `~/.ssh/authorized_keys` |
| `SSH_<n>_PRIVATE_KEY` | ghi vào `~/.ssh/id_ed25519` (đặt `_B64=1` nếu base64) |
| `SSH_<n>_PRIVILEGED` | `1` (mặc định) = sudo NOPASSWD:ALL; `0` = không |
| `SSH_<n>_SHELL` | shell (mặc định `/bin/bash`) |
| `SSH_<n>_UID` | uid cố định (tuỳ chọn) |

Secret (`PASS`, `PRIVATE_KEY`) mask base64 theo qui tắc repo (`base64 -w0`), và
**không bao giờ in ra log** (logger redact).

---

## Phân quyền & DNS resolve Tailscale

- **Phân quyền:** mỗi user privileged được cấp `NOPASSWD:ALL` trong
  `/etc/sudoers.d/nodesync-<user>` → chạy **mọi lệnh** giữa các node; thêm vào
  group `docker` (nếu có) để chạy lệnh **trong/ngoài docker** qua socket mount.
  Container chạy **root** (`user: "0:0"`) để có quyền cao nhất.

- **DNS resolve Tailscale (đúng tài liệu):** stack dùng **userspace mode** +
  `--accept-dns=false` ⇒ MagicDNS `.ts.net` **không** resolve qua
  `/etc/resolv.conf`. `nodesync` resolve peer bằng **LocalAPI**:
  1. `tailscale status --json` → map hostname/dnsName → IP `100.x.y.z` (ưu tiên).
  2. `tailscale ip -4 <host>`.
  3. Fallback IP tĩnh `NODESYNC_PEER_HOST`.
  (Tài liệu: [quad100](https://tailscale.com/docs/reference/quad100),
   [magicdns](https://tailscale.com/docs/features/magicdns),
   [userspace](https://tailscale.com/docs/concepts/userspace-networking),
   [tailscale-ssh](https://tailscale.com/docs/features/tailscale-ssh)).

---

## Luồng sync (node02 ← node01)

1. node02 boot → (đã pull remote store qua litestream/rclone).
2. `sync.mjs`: resolve node01 (fallback kênh) → **diff** từng `sync_path` bằng
   checksum qua SSH.
3. Nếu khác: yêu cầu node01 **BẬT treo request** (503 + Retry-After) → **rsync**
   trực tiếp node01→node02 → node01 **TẮT treo**.
4. Báo cáo (file nào, thời gian, kích thước) → app start tiếp.

**Treo request** (mặc định `retry-after`): `hold-requests.mjs on` tạo file cờ
`ci-runtime/nodesync/hold.flag`; khi tồn tại, node01 trả `503 Retry-After` để
client/node02 retry sau `NODESYNC_RETRY_AFTER_SECONDS`. Sync xong → xoá cờ.

---

## Script

| Lệnh | Chức năng |
|------|-----------|
| `node scripts/entrypoint.mjs` | tạo user + cấu hình sshd + start sshd |
| `node scripts/setup-users.mjs [--dry-run]` | tạo multi-user + phân quyền |
| `node scripts/resolve-peer.mjs [--json]` | test resolve peer (fallback kênh) |
| `node scripts/sync.mjs [--dry-run] [--local-demo]` | chạy luồng đồng bộ |
| `node scripts/hold-requests.mjs on\|off\|status` | bật/tắt treo request |
| `node scripts/verify-integrity.mjs --local A B [--json]` | kiểm tra toàn vẹn 2 thư mục |

Tất cả script hỗ trợ `--dry-run` và `--silent` (theo convention repo).

---

## Kiểm chứng thực tế

Xem `docs/nodesync-verification.md` — hướng dẫn triển khai + kiểm chứng bằng
`ls` / checksum / size / time, kèm kết quả execute thật (rsync + verify-integrity
qua 13 kịch bản).
