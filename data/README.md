# Số liệu đo (Bước 8)

Số liệu đo trên **Sepolia** – tạo bằng các script trong `scripts/` (thứ tự lệnh: xem README gốc, mục "Đo số liệu").
Số liệu chạy thử trên mạng local nằm ở `data/chain-31337/` và không đưa vào git.

| File | Script tạo ra | Nội dung |
|---|---|---|
| `history.csv` | `collect-history.ts` | Mọi lệnh chuyển tiền (event Remittance) từ lúc deploy: thời gian, hành lang, số gửi/nhận, tỷ giá thực nhận, gas, phí ETH, ví nhận mới hay cũ, link Etherscan |
| `slippage.csv` | `measure-slippage.ts` | Báo giá `quote()` cho 4 hành lang × 7 mức gửi (100 → 100.000 USD): % hụt, tách phần phí và phần trượt giá |
| `transactions.csv` | `measure-tx.ts` | Giao dịch đo thật: gas approve/send, giá gas, phí ETH, thời gian xác nhận (giây), block, link Etherscan |
| `summary.md` | `summarize.ts` | Bảng tóm tắt tiếng Việt cho tiểu luận |

Số trong CSV dùng dấu chấm thập phân, không có dấu phân cách hàng nghìn (để Excel/Python đọc được).
Thời gian ghi theo giờ UTC.
