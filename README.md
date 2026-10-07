# Cross-border Payments trên Blockchain

Demo chuyển tiền xuyên biên giới bằng stablecoin giả lập (vUSD, vVND, vJPY, vKRW, vTWD).
Người gửi đưa vJPY/vKRW/vTWD/vUSD, người nhận ở Việt Nam nhận vVND trong **một** giao dịch,
qua sàn `FXHub` mô hình trục USD (AMM x·y=k, phí 0,3% mỗi chặng). Chỉ dùng testnet, không tiền thật.

Yêu cầu: Node.js >= 22.13.

## Cài đặt

```shell
npm install
npx hardhat build
npx hardhat test
```

## Chạy demo trên máy (mạng local)

Mở **2 cửa sổ terminal** trong thư mục dự án.

**Terminal 1** – bật blockchain local, để nguyên cửa sổ này chạy suốt buổi:

```shell
npx hardhat node
```

Node in ra 20 tài khoản test, mỗi tài khoản 10.000 ETH giả. Tắt node (Ctrl+C) là mất toàn bộ dữ liệu.

**Terminal 2** – chạy lần lượt:

```shell
# 1. Deploy 5 token + FXHub, niêm yết 4 đồng (--reset: xoá lần deploy cũ của node trước đó)
npx hardhat ignition deploy ignition/modules/Deploy.ts --network localhost --reset

# 2. Nạp thanh khoản: mỗi quỹ 1.000.000 vUSD ghép với
#    26 tỷ vVND / 150 triệu vJPY / 1,4 tỷ vKRW / 32 triệu vTWD
npx hardhat run scripts/seed.ts --network localhost

# 3. Demo: tài khoản #1 xin faucet vJPY, gửi 100.000 vJPY → tài khoản #2 nhận vVND
npx hardhat run scripts/demo-send.ts --network localhost
```

Ghi chú:
- Chạy lại `seed.ts` không nạp trùng: quỹ đã có tiền sẽ được bỏ qua.
- `demo-send.ts` chạy lần 2 trong 24h sẽ báo thiếu vJPY vì faucet mỗi ví chỉ xin được 1 lần/24h.
  Muốn chạy lại từ đầu: tắt node, bật lại, rồi làm lại bước 1 → 3.
- Địa chỉ contract được Ignition ghi vào
  `ignition/deployments/chain-31337/deployed_addresses.json`; các script tự đọc file này.

## Giao diện web (frontend/)

Vite + JavaScript thuần + ethers v6, kết nối MetaMask. Làm sau khi đã chạy node → deploy → seed ở trên.

```shell
# 4. Xuất ABI + địa chỉ contract cho frontend → frontend/src/contracts.json
#    (chạy lại mỗi khi deploy lại)
npx hardhat run scripts/export-frontend.ts

# 5. Lần đầu: cài thư viện cho frontend
cd frontend
npm install

# 6. Bật web, mở link http://localhost:5173 trong trình duyệt có MetaMask
npm run dev
```

Trong MetaMask cần có mạng Hardhat Local (RPC `http://127.0.0.1:8545`, chain ID `31337`)
và import tài khoản test (khoá in ra khi chạy `npx hardhat node`). Tab **Quản trị** chỉ hiện với
tài khoản #0 (owner, người deploy).

Khi tắt rồi bật lại node: chạy lại bước 1, 2, 4 rồi tải lại trang, và trong MetaMask chọn
Settings → Advanced → **Clear activity tab data** để tránh lỗi "nonce too high".

## Cấu trúc

| Đường dẫn | Nội dung |
|---|---|
| `contracts/StableToken.sol` | ERC-20 18 số lẻ, owner mint, `faucet()` 1 lần/24h |
| `contracts/FXHub.sol` | Sàn hoán đổi trục USD: `quote`, `sendCrossBorder`, quản trị quỹ |
| `test/FXHub.ts` | 13 test tự động (Mocha + Chai + ethers) |
| `ignition/modules/Deploy.ts` | Deploy 5 token + FXHub, `listToken` 4 đồng |
| `scripts/lib/pools.ts` | Số liệu các quỹ (dùng chung cho deploy và seed) |
| `scripts/seed.ts` | Nạp thanh khoản, in tỷ giá |
| `scripts/demo-send.ts` | Gửi thử 100.000 vJPY → vVND, in báo giá, gas, mã giao dịch |
| `scripts/export-frontend.ts` | Ghi ABI + địa chỉ (theo chainId) ra `frontend/src/contracts.json` |
| `frontend/src/main.js` | Giao diện: ví, faucet, chuyển tiền, lịch sử, quản trị |
| `frontend/src/format.js` | Định dạng số kiểu Việt Nam (17.206.650,27) |
| `frontend/src/errors.js` | Dịch lỗi MetaMask/contract sang tiếng Việt |
