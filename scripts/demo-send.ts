// Demo: tài khoản #1 gửi 100.000 vJPY, tài khoản #2 nhận vVND (2 chặng qua vUSD).
// Chạy: npx hardhat run scripts/demo-send.ts --network localhost
import { network } from "hardhat";
import { loadDeployment, fmt } from "./lib/deployment.js";

const { ethers } = await network.create();
const [, sender, recipient] = await ethers.getSigners(); // #1 gửi, #2 nhận
const { tokens, hub } = await loadDeployment(ethers);
const jpy = tokens.vJPY;
const vnd = tokens.vVND;
const jpyAddr = await jpy.getAddress();
const vndAddr = await vnd.getAddress();
const hubAddr = await hub.getAddress();
const amountIn = ethers.parseUnits("100000", 18);

console.log(`Người gửi (#1):  ${sender.address}`);
console.log(`Người nhận (#2): ${recipient.address}\n`);

// 1. Xin faucet vJPY (mỗi 24h 1 lần; nếu đang chờ mà ví đã đủ tiền thì bỏ qua)
try {
  await (await jpy.connect(sender).faucet()).wait();
  console.log("Đã xin faucet vJPY");
} catch {
  console.log("Faucet đang trong thời gian chờ 24h, dùng số dư sẵn có");
}
const jpyBalance = await jpy.balanceOf(sender.address);
console.log(`Số dư vJPY người gửi: ${fmt(jpyBalance)}`);
if (jpyBalance < amountIn) throw new Error("Không đủ vJPY để gửi");

// 2. Tỷ giá niêm yết (theo tỷ lệ 2 quỹ, chưa tính phí và trượt giá)
const pJpy = await hub.pools(jpyAddr);
const pVnd = await hub.pools(vndAddr);
const listedOut = (amountIn * pJpy.reserveUsd * pVnd.reserveToken) / (pJpy.reserveToken * pVnd.reserveUsd);

// 3. Báo giá và minOut = báo giá trừ 0,5%
const quoted = await hub.quote(jpyAddr, vndAddr, amountIn);
const minOut = (quoted * 995n) / 1000n;

// 4. approve rồi gửi
await (await jpy.connect(sender).approve(hubAddr, amountIn)).wait();
const before = await vnd.balanceOf(recipient.address);
const tx = await hub.connect(sender).sendCrossBorder(jpyAddr, vndAddr, amountIn, minOut, recipient.address);
const receipt = await tx.wait();
const received = (await vnd.balanceOf(recipient.address)) - before;

// % hụt so với tỷ giá niêm yết (phí 2 chặng + trượt giá)
const shortfallBps = ((listedOut - received) * 10000n) / listedOut; // bps = phần vạn

console.log(`\nGửi:                 ${fmt(amountIn)} vJPY`);
console.log(`Theo tỷ giá niêm yết: ${fmt(listedOut)} vVND`);
console.log(`Báo giá (quote):     ${fmt(quoted)} vVND`);
console.log(`minOut (−0,5%):      ${fmt(minOut)} vVND`);
console.log(`Thực nhận:           ${fmt(received)} vVND`);
console.log(`Hụt so với niêm yết: ${(Number(shortfallBps) / 100).toLocaleString("vi-VN")}%`);
console.log(`Gas used:            ${receipt!.gasUsed.toLocaleString("vi-VN")}`);
console.log(`Mã giao dịch:        ${receipt!.hash}`);
