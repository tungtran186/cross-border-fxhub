// Tóm tắt số liệu đo được (Bước 8): đọc 3 file CSV, in bảng tiếng Việt, ghi summary.md.
// Chạy: node scripts/summarize.ts            (đọc data/ – số liệu Sepolia)
//       node scripts/summarize.ts data/chain-31337   (số liệu chạy thử trên mạng local)
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// ═══════════ GIẢ ĐỊNH – nhóm tự cập nhật số thật khi viết bài ═══════════
const ASSUMED_ETH_USD = 3000; // giá 1 ETH (USD) – GIẢ ĐỊNH
const ASSUMED_MAINNET_GAS_GWEI = 2; // giá gas trên Ethereum mainnet (gwei) – GIẢ ĐỊNH
const ASSUMED_DATE = "10/2026"; // thời điểm của 2 giả định trên
// ════════════════════════════════════════════════════════════════════════

const dir = process.argv[2] ?? "data";

// Đọc CSV đơn giản (hỗ trợ ô có ngoặc kép)
function readCsv(file: string): Record<string, string>[] {
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8").replace(/\r/g, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c !== ""));
  return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""]))) : [];
}

// Định dạng kiểu Việt Nam
const vn = (n: number, d = 2) => n.toLocaleString("vi-VN", { minimumFractionDigits: 0, maximumFractionDigits: d });
const vnp = (n: number) => n.toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
const stats = (xs: number[]) =>
  xs.length === 0
    ? null
    : { n: xs.length, avg: xs.reduce((a, b) => a + b, 0) / xs.length, min: Math.min(...xs), max: Math.max(...xs) };
const mainnetUsd = (gas: number) => gas * ASSUMED_MAINNET_GAS_GWEI * 1e-9 * ASSUMED_ETH_USD;

// Bảng Markdown
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const tx = readCsv(`${dir}/transactions.csv`);
const slip = readCsv(`${dir}/slippage.csv`);
const hist = readCsv(`${dir}/history.csv`);
const sends = tx.filter((r) => r.loai === "send");
const approves = tx.filter((r) => r.loai === "approve");

const md: string[] = [];
md.push(`# Tóm tắt số liệu đo – FXHub`);
md.push(
  `Nguồn: \`${dir}/\` – ${tx.length} giao dịch đo (transactions.csv), ${hist.length} lệnh lịch sử (history.csv), ` +
    `${slip.length} báo giá (slippage.csv). Tạo lúc ${new Date().toLocaleString("vi-VN")}.`,
);
md.push(
  `> **Lưu ý:** Sepolia đã nâng cấp **Glamsterdam** (6/10/2026), giá gas cho việc tạo dữ liệu mới và đọc/ghi dữ liệu ` +
    `cao hơn Ethereum mainnet hiện tại (hardfork Osaka). Lượng gas đo trên Sepolia vì vậy **cao hơn** mainnet; ` +
    `cột quy đổi USD chỉ mang tính tham khảo.\n>\n` +
    `> Quy đổi dùng **GIẢ ĐỊNH**: 1 ETH = ${vn(ASSUMED_ETH_USD, 0)} USD, giá gas mainnet = ${vn(ASSUMED_MAINNET_GAS_GWEI)} gwei ` +
    `(thời điểm ${ASSUMED_DATE}). Sửa 2 hằng số ở đầu \`scripts/summarize.ts\` để cập nhật số thật.`,
);

// (a) Thời gian xác nhận
md.push(`## (a) Thời gian xác nhận`);
const tRows: (string | number)[][] = [];
for (const [name, list] of [["Chuyển tiền (send)", sends], ["Approve", approves], ["Tất cả", tx]] as const) {
  const s = stats(list.map((r) => Number(r.giay_xac_nhan)).filter((x) => !Number.isNaN(x)));
  if (s) tRows.push([name, s.n, `${vn(s.avg, 1)} giây`, `${vn(s.min, 1)} giây`, `${vn(s.max, 1)} giây`]);
}
md.push(tRows.length ? table(["Loại", "Số lệnh", "Trung bình", "Nhanh nhất", "Chậm nhất"], tRows) : "_Chưa có số liệu (chạy measure-tx.ts)._");
md.push(`Thời gian tính từ lúc giao dịch được gửi lên mạng tới lúc có biên nhận (hỏi mỗi giây, sai số ~1 giây).`);

// (b) Gas và phí theo loại
md.push(`## (b) Gas và phí theo loại giao dịch`);
const gRows: (string | number)[][] = [];
for (const [name, list] of [
  ["Approve", approves],
  ["Chuyển tiền – ví nhận cũ (đã có vVND)", sends.filter((r) => r.vi_nhan === "cũ")],
  ["Chuyển tiền – ví nhận mới (chưa có vVND)", sends.filter((r) => r.vi_nhan === "mới")],
] as const) {
  const g = stats(list.map((r) => Number(r.gas_used)));
  const f = stats(list.map((r) => Number(r.phi_eth)));
  const p = stats(list.map((r) => Number(r.gia_gas_gwei)));
  if (g && f && p) {
    gRows.push([name, g.n, vn(g.avg, 0), `${vn(g.min, 0)} – ${vn(g.max, 0)}`, vn(p.avg, 3), vn(f.avg, 8), `~${vn(mainnetUsd(g.avg), 3)} USD`]);
  }
}
md.push(
  gRows.length
    ? table(["Loại", "Số lệnh", "Gas TB", "Gas min – max", "Giá gas TB (gwei)", "Phí thực đo được (ETH)", "Phí quy đổi mainnet (giả định)"], gRows)
    : "_Chưa có số liệu (chạy measure-tx.ts)._",
);
const oldG = stats(sends.filter((r) => r.vi_nhan === "cũ" && r.hanh_lang === "vUSD→vVND").map((r) => Number(r.gas_used)));
const newG = stats(sends.filter((r) => r.vi_nhan === "mới").map((r) => Number(r.gas_used)));
if (oldG && newG) {
  md.push(
    `Cùng hành lang vUSD→vVND, gửi tới **ví nhận mới** tốn thêm ~**${vn(newG.avg - oldG.avg, 0)} gas** ` +
      `(+${vnp(((newG.avg - oldG.avg) / oldG.avg) * 100)}) so với ví đã có vVND – chi phí tạo ô nhớ số dư mới trên blockchain.`,
  );
}
if (hist.length) {
  const hNew = stats(hist.filter((r) => r.vi_nhan_moi === "có").map((r) => Number(r.gas_used)));
  const hOld = stats(hist.filter((r) => r.vi_nhan_moi === "không").map((r) => Number(r.gas_used)));
  md.push(
    `Toàn bộ lịch sử (history.csv, ${hist.length} lệnh): ví nhận mới ${hNew ? `${hNew.n} lệnh, gas TB ${vn(hNew.avg, 0)}` : "0 lệnh"}; ` +
      `ví nhận cũ ${hOld ? `${hOld.n} lệnh, gas TB ${vn(hOld.avg, 0)}` : "0 lệnh"}.`,
  );
}

// (c) Trượt giá theo mức gửi
md.push(`## (c) Trượt giá theo quy mô lệnh (báo giá quote(), không tốn gas)`);
if (slip.length) {
  const corridors = [...new Set(slip.map((r) => r.hanh_lang))];
  const levels = [...new Set(slip.map((r) => r.muc_usd))].sort((a, b) => Number(a) - Number(b));
  const get = (c: string, l: string) => slip.find((r) => r.hanh_lang === c && r.muc_usd === l);
  md.push(`Hụt tổng so với tỷ giá quỹ (phí + trượt giá), quỹ mỗi đồng ghép với ~1.000.000 vUSD:`);
  md.push(table(["Mức gửi (USD)", ...corridors], levels.map((l) => [vn(Number(l), 0), ...corridors.map((c) => vnp(Number(get(c, l)?.hut_tong_pct)))])));
  md.push(`Tách phần phí và phần trượt giá:`);
  const splitRows: (string | number)[][] = [];
  for (const c of corridors) {
    for (const l of levels) {
      const r = get(c, l)!;
      splitRows.push([c, `${r.so_chang} chặng`, vn(Number(l), 0), vnp(Number(r.phan_phi_pct)), vnp(Number(r.phan_truot_gia_pct)), vnp(Number(r.hut_tong_pct))]);
    }
  }
  md.push(table(["Hành lang", "Số chặng", "Mức (USD)", "Phí", "Trượt giá", "Tổng hụt"], splitRows));
  md.push(`Phí cố định 0,3% mỗi chặng (1 chặng: 0,30%; 2 chặng: 1 − 0,997² ≈ 0,60%). Trượt giá tăng theo quy mô lệnh so với quỹ.`);
} else md.push("_Chưa có số liệu (chạy measure-slippage.ts)._");

// (d) Chuỗi lệnh liên tiếp cùng hành lang, cùng số gửi → số nhận giảm dần (x*y=k)
md.push(`## (d) Lệnh liên tiếp cùng hành lang: số nhận giảm dần (minh hoạ x·y = k)`);
const ordered = [...sends].sort((a, b) => Number(a.block) - Number(b.block) || a.thoi_gian_utc.localeCompare(b.thoi_gian_utc));
let best: Record<string, string>[] = [];
for (let i = 0; i < ordered.length; ) {
  let j = i + 1;
  while (j < ordered.length && ordered[j].hanh_lang === ordered[i].hanh_lang && ordered[j].so_gui === ordered[i].so_gui) j++;
  if (j - i > best.length) best = ordered.slice(i, j);
  i = j;
}
if (best.length >= 2) {
  md.push(`Chuỗi dài nhất: ${best.length} lệnh ${best[0].hanh_lang}, mỗi lệnh gửi ${vn(Number(best[0].so_gui))} ${best[0].hanh_lang.split("→")[0]}:`);
  md.push(
    table(
      ["Lệnh", "Block", "Số nhận (vVND)", "Giảm so với lệnh trước", "Hụt so với tỷ giá quỹ"],
      best.map((r, k) => [
        k + 1, r.block, vn(Number(r.so_nhan)),
        k === 0 ? "–" : `−${vn(Number(best[k - 1].so_nhan) - Number(r.so_nhan))}`,
        vnp(Number(r.hut_pct)),
      ]),
    ),
  );
  md.push(
    `Mỗi lệnh đưa vUSD vào và rút vVND ra khỏi quỹ, nên quỹ vVND nhỏ dần còn quỹ vUSD lớn dần. Tích x·y giữ (gần) không đổi ` +
      `→ tỷ giá vVND/vUSD xấu đi một chút sau mỗi lệnh, lệnh sau nhận ít hơn lệnh trước.`,
  );
} else md.push("_Chưa có chuỗi ≥ 2 lệnh liên tiếp cùng hành lang và cùng số gửi._");

const out = md.join("\n\n") + "\n";
writeFileSync(`${dir}/summary.md`, out);
console.log(out.replace(/\*\*/g, "").replace(/`/g, ""));
console.log(`Đã ghi ${dir}/summary.md`);
