# Phase 01 — Analysis & Design (Vai trò: Analyst → Design Reviewer)

> Artifact bắt buộc theo quy trình. Ghi lại phân tích, tra cứu tài liệu, quyết định thiết kế và các ràng buộc môi trường **trước khi** viết code. Toàn bộ dựa trên đọc codebase thật + tài liệu Tailscale chính thức (2025).

---

## 0. Bối cảnh & yêu cầu

### Phần 1 — Cải tiến orchestrator
1. **Log tiếng Việt**: mỗi election-snapshot label thêm diễn giải VN.
   VD: `Election snapshot: standby-blocked (đang chờ — leader hiện tại còn sống, chưa tới lượt tiếp quản)`.
2. **Nhật ký chuyển giao (handoff) ghi vào RTDB** để đối chiếu log thực thi có đúng luồng không.
3. **test.yml**: sau khi lên leader, mỗi 5s `curl whoami.{DOMAIN}` → đối chiếu tới khi trùng leader đang chạy thì dừng. Có so sánh kết quả.
4. **Node info + Tailscale**: bổ sung ip / hostname / version / os của tailnet vào node record.

### Phần 2 — Đồng bộ dữ liệu giữa node qua SSH (nodesync)
- 1 phương án hợp nhất, config enable từng kênh: **Tailscale → Cloudflare → Hybrid**, có **fallback** tự động.
- Multi-user: `SSH_<n>_USER / _PASS / _PUBLIC_KEY / _PRIVATE_KEY` (base64 mask `base64 -w0`).
- Phân quyền: user chạy được **mọi lệnh** giữa các node (full shell, sudo khi cần, có thể root).
- **DNS resolve phù hợp Tailscale** (theo tài liệu).
- Orchestrator node record bổ sung: **ssh user đang dùng, cwd, kênh sync active, quyền** → kiểm thử + report kỹ.
- Luồng: node02 start → pull remote store → diff với node01 qua SSH → nếu khác thì sync trực tiếp từ node01 → mới start app.
- Trong lúc sync: node01 **treo request** → mặc định **503 + Retry-After** (client/node02 retry sau).
- Script test toàn vẹn dữ liệu, log VN đầy đủ (bắt đầu sync / file nào / thời gian bao lâu…).
- Hướng dẫn triển khai + kiểm chứng thực tế bằng `ls` / checksum / size / time.

---

## 1. Hiểu codebase hiện tại (đọc thật)

### orchestrator/
- `scripts/main.mjs` — vòng đời node: register → chờ ready → election loop (standby `tryAcquire`, leader `renew` + phát hiện successor) → handoff pipeline → release.
- `scripts/elect.mjs` — election qua RTDB `transaction()`, fencing `term++`. Có hàm log "Election snapshot: <label>". **← chèn diễn giải VN ở đây.**
- `scripts/register.mjs` — ghi `/nodes/<id>` (state, host, ci, meta, heartbeat), `onDisconnect`. **← bổ sung tailscale + ssh/cwd info.**
- `scripts/watch.mjs`, `scripts/status.mjs` — quan sát.
- `scripts/lib/rtdb.mjs` — firebase-admin, `connectRtdb()` trả `{ db, paths, stack }`. Paths: `leader`, `nodes`, `events`, `handoff`. **← thêm `handoffLog`.**
- `scripts/lib/node-identity.mjs` — `getNodeIdentity()`, ci detect, `ORCH_META_*`. **← thêm tailscale/ssh identity.**
- `scripts/lib/docker.mjs` — `compose()`, `REPO_DIR`.
- `scripts/lib/log.mjs` — `log/error/redact`, format `[orchestrator <iso>]`.
- `scripts/hooks/` — `index.mjs` (pipeline), `stop-cloudflared.mjs`, `upload-data.mjs`. Config `config.jsonc`.

### CI
- `.github/workflows/test.yml` — build images (đã có orchestrator), setup-env, start-stack, `wait-and-test.mjs`, keep-alive, teardown.
- `scripts/wait-and-test.mjs` — chờ container, dò public URL, verify HTTP. **← thêm bước đối chiếu leader qua whoami.**
- `scripts/runners/start-stack.mjs` — up compose (named/quick), enable profile theo env pattern `LITESTREAM_<n>_SERVICE`, `RCLONE_<n>_NAME`. **← pattern index này dùng lại cho `SSH_<n>_*` và nodesync profile.**

### whoami
- `traefik/whoami:v1.11.0` — echo hostname + headers + có thể thêm env qua `WHOAMI_NAME`. Container hostname cố định `whoami` → **không tự phân biệt node**. Cần cách để whoami trả về node-id của leader.

---

## 2. Tra cứu tài liệu Tailscale (bắt buộc — yêu cầu #3)

Nguồn chính thức đã đọc (2025):
- Quad100 / `100.100.100.100`: https://tailscale.com/docs/reference/quad100
- MagicDNS: https://tailscale.com/docs/features/magicdns
- Userspace networking: https://tailscale.com/docs/concepts/userspace-networking
- Docker params: https://tailscale.com/docs/features/containers/docker/docker-params
- Tailscale SSH: https://tailscale.com/docs/features/tailscale-ssh

### Kết luận then chốt ảnh hưởng thiết kế
1. **Userspace mode** (`TS_USERSPACE=true`, stack đang dùng): `tailscaled` chạy như **SOCKS5/HTTP proxy**; container khác **không** dùng trực tiếp tailnet trừ khi:
   - (a) `network_mode: service:tailscale` — chia sẻ netns với container tailscale, HOẶC
   - (b) đi qua SOCKS5 proxy (`TS_SOCKS5_SERVER`, chỉ dial được địa chỉ tailnet — issue #1617).
2. **`--accept-dns=false`** (stack đang set): MagicDNS `.ts.net` **không** resolve qua system DNS trong container. ⇒ Phải resolve peer bằng **LocalAPI** `tailscale status --json` / `tailscale ip <host>`, KHÔNG dựa vào `/etc/resolv.conf`.
   - Quad100 `100.100.100.100:53` chỉ hoạt động nếu được thêm vào resolv.conf và accept-dns bật.
3. **Tailscale SSH** (`--ssh`): Tailscale chiếm port 22 cho traffic tailnet, ủy quyền bằng ACL (không cần key). Đây là kênh **Tailscale** trong thiết kế. Nhưng cần authkey/tailnet thật ⇒ trong workspace này **không kiểm chứng end-to-end tailnet được** → sẽ mô phỏng resolver + log rõ "SKIPPED: thiếu tailnet".

### Quyết định resolver Tailscale (đúng tài liệu)
`nodesync` sẽ resolve peer theo thứ tự:
1. `tailscale status --json` (LocalAPI) → map hostname → tailnet IP (100.x.y.z) hoặc FQDN `.ts.net`. **Ưu tiên — đúng với userspace + accept-dns=false.**
2. Nếu bật accept-dns và có Quad100: cho phép fallback resolve `.ts.net` qua `100.100.100.100`.
3. Cuối cùng fallback IP tĩnh cấu hình `SSH_<n>_HOST` / `NODESYNC_PEER_HOST`.

---

## 3. Ràng buộc môi trường (trung thực)

| Hạng mục | Local workspace | CI (GHA/Azure) |
|---|---|---|
| Node/Docker/Compose | ✅ có (Node 22, Docker 29, Compose v5) | ✅ |
| Firebase RTDB creds | ❌ không có | ✅ (secret) |
| Tailscale authkey/tailnet | ❌ không có | ⚠️ tùy secret |
| Cloudflare tunnel token | ❌ không có | ✅ (secret) |

⇒ **Chiến lược kiểm chứng:**
- **Election / handoff / RTDB paths / handoffLog**: mock RTDB in-memory (cùng interface firebase-admin) → execute 2-runner thật, có log + đối chiếu.
- **nodesync SSH + rsync + phân quyền + cwd + toàn vẹn dữ liệu**: dựng **2 container node thật** (sshd + rsync) → chạy thật 100%, `ls`/checksum/size/time thật.
- **Tailscale tailnet / Cloudflare edge**: không có creds → **log SKIPPED + lý do**, kiểm chứng phần resolver bằng cách mock output `tailscale status --json`. Report ghi rõ phần nào thật / phần nào mô phỏng.

---

## 4. Kiến trúc chốt

### 4.1 Service mới `nodesync/`
```
nodesync/
├── nodesync.yml          # compose service, profile: nodesync|full ; ENABLE qua profile + SSH_ENABLE
├── Dockerfile            # openssh-server + rsync + docker-cli + tailscale-cli + node
├── entrypoint.mjs        # tạo user từ SSH_<n>_*, phân quyền, start sshd
├── config.jsonc          # kênh ưu tiên, retry-after, đường dẫn sync
├── .env.example          # catalog SSH_* + NODESYNC_*
├── scripts/
│   ├── setup-users.mjs   # tạo multi-user, sudo NOPASSWD, authorized_keys
│   ├── resolve-peer.mjs  # resolver Tailscale→Cloudflare→Hybrid (fallback)
│   ├── sync.mjs          # luồng: pull remote → diff qua ssh → rsync từ node01 → done
│   ├── hold-requests.mjs # bật/tắt chế độ treo request (503 Retry-After) qua Caddy
│   ├── verify-integrity.mjs # test toàn vẹn 2 node (log VN, checksum/size/time)
│   └── lib/… (env, ssh, log dùng chung / tái dùng của repo)
└── README.md
```
- Mount **full workspace** repo (rw) + **docker.sock** (chạy lệnh trong/ngoài docker), chạy **root**.
- `network_mode`: mặc định `proxy`; option `service:tailscale` khi kênh Tailscale bật (theo docs userspace).

### 4.2 Config-driven channels + fallback
`SSH_CHANNEL_TAILSCALE_ENABLE / _CLOUDFLARE_ENABLE / _HYBRID_ENABLE`.
Setup chỉ chạy cho kênh bật. Sync thử theo thứ tự **Tailscale → Cloudflare → Hybrid**, kênh fail → fallback, log rõ.

### 4.3 Multi-user
Pattern index `SSH_<n>_USER/PASS/PUBLIC_KEY/PRIVATE_KEY` — parse như `LITESTREAM_<n>_SERVICE` sẵn có. Base64 mask secrets, redact log.

### 4.4 Orchestrator bổ sung
- `register.mjs`: node record thêm `tailscale{ ip, hostname, version, os, tailnet }` + `ssh{ user, cwd, channel, privileged }`.
- `lib/node-identity.mjs`: gom tailscale/ssh identity (đọc `tailscale status --json`, env `SSH_*`, `process.cwd()`).
- `elect.mjs`: label election snapshot + diễn giải VN.
- `lib/rtdb.mjs`: thêm path `handoffLog`.
- `hooks/index.mjs`: ghi `handoffLog` từng bước handoff.

### 4.5 Luồng sync + treo request
1. node02 boot → `nodesync sync`: (a) pull remote store (litestream/rclone) → (b) diff với node01 qua ssh (checksum) → (c) nếu khác: gọi node01 bật hold (503 Retry-After) → rsync trực tiếp node01→node02 → tắt hold → (d) start app.
2. Nếu sync lỗi/timeout: node01 vẫn giữ hold-mode/độc lập xử lý (đã có handoff logic), node02 retry sau.

---

## 5. Design review (self-review, vai trò Reviewer)

| Điểm | Đánh giá |
|---|---|
| Tách `nodesync` riêng | ✅ đúng convention "1 service 1 thư mục", orchestrator gọn |
| Userspace + accept-dns=false | ✅ resolver dùng LocalAPI, KHÔNG dựa system DNS — đúng docs |
| Multi-user index | ✅ tái dùng pattern repo, không regex thô |
| Fallback channels | ✅ có log lý do fallback; rủi ro: Cloudflare SSH cần cấu hình ingress → sẽ tách rõ, skip nếu thiếu |
| Treo request 503 | ✅ đơn giản, chắc chắn; rủi ro: cần Caddy route → dùng snippet import, guard bằng file flag |
| Chạy root + docker.sock full quyền | ⚠️ quyền cao → README cảnh báo bảo mật, chỉ bật khi cần |
| Kiểm chứng | ✅ thật phần SSH/rsync/quyền/cwd; mô phỏng phần tailnet/CF có log rõ |

**Kết luận review:** thiết kế khả thi, đúng tài liệu, đúng convention. Đi tiếp sang Phase 02 (implement).
