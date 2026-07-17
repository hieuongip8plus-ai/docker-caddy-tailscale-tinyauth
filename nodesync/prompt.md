Cải tiến `nodesync`, nhớ tạo task schedule để kiểm tra hoàn thành trước.

1. Sử dụng lại chức năng tạo SSH user theo `SSH_<index>_user`, `SSH_<index>_pass`, script này phải chạy được trên github actions và azure pipeline. Chạy phần này trong yml của workflow. Có log. Có mask secret.
2. Tạo script để tạo các env trong `nodesync/scripts`: ssh-setup-env.mjs, => gắn vào package.json
3. Chuẩn hóa lại: TUNNEL_SERVICE_TOKEN_ID và TUNNEL_SERVICE_TOKEN_SECRET => thành CF_SSH_TUNNEL_SERVICE_TOKEN_IDvà CF_SSH_TUNNEL_SERVICE_TOKEN_SECRET => giống với qui tắc của cloudflare

- Thêm chức năng tạo các giá trị của env này trong `cloudflare/scripts/provision-tunnel.mjs` bằng email và api global api => ghi nhận vào env theo qui tắc file này luôn.
- Chuẩn hóa các env của services này phải có prefix: `SSH_xxxx` (riêng các cloudflare thì tuân thủ CF)

4. Thêm `SSH_SYNC_SMOKE_ENABLE`=> để bật chế độ kiểm thử:

- Trong lúc thực thi sẽ tạo các file nằm trong `ci-runtime/smoke-sync-data` để cho các runner chạy sau thực hiện sync về. Ghi nhận các thông tin trong env có prefix: `ORCH_META_`, có thêm ngày giờ, có checksum kiểm tra. Có các thư mục với data temp để kiểm tra sync file và dir
- Khi runner sau sync về, thì phải log ra các thông tin những file và thư mục sync về, có: time, checksum, files, dirs, thời gian bắt đầu sync, thời gian kết thúc, mất bao lâu....
- Thực hiện sync trên cả 3 nghiệp vụ channel: tailscale, cloudflare, hybrid => mỗi nghiệp vụ có báo cáo riêng, thực hiện song song nếu có thể, cái này lỗi không ảnh hưởng tới cái khác.

5. Chuẩn hóa lại docs: readme, deploy...
6. Triển khai code và push lên github, đồng thời theo dõi quá trình hoạt động, nếu có lỗi tiến hành fix => push => theo dõi tiếp => (lặp lại đến khi xong), chỉ khi nào xanh hết, hoạt động đúng thì mới ngưng task này. Thiếu thông tin gì tôi sẽ bổ sung và tiếp tục thực hiện đến khi hoàn thành.
