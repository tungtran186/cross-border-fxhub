// Đo giao dịch thật: thời gian xác nhận, gas, phí, % hụt – GỬI GIAO DỊCH THẬT từ ví deploy.
// Dùng số dư token sẵn có (KHÔNG gọi faucet). Hỏi xác nhận (y/n) trước khi gửi.
// Chạy: npx hardhat run scripts/measure-tx.ts --network sepolia
// Ghi nối từng dòng vào data/transactions.csv (Sepolia) hoặc data/chain-<id>/transactions.csv
//
// Kịch bản (mỗi lệnh tương đương 200 USD theo tỷ giá quỹ):
//   A. 4 hành lang JPY/KRW/TWD/USD → VND, gửi tới ví ĐÃ có vVND
//   B. 3 lệnh USD → VND tới 3 ví nhận MỚI (địa chỉ ngẫu nhiên)
//   C. 3 lệnh USD → VND giống hệt tới ví ĐÃ có vVND  → so B với C để thấy gas tạo số dư mới
import { createInterface } from "node:readline/promises";
import { network } from "hardhat";
import { Wallet, formatEther, formatUnits, parseEther, type TransactionReceipt } from "ethers";
import { loadDeployment, fmt } from "./lib/deployment.js";
import { SEPOLIA, appendCsv, dataDir, dec, etherscanTx, listedOut, pct, type Pool } from "./lib/measure.js";

const USD_EACH = 200n;
const MIN_ETH = parseEther("0.01"); // ví còn ít hơn mức này thì dừng
// Gas ước tính cho mỗi loại giao dịch (lấy dư so với số đo trên Sepolia sau Glamsterdam)
const EST_GAS_APPROVE = 140_000n;
const EST_GAS_SEND = 270_000n;
// Ví nhận "cũ" (đã có vVND). Trên Sepolia là ví người nhận demo; đổi được bằng biến OLD_RECIPIENT
const OLD_RECIPIENT_SEPOLIA = "0x7267205d54D1A80eD75641804720d8289c49DDb0";
const E18 = 10n ** 18n;

const { ethers } = await network.create();
const signers = await ethers.getSigners();
const me = signers[0]; // ví deploy
const { chainId, usd, tokens, hub } = await loadDeployment(ethers);
const all = { vUSD: usd, ...tokens };
type Sym = keyof typeof all;
const addr = (s: Sym) => all[s].getAddress();
const hubAddr = await hub.getAddress();
const poolOf = async (s: Sym): Promise<Pool | "USD"> => {
  if (s === "vUSD") return "USD";
  const p = await hub.pools(await addr(s));
  return { token: p.reserveToken, usd: p.reserveUsd };
};
const oldRecipient = process.env.OLD_RECIPIENT ?? (chainId === SEPOLIA ? OLD_RECIPIENT_SEPOLIA : signers[2]?.address);
if (!oldRecipient || !ethers.isAddress(oldRecipient)) throw new Error("Thiếu ví nhận cũ (đặt OLD_RECIPIENT=0x...)");

// 1. Lập danh sách lệnh, quy đổi 200 USD sang từng đồng (làm tròn số nguyên token)
type Job = { nhom: string; from: Sym; recipient: string; viNhan: "cũ" | "mới"; amount: bigint };
const amountFor = async (s: Sym) => {
  const p = await poolOf(s);
  return p === "USD" ? USD_EACH * E18 : ((USD_EACH * E18 * p.token) / p.usd / E18) * E18;
};
const jobs: Job[] = [];
for (const s of ["vJPY", "vKRW", "vTWD", "vUSD"] as Sym[]) {
  jobs.push({ nhom: "A. 4 hành lang", from: s, recipient: oldRecipient, viNhan: "cũ", amount: await amountFor(s) });
}
for (let i = 0; i < 3; i++) {
  jobs.push({ nhom: "B. ví nhận mới", from: "vUSD", recipient: Wallet.createRandom().address, viNhan: "mới", amount: await amountFor("vUSD") });
}
for (let i = 0; i < 3; i++) {
  jobs.push({ nhom: "C. ví nhận cũ", from: "vUSD", recipient: oldRecipient, viNhan: "cũ", amount: await amountFor("vUSD") });
}

// 2. Tổng số token cần, kiểm tra số dư, xem cần approve đồng nào
const need = new Map<Sym, bigint>();
for (const j of jobs) need.set(j.from, (need.get(j.from) ?? 0n) + j.amount);
const toApprove: { s: Sym; amount: bigint }[] = [];
console.log(`Mạng chainId ${chainId} · ví deploy ${me.address}`);
console.log(`Ví nhận cũ: ${oldRecipient} (vVND hiện có: ${fmt(await tokens.vVND.balanceOf(oldRecipient))})\n`);
console.log("Token cần dùng (từ số dư sẵn có, không gọi faucet):");
for (const [s, amount] of need) {
  const bal = await all[s].balanceOf(me.address);
  const allowance = await all[s].allowance(me.address, hubAddr);
  console.log(`  ${s}: cần ${fmt(amount)}, đang có ${fmt(bal)}${allowance >= amount ? " (đã đủ hạn mức approve)" : ""}`);
  if (bal < amount) throw new Error(`Không đủ ${s}: cần ${fmt(amount)}, ví chỉ có ${fmt(bal)}`);
  if (allowance < amount) toApprove.push({ s, amount });
}

// 3. Ước tính ETH, kiểm tra số dư, hỏi xác nhận
const fee = await ethers.provider.getFeeData();
const gasPrice = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
const estGas = BigInt(toApprove.length) * EST_GAS_APPROVE + BigInt(jobs.length) * EST_GAS_SEND;
const estEth = (estGas * gasPrice * 13n) / 10n; // +30% dự phòng
const ethBal = await ethers.provider.getBalance(me.address);
console.log(`\nSẽ gửi ${toApprove.length} approve + ${jobs.length} lệnh chuyển tiền (tuần tự).`);
console.log(`Ước tính: ~${estGas.toLocaleString("vi-VN")} gas × ${formatUnits(gasPrice, "gwei")} gwei (+30%) ≈ ${formatEther(estEth)} ETH`);
console.log(`Số dư ví: ${formatEther(ethBal)} ETH`);
if (ethBal < MIN_ETH) throw new Error(`Ví còn dưới ${formatEther(MIN_ETH)} ETH – dừng. Hãy xin thêm SepoliaETH.`);
if (ethBal < estEth) throw new Error("Số dư ETH thấp hơn ước tính – dừng để tránh hết tiền giữa chừng.");

const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = (await rl.question("Gửi các giao dịch trên? (y/n) ")).trim().toLowerCase();
rl.close();
if (answer !== "y") {
  console.log("Đã huỷ, không gửi giao dịch nào.");
  process.exit(0);
}

// 4. Gửi tuần tự: chờ biên nhận từng lệnh; lỗi nonce → chờ 30 giây rồi thử lại
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNonceError = (e: unknown) => /nonce|replacement/i.test(String((e as Error)?.message ?? e));
async function sendWithRetry(label: string, send: () => Promise<{ hash: string }>) {
  for (let attempt = 1; ; attempt++) {
    try {
      const tx = await send();
      return { hash: tx.hash, sentAt: Date.now() };
    } catch (e) {
      if (!isNonceError(e) || attempt >= 3) throw e;
      console.log(`  ⚠ ${label}: lỗi nonce, chờ 30 giây rồi thử lại (lần ${attempt + 1}/3)`);
      await sleep(30_000);
    }
  }
}
// Hỏi biên nhận mỗi giây (đo thời gian chính xác ~1 giây)
async function waitReceipt(hash: string): Promise<{ receipt: TransactionReceipt; confirmedAt: number }> {
  for (let i = 0; i < 600; i++) {
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    if (receipt) {
      if (receipt.status !== 1) throw new Error(`Giao dịch ${hash} bị huỷ (revert)`);
      return { receipt, confirmedAt: Date.now() };
    }
    await sleep(1000);
  }
  throw new Error(`Quá 10 phút chưa có biên nhận cho ${hash}`);
}

const file = `${dataDir(chainId)}/transactions.csv`;
const runId = new Date().toISOString();
const COLS = ["lan_chay", "thoi_gian_utc", "loai", "nhom", "hanh_lang", "vi_nhan", "nguoi_nhan", "so_gui", "so_nhan",
  "nhan_theo_ty_gia_quy", "hut_pct", "gas_used", "gia_gas_gwei", "phi_eth", "giay_xac_nhan", "block", "tx_hash", "etherscan"];
const base = (receipt: TransactionReceipt, sentAt: number, confirmedAt: number) => ({
  lan_chay: runId,
  thoi_gian_utc: new Date(sentAt).toISOString(),
  gas_used: receipt.gasUsed.toString(),
  gia_gas_gwei: dec(receipt.gasPrice, 9),
  phi_eth: dec(receipt.gasUsed * receipt.gasPrice),
  giay_xac_nhan: ((confirmedAt - sentAt) / 1000).toFixed(1),
  block: receipt.blockNumber,
  tx_hash: receipt.hash,
  etherscan: etherscanTx(chainId, receipt.hash),
});

for (const { s, amount } of toApprove) {
  const { hash, sentAt } = await sendWithRetry(`approve ${s}`, () => all[s].connect(me).approve(hubAddr, amount));
  const { receipt, confirmedAt } = await waitReceipt(hash);
  await appendCsv(file, COLS, { ...base(receipt, sentAt, confirmedAt), loai: "approve", nhom: "approve", hanh_lang: s, so_gui: dec(amount) });
  console.log(`  ✅ approve ${s}: gas ${receipt.gasUsed.toLocaleString("vi-VN")}, ${((confirmedAt - sentAt) / 1000).toFixed(1)} giây`);
}

const vndAddr = await addr("vVND");
for (const [i, j] of jobs.entries()) {
  const fromAddr = await addr(j.from);
  // tỷ giá quỹ ngay trước lệnh này (quỹ thay đổi sau mỗi lệnh)
  const listed = listedOut(j.amount, await poolOf(j.from), await poolOf("vVND"));
  const quoted = await hub.quote(fromAddr, vndAddr, j.amount);
  const minOut = (quoted * 995n) / 1000n;
  const label = `[${i + 1}/${jobs.length}] ${j.from}→vVND (ví ${j.viNhan})`;
  const { hash, sentAt } = await sendWithRetry(label, () =>
    hub.connect(me).sendCrossBorder(fromAddr, vndAddr, j.amount, minOut, j.recipient),
  );
  const { receipt, confirmedAt } = await waitReceipt(hash);
  const ev = receipt.logs.map((l) => { try { return hub.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "Remittance");
  const out: bigint = ev ? ev.args.amountOut : quoted;
  await appendCsv(file, COLS, {
    ...base(receipt, sentAt, confirmedAt),
    loai: "send", nhom: j.nhom, hanh_lang: `${j.from}→vVND`, vi_nhan: j.viNhan, nguoi_nhan: j.recipient,
    so_gui: dec(j.amount), so_nhan: dec(out), nhan_theo_ty_gia_quy: dec(listed), hut_pct: pct(listed - out, listed),
  });
  console.log(
    `  ✅ ${label}: ${fmt(j.amount)} → ${fmt(out)} vVND, hụt ${pct(listed - out, listed).toLocaleString("vi-VN")}%, ` +
      `gas ${receipt.gasUsed.toLocaleString("vi-VN")}, ${((confirmedAt - sentAt) / 1000).toFixed(1)} giây`,
  );
}
console.log(`\nĐã ghi vào ${file}. Chạy tiếp: node scripts/summarize.ts${chainId === SEPOLIA ? "" : ` ${dataDir(chainId)}`}`);
