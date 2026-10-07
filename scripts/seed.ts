// Nạp thanh khoản vào 4 quỹ của FXHub.
// Chạy: npx hardhat run scripts/seed.ts --network localhost   (hoặc --network sepolia)
// Chạy lại an toàn: quỹ đã có tiền thì bỏ qua, approve còn đủ hạn mức thì không approve lại.
import { network } from "hardhat";
import { loadDeployment, fmt, sendTx } from "./lib/deployment.js";
import { POOLS, USD_PER_POOL, type LocalSymbol } from "./lib/pools.js";

const { ethers } = await network.create();
const [owner] = await ethers.getSigners(); // ví deploy = owner
const { chainId, usd, tokens, hub } = await loadDeployment(ethers);
const hubAddr = await hub.getAddress();
const units = (n: bigint) => ethers.parseUnits(n.toString(), 18);

console.log(`Mạng:  chainId ${chainId}`);
console.log(`Owner: ${owner.address}`);
console.log(`FXHub: ${hubAddr}\n`);

const symbols = Object.keys(POOLS) as LocalSymbol[];
for (const [i, symbol] of symbols.entries()) {
  const token = tokens[symbol];
  const tokenAddr = await token.getAddress();
  console.log(`[${i + 1}/${symbols.length}] Quỹ ${symbol}`);

  // Quỹ đã có tiền rồi thì bỏ qua, tránh nạp trùng khi chạy lại script
  const before = await hub.pools(tokenAddr);
  if (before.reserveUsd > 0n) {
    console.log(`  ↷ đã có thanh khoản, bỏ qua\n`);
    continue;
  }

  const amountToken = units(POOLS[symbol]);
  const amountUsd = units(USD_PER_POOL);

  // approve: cho phép FXHub rút đúng số tiền này từ ví owner (bỏ qua nếu hạn mức còn đủ)
  if ((await token.allowance(owner.address, hubAddr)) < amountToken) {
    await sendTx(chainId, `approve ${symbol}`, () => token.approve(hubAddr, amountToken));
  }
  if ((await usd.allowance(owner.address, hubAddr)) < amountUsd) {
    await sendTx(chainId, `approve vUSD`, () => usd.approve(hubAddr, amountUsd));
  }
  await sendTx(chainId, `addLiquidity ${symbol}`, () => hub.addLiquidity(tokenAddr, amountToken, amountUsd));
  console.log(`  → đã nạp ${fmt(amountToken)} ${symbol} + ${fmt(amountUsd)} vUSD\n`);
}

// In tỷ giá từng quỹ = số đồng địa phương / số vUSD trong quỹ
console.log("Tỷ giá sau khi nạp:");
for (const symbol of symbols) {
  const p = await hub.pools(await tokens[symbol].getAddress());
  const rate = (p.reserveToken * 10n ** 18n) / p.reserveUsd; // nhân 10^18 để giữ phần lẻ
  console.log(
    `  1 vUSD = ${fmt(rate, 4)} ${symbol}   (quỹ: ${fmt(p.reserveToken)} ${symbol} / ${fmt(p.reserveUsd)} vUSD)`,
  );
}
