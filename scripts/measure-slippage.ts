// Đo trượt giá theo quy mô lệnh – CHỈ GỌI quote(), không gửi giao dịch, không tốn gas.
// Chạy: npx hardhat run scripts/measure-slippage.ts --network sepolia
// Ghi:  data/slippage.csv (Sepolia) hoặc data/chain-<id>/slippage.csv
import { network } from "hardhat";
import { loadDeployment, fmt } from "./lib/deployment.js";
import { dataDir, dec, listedOut, pct, writeCsv, type Pool } from "./lib/measure.js";

const USD_LEVELS = [100n, 500n, 1_000n, 5_000n, 10_000n, 50_000n, 100_000n]; // mức gửi tương đương (USD)
const CORRIDORS = ["vJPY", "vKRW", "vTWD", "vUSD"] as const; // gửi đồng này → nhận vVND
const E18 = 10n ** 18n;

const { ethers } = await network.create();
const { chainId, usd, tokens, hub } = await loadDeployment(ethers);
const all = { vUSD: usd, ...tokens };
const addr = async (s: string) => all[s as keyof typeof all].getAddress();
const pool = async (s: string): Promise<Pool | "USD"> => {
  if (s === "vUSD") return "USD";
  const p = await hub.pools(await addr(s));
  return { token: p.reserveToken, usd: p.reserveUsd };
};

const vnd = await pool("vVND");
const block = await ethers.provider.getBlockNumber();
console.log(`Mạng chainId ${chainId}, block ${block}. Tỷ giá quỹ hiện tại:`);
for (const s of ["vVND", "vJPY", "vKRW", "vTWD"]) {
  const p = (await pool(s)) as Pool;
  console.log(`  1 vUSD = ${dec((p.token * E18) / p.usd).replace(/(\.\d{4})\d+$/, "$1")} ${s}  (quỹ ${fmt(p.token)} / ${fmt(p.usd)} vUSD)`);
}

const COLS = ["block", "hanh_lang", "so_chang", "muc_usd", "so_gui", "dong_gui", "so_nhan", "nhan_theo_ty_gia_quy",
  "hut_tong_pct", "phan_phi_pct", "phan_truot_gia_pct"];
const rows: Record<string, unknown>[] = [];
console.log(`\n${"Hành lang".padEnd(12)}${"Mức (USD)".padStart(10)}${"Hụt tổng".padStart(11)}${"Phí".padStart(9)}${"Trượt giá".padStart(11)}`);
for (const from of CORRIDORS) {
  const pFrom = await pool(from);
  const hops = from === "vUSD" ? 1 : 2;
  // phí còn lại sau n chặng: 0,997^n → phần phí = 1 − 0,997^n (tính bằng số nguyên để chính xác)
  const keepNum = 997n ** BigInt(hops), keepDen = 1000n ** BigInt(hops);
  for (const level of USD_LEVELS) {
    // Quy đổi mức USD sang số đồng gửi theo tỷ giá quỹ hiện tại
    const amountIn = pFrom === "USD" ? level * E18 : (level * E18 * pFrom.token) / pFrom.usd;
    const out = await hub.quote(await addr(from), await addr("vVND"), amountIn);
    const listed = listedOut(amountIn, pFrom, vnd);
    const afterFee = (listed * keepNum) / keepDen; // số nhận nếu chỉ mất phí, không trượt giá
    const total = pct(listed - out, listed);
    const fee = pct(listed - afterFee, listed);
    const slip = pct(afterFee - out, listed);
    rows.push({
      block, hanh_lang: `${from}→vVND`, so_chang: hops, muc_usd: level.toString(),
      so_gui: dec(amountIn), dong_gui: from, so_nhan: dec(out), nhan_theo_ty_gia_quy: dec(listed),
      hut_tong_pct: total, phan_phi_pct: fee, phan_truot_gia_pct: slip,
    });
    const f = (n: number) => n.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
    console.log(`${(from + "→vVND").padEnd(12)}${level.toLocaleString("vi-VN").padStart(10)}${f(total).padStart(11)}${f(fee).padStart(9)}${f(slip).padStart(11)}`);
  }
}

const file = `${dataDir(chainId)}/slippage.csv`;
await writeCsv(file, COLS, rows);
console.log(`\nĐã ghi ${rows.length} dòng vào ${file}`);
