# Xác minh NodeSync SSH

## Cấu hình

```dotenv
CONSUL_ENABLE=1
SSH_ENABLE=1
SSH_SYNC_PATHS=ci-data,uploads
SSH_CHANNEL_TAILSCALE_ENABLE=1
SSH_CHANNEL_CLOUDFLARE_ENABLE=1
SSH_CHANNEL_HYBRID_ENABLE=1
SSH_1_USER=nodesync
SSH_1_PASS=<shared-secret>
```

Chạy chuẩn bị local/CI không tương tác:

```bash
npm ci
npm ci --prefix nodesync --omit=dev
npm run ssh:env --prefix nodesync
npm run ssh:smoke:prepare --prefix nodesync
sudo -n node nodesync/scripts/setup-users.mjs --env .env
node scripts/runners/setup-nodesync-ssh.mjs
```

Không log password, private key hoặc token. GitHub dùng `::add-mask::`; Azure dùng
`##vso[task.setsecret]`.
`discover-predecessor.mjs --json` chỉ in manifest; runner ghi vào
`ci-runtime/nodesync/predecessor.json`. `--path` in đường dẫn container nếu cần
debug.

## Cloudflare SSH

Ingress `ssh.<DOMAIN> → ssh://host.docker.internal:22` nằm trong
`cloudflare/scripts/hostnames.jsonc`. Tạo/cập nhật tunnel:

```dotenv
CF_API_EMAIL=<email>
CF_API_KEY_GLOBAL=<global-api-key>
```

```bash
node cloudflare/scripts/provision-tunnel.mjs --env .env --silent
```

Không dùng Cloudflare Access service token. Tunnel token hiện tại chạy connector;
client dùng `cloudflared access ssh --hostname ssh.<DOMAIN>` rồi SSH xác thực
bằng user/password hoặc key.

## Smoke test ba channel

```dotenv
SSH_SYNC_SMOKE_ENABLE=1
```

Runner đầu tạo `ci-runtime/smoke-sync-data`; runner sau chạy Tailscale,
Cloudflare và Hybrid song song. Kiểm tra:

```bash
cat ci-runtime/nodesync/reports/summary.json
cat ci-runtime/nodesync/reports/tailscale.json
cat ci-runtime/nodesync/reports/cloudflare.json
cat ci-runtime/nodesync/reports/hybrid.json
```

Mỗi report phải có `status=passed`, `startedAt`, `finishedAt`, `durationMs`,
`files`, `dirs`, `checksumVerified=true`. Một channel lỗi không hủy report của
channel khác; toàn lượt chỉ fail nếu không channel nào pass.

## Validation cục bộ

```bash
for f in nodesync/scripts/*.mjs nodesync/scripts/lib/*.mjs \
  scripts/runners/setup-nodesync-ssh.mjs \
  cloudflare/scripts/provision-tunnel.mjs; do node --check "$f"; done

docker compose --env-file .env.ci config --quiet
```
