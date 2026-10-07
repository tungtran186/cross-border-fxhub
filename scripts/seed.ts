// Nạp thanh khoản vào 4 quỹ của FXHub.
// Chạy: npx hardhat run scripts/seed.ts --network localhost
import { network } from "hardhat";
import { loadDeployment, fmt } from "./lib/deployment.js";
import { POOLS, USD_PER_POOL, type LocalSymbol } from "./lib/pools.js";

const { ethers } = await network.create();
const [owner] = await ethers.getSigners(); // tài khoản #0 = người deploy = owner
const { usd, tokens, hub } = await loadDeployment(ethers);
const hubAddr = await hub.getAddress();
const units = (n: bigint) => ethers.parseUnits(n.toString(), 18);

console.log(`Owner: ${owner.address}`);
console.log(`FXHub: ${hubAddr}\n`);

for (const symbol of Object.keys(POOLS) as LocalSymbol[]) {
  const token = tokens[symbol];
  const tokenAddr = await token.getAddress();

  // Quỹ đã có tiền rồi thì bỏ qua, tránh nạp trùng khi chạy lại script
  const before = await hub.pools(tokenAddr);
  if (before.reserveUsd > 0n) {
    console.log(`${symbol}: quỹ đã có thanh khoản, bỏ qua`);
    continue;
  }

  const amountToken = units(POOLS[symbol]);
  const amountUsd = units(USD_PER_POOL);

  // approve: cho phép FXHub rút đúng số tiền này từ ví owner
  await (await token.approve(hubAddr, amountToken)).wait();
  await (await usd.approve(hubAddr, amountUsd)).wait();
  await (await hub.addLiquidity(tokenAddr, amountToken, amountUsd)).wait();
  console.log(`${symbol}: đã nạp ${fmt(amountToken)} ${symbol} + ${fmt(amountUsd)} vUSD`);
}

// In tỷ giá từng quỹ = số đồng địa phương / số vUSD trong quỹ
console.log("\nTỷ giá sau khi nạp:");
for (const symbol of Object.keys(POOLS) as LocalSymbol[]) {
  const p = await hub.pools(await tokens[symbol].getAddress());
  const rate = (p.reserveToken * 10n ** 18n) / p.reserveUsd; // nhân 10^18 để giữ phần lẻ
  console.log(
    `  1 vUSD = ${fmt(rate, 4)} ${symbol}   (quỹ: ${fmt(p.reserveToken)} ${symbol} / ${fmt(p.reserveUsd)} vUSD)`,
  );
}
