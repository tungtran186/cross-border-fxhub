// Thu thập lịch sử mọi lệnh chuyển tiền (event Remittance) – CHỈ ĐỌC, không gửi giao dịch.
// Chạy: npx hardhat run scripts/collect-history.ts --network sepolia
// Ghi:  data/history.csv (Sepolia) hoặc data/chain-<id>/history.csv (mạng khác)
import { network } from "hardhat";
import { loadDeployment, fmt } from "./lib/deployment.js";
import { dataDir, dec, deployBlock, etherscanTx, writeCsv } from "./lib/measure.js";

const CHUNK = 10_000; // số block tối đa mỗi lần quét (RPC công cộng thường giới hạn)

const { ethers } = await network.create();
const { chainId, usd, tokens, hub } = await loadDeployment(ethers);
const all = { vUSD: usd, ...tokens };
const symbolOf = new Map<string, string>();
for (const [sym, c] of Object.entries(all)) symbolOf.set((await c.getAddress()).toLowerCase(), sym);
const sym = (addr: string) => symbolOf.get(addr.toLowerCase()) ?? addr;

const from = await deployBlock(chainId);
const to = await ethers.provider.getBlockNumber();
console.log(`Mạng chainId ${chainId}, quét block ${from} → ${to} (mỗi đoạn ${CHUNK.toLocaleString("vi-VN")} block)`);

// 1. Đọc event Remittance theo từng đoạn
const events = [];
for (let start = from; start <= to; start += CHUNK) {
  const end = Math.min(start + CHUNK - 1, to);
  const part = await hub.queryFilter(hub.filters.Remittance(), start, end);
  events.push(...part);
  console.log(`  block ${start}–${end}: ${part.length} lệnh`);
}
console.log(`Tổng: ${events.length} lệnh chuyển tiền\n`);

// "Ví nhận mới" = người nhận chưa có đồng nhận (số dư = 0) ngay trước giao dịch.
// Cách 1: đọc số dư ở block trước đó (cần RPC lưu trạng thái cũ – archive).
// Cách 2 (dự phòng): xem trước đó người nhận đã từng nhận Transfer của đồng này chưa.
async function isNewRecipient(tokenAddr: string, recipient: string, block: number, logIndex: number, txHash: string) {
  const token = await ethers.getContractAt("StableToken", tokenAddr);
  try {
    const bal = await token.balanceOf(recipient, { blockTag: block - 1 });
    return { isNew: bal === 0n, method: "số dư ở block trước" };
  } catch {
    // quét Transfer tới người nhận từ block deploy, cũng theo từng đoạn
    let earlier = 0;
    for (let start = from; start <= block; start += CHUNK) {
      const part = await token.queryFilter(token.filters.Transfer(undefined, recipient), start, Math.min(start + CHUNK - 1, block));
      // chỉ tính Transfer trước giao dịch này (bỏ Transfer nằm trong chính giao dịch đang xét)
      earlier += part.filter(
        (e) => e.transactionHash !== txHash && (e.blockNumber < block || e.index < logIndex),
      ).length;
    }
    return { isNew: earlier === 0, method: "chưa từng nhận Transfer (RPC không có dữ liệu cũ)" };
  }
}

// 2. Chi tiết từng lệnh
const COLS = [
  "block", "thoi_gian_utc", "hanh_lang", "so_chang", "so_gui", "dong_gui", "so_nhan", "dong_nhan",
  "ty_gia_thuc_nhan", "gas_used", "gia_gas_gwei", "phi_eth", "vi_nhan_moi", "cach_xac_dinh",
  "nguoi_gui", "nguoi_nhan", "tx_hash", "etherscan",
];
const rows: Record<string, unknown>[] = [];
const blockTime = new Map<number, number>();
for (const [i, e] of events.entries()) {
  const { sender, recipient, fromToken, toToken, amountIn, amountOut } = e.args;
  if (!blockTime.has(e.blockNumber)) blockTime.set(e.blockNumber, (await ethers.provider.getBlock(e.blockNumber))!.timestamp);
  const receipt = (await ethers.provider.getTransactionReceipt(e.transactionHash))!;
  const gasPrice = receipt.gasPrice; // giá gas thực trả (effective gas price)
  const fresh = await isNewRecipient(toToken, recipient, e.blockNumber, e.index, e.transactionHash);
  const hops = sym(fromToken) === "vUSD" || sym(toToken) === "vUSD" ? 1 : 2;
  rows.push({
    block: e.blockNumber,
    thoi_gian_utc: new Date(blockTime.get(e.blockNumber)! * 1000).toISOString(),
    hanh_lang: `${sym(fromToken)}→${sym(toToken)}`,
    so_chang: hops,
    so_gui: dec(amountIn),
    dong_gui: sym(fromToken),
    so_nhan: dec(amountOut),
    dong_nhan: sym(toToken),
    ty_gia_thuc_nhan: dec((amountOut * 10n ** 18n) / amountIn),
    gas_used: receipt.gasUsed.toString(),
    gia_gas_gwei: dec(gasPrice, 9),
    phi_eth: dec(receipt.gasUsed * gasPrice),
    vi_nhan_moi: fresh.isNew ? "có" : "không",
    cach_xac_dinh: fresh.method,
    nguoi_gui: sender,
    nguoi_nhan: recipient,
    tx_hash: e.transactionHash,
    etherscan: etherscanTx(chainId, e.transactionHash),
  });
  console.log(
    `  [${i + 1}/${events.length}] ${sym(fromToken)}→${sym(toToken)} ${fmt(amountIn)} → ${fmt(amountOut)}, ` +
      `gas ${receipt.gasUsed.toLocaleString("vi-VN")}, ví nhận mới: ${fresh.isNew ? "có" : "không"}`,
  );
}

const file = `${dataDir(chainId)}/history.csv`;
await writeCsv(file, COLS, rows);
console.log(`\nĐã ghi ${rows.length} dòng vào ${file}`);
