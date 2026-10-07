// Demo: gửi 100.000 vJPY, người nhận nhận vVND (2 chặng qua vUSD).
// Chạy: npx hardhat run scripts/demo-send.ts --network localhost   (hoặc --network sepolia)
// - Mạng local: tài khoản #1 gửi, tài khoản #2 nhận.
// - Sepolia chỉ có 1 ví (SEPOLIA_PRIVATE_KEY): ví đó tự gửi cho chính nó,
//   hoặc đặt người nhận bằng biến môi trường DEMO_RECIPIENT=0x...
import { network } from "hardhat";
import { loadDeployment, fmt, sendTx, txUrl } from "./lib/deployment.js";

const { ethers } = await network.create();
const signers = await ethers.getSigners();
const sender = signers[1] ?? signers[0];
const recipientAddr = process.env.DEMO_RECIPIENT ?? (signers[2] ?? sender).address;
if (!ethers.isAddress(recipientAddr)) throw new Error(`DEMO_RECIPIENT không phải địa chỉ hợp lệ: ${recipientAddr}`);
const recipient = { address: ethers.getAddress(recipientAddr) };
const { chainId, tokens, hub } = await loadDeployment(ethers);
const jpy = tokens.vJPY;
const vnd = tokens.vVND;
const jpyAddr = await jpy.getAddress();
const vndAddr = await vnd.getAddress();
const hubAddr = await hub.getAddress();
const amountIn = ethers.parseUnits("100000", 18);

console.log(`Mạng:       chainId ${chainId}`);
console.log(`Người gửi:  ${sender.address}`);
console.log(`Người nhận: ${recipient.address}\n`);

// 1. Xin faucet vJPY (mỗi 24h 1 lần; đang trong thời gian chờ thì dùng số dư sẵn có)
const lastFaucet = await jpy.lastFaucetAt(sender.address);
const nextFaucet = lastFaucet + (await jpy.FAUCET_COOLDOWN());
const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
if (lastFaucet === 0n || now >= nextFaucet) {
  await sendTx(chainId, "faucet vJPY", () => jpy.connect(sender).faucet());
} else {
  console.log(`  ↷ faucet vJPY đang chờ 24h (xin lại sau ${new Date(Number(nextFaucet) * 1000).toLocaleString("vi-VN")}), dùng số dư sẵn có`);
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
await sendTx(chainId, "approve vJPY", () => jpy.connect(sender).approve(hubAddr, amountIn));
const before = await vnd.balanceOf(recipient.address);
const receipt = await sendTx(chainId, "sendCrossBorder", () =>
  hub.connect(sender).sendCrossBorder(jpyAddr, vndAddr, amountIn, minOut, recipient.address),
);
const received = (await vnd.balanceOf(recipient.address)) - before;

// % hụt so với tỷ giá niêm yết (phí 2 chặng + trượt giá)
const shortfallBps = ((listedOut - received) * 10000n) / listedOut; // bps = phần vạn

console.log(`\nGửi:                 ${fmt(amountIn)} vJPY`);
console.log(`Theo tỷ giá niêm yết: ${fmt(listedOut)} vVND`);
console.log(`Báo giá (quote):     ${fmt(quoted)} vVND`);
console.log(`minOut (−0,5%):      ${fmt(minOut)} vVND`);
console.log(`Thực nhận:           ${fmt(received)} vVND`);
console.log(`Hụt so với niêm yết: ${(Number(shortfallBps) / 100).toLocaleString("vi-VN")}%`);
console.log(`Gas used:            ${receipt.gasUsed.toLocaleString("vi-VN")}`);
console.log(`Mã giao dịch:        ${txUrl(chainId, receipt.hash)}`);
