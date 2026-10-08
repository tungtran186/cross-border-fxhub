// Tiện ích dùng chung cho các script đo số liệu (Bước 8)
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { formatUnits } from "ethers";

export const SEPOLIA = 11155111n;

// Số liệu Sepolia ghi vào data/ (đưa vào git); mạng khác (vd local 31337) ghi vào data/chain-<id>/ (bị bỏ qua)
export function dataDir(chainId: bigint): string {
  return chainId === SEPOLIA ? "data" : `data/chain-${chainId}`;
}

// Link Etherscan (chỉ có trên Sepolia)
export const etherscanTx = (chainId: bigint, hash: string) =>
  chainId === SEPOLIA ? `https://sepolia.etherscan.io/tx/${hash}` : "";

// Số token (18 số lẻ) → chuỗi thập phân dấu chấm, cho file CSV (máy đọc được)
export const dec = (v: bigint, decimals = 18) => formatUnits(v, decimals);

// Ô CSV: bọc ngoặc kép nếu có dấu phẩy / ngoặc kép / xuống dòng
const cell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (row: Record<string, unknown>, cols: string[]) => cols.map((c) => cell(row[c])).join(",") + "\n";

// Ghi cả file CSV một lần
export async function writeCsv(file: string, cols: string[], rows: Record<string, unknown>[]) {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await writeFile(file, cols.join(",") + "\n" + rows.map((r) => line(r, cols)).join(""));
}

// Ghi nối 1 dòng (tạo file + dòng tiêu đề nếu chưa có) – bị ngắt giữa chừng vẫn giữ số liệu đã đo
export async function appendCsv(file: string, cols: string[], row: Record<string, unknown>) {
  await mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  if (!existsSync(file)) await writeFile(file, cols.join(",") + "\n");
  await appendFile(file, line(row, cols));
}

// Block deploy FXHub (lấy trong journal của Ignition) – quét event từ block này
export async function deployBlock(chainId: bigint): Promise<number> {
  const journal = await readFile(`ignition/deployments/chain-${chainId}/journal.jsonl`, "utf8");
  for (const l of journal.split("\n")) {
    if (l.includes('"CrossBorderModule#FXHub"') && l.includes('"receipt"')) return JSON.parse(l).receipt.blockNumber;
  }
  return 0;
}

// Số nhận nếu đổi đúng tỷ giá quỹ (chưa phí, chưa trượt giá) – giống công thức ở frontend
export type Pool = { token: bigint; usd: bigint };
export function listedOut(amount: bigint, from: Pool | "USD", to: Pool | "USD"): bigint {
  if (from === "USD" && to !== "USD") return (amount * to.token) / to.usd;
  if (to === "USD" && from !== "USD") return (amount * from.usd) / from.token;
  if (from !== "USD" && to !== "USD") return (amount * from.usd * to.token) / (from.token * to.usd);
  return amount;
}

// Phần trăm (số thực) từ tỷ lệ BigInt, giữ 4 chữ số thập phân
export const pct = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 1_000_000n) / den) / 10_000);
