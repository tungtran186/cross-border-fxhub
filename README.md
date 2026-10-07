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

## Deploy lên Sepolia (testnet)

### Chuẩn bị (làm 1 lần)

Cất 3 bí mật vào keystore của Hardhat (mã hoá bằng mật khẩu, không nằm trong code hay git):

```shell
npx hardhat keystore set SEPOLIA_RPC_URL       # URL RPC Sepolia (Alchemy/Infura...)
npx hardhat keystore set SEPOLIA_PRIVATE_KEY   # khoá ví dev, CHỈ dùng cho testnet
npx hardhat keystore set ETHERSCAN_API_KEY     # khoá API Etherscan để verify
```

Ví dev cần có SepoliaETH để trả phí gas (xin ở faucet, ví dụ
https://cloud.google.com/application/web3/faucet/ethereum/sepolia).

### Chạy theo đúng thứ tự

🔑 = lệnh sẽ hỏi **mật khẩu keystore** (gõ vào terminal, không hiện ký tự). Mỗi lệnh hỏi 1 lần.

```shell
# 1. 🔑 Kiểm tra ví deploy đủ SepoliaETH chưa
npx hardhat run scripts/check-balance.ts --network sepolia
#    Đúng: in địa chỉ ví, số dư, bảng ước tính gas, dòng cuối "✅ Đủ tiền. Có thể deploy."
#    Nếu "❌ Thiếu ... ETH": xin thêm faucet rồi chạy lại. KHÔNG làm tiếp.

# 2. 🔑 Deploy 5 token + FXHub + listToken (KHÔNG dùng --reset trên Sepolia)
npx hardhat ignition deploy ignition/modules/Deploy.ts --network sepolia
#    Ignition hỏi xác nhận deploy lên sepolia → gõ y. Mất vài phút (10 giao dịch).
#    Đúng: "[ CrossBorderModule ] successfully deployed 🚀" + 6 địa chỉ.
#    Địa chỉ được ghi vào ignition/deployments/chain-11155111/ (file này được commit vào git).
#    Bị ngắt giữa chừng: chạy lại đúng lệnh này, Ignition làm tiếp phần còn thiếu.

# 3. 🔑 Verify mã nguồn trên Etherscan
npx hardhat ignition verify chain-11155111 --network sepolia
#    Đúng: mỗi contract báo verify thành công kèm link sepolia.etherscan.io/address/...#code
#    Contract đã verify rồi thì báo "already verified" – không sao.

# 4. 🔑 Nạp thanh khoản 4 quỹ (12 giao dịch, vài phút)
npx hardhat run scripts/seed.ts --network sepolia
#    Đúng: mỗi giao dịch in "⏳ ... https://sepolia.etherscan.io/tx/0x..." rồi "✅ ... block N, gas ..."
#    Cuối cùng in tỷ giá: 1 vUSD = 26.000 vVND / 150 vJPY / 1.400 vKRW / 32 vTWD.
#    Bị ngắt giữa chừng: chạy lại, quỹ đã nạp sẽ "↷ bỏ qua".

# 5. 🔑 Gửi thử 100.000 vJPY → vVND
#    Sepolia chỉ có 1 ví nên ví deploy tự gửi cho chính mình. Muốn gửi cho ví khác (PowerShell):
#      $env:DEMO_RECIPIENT="0x...địa chỉ người nhận..."
npx hardhat run scripts/demo-send.ts --network sepolia
#    Đúng: báo giá ≈ 17.206.650 vVND, thực nhận = báo giá, hụt ≈ 0,73%, gas ≈ 103.000,
#    mã giao dịch dạng link https://sepolia.etherscan.io/tx/0x...

# 6. Xuất địa chỉ Sepolia cho frontend (KHÔNG hỏi mật khẩu: chỉ đọc file trên máy)
npx hardhat run scripts/export-frontend.ts
#    Đúng: in 2 dòng "chain 31337 (Hardhat Local)" và "chain 11155111 (Sepolia)".

# 7. Lưu địa chỉ Sepolia vào git
git add ignition/deployments/chain-11155111 frontend/src/contracts.json
git commit -m "Deploy Sepolia"
```

Sau bước 6, mở web (`npm run dev` trong `frontend/`), bấm **Chuyển sang Sepolia** là dùng được trên testnet;
mã giao dịch trên web sẽ là link tới sepolia.etherscan.io.

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
| `scripts/check-balance.ts` | In ví deploy, số dư ETH, ước tính gas deploy + seed; thiếu tiền thì dừng |
| `scripts/export-frontend.ts` | Ghi ABI + địa chỉ (theo chainId) ra `frontend/src/contracts.json` |
| `frontend/src/main.js` | Giao diện: ví, faucet, chuyển tiền, lịch sử, quản trị |
| `frontend/src/format.js` | Định dạng số kiểu Việt Nam (17.206.650,27) |
| `frontend/src/errors.js` | Dịch lỗi MetaMask/contract sang tiếng Việt |
