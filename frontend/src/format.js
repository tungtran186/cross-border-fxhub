// Định dạng số tiền kiểu Việt Nam: dấu chấm ngăn hàng nghìn, dấu phẩy thập phân
import { formatUnits, parseUnits } from "ethers";

export const DECIMALS = 18;

// 17206650270000000000000000n → "17.206.650,27"
// Số nhỏ hơn 1 (vd tỷ giá 0,0000384) tự hiện thêm chữ số để không bị thành 0
export function fmtAmount(value, digits = 2) {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  let keep = digits;
  if (abs > 0n && abs < 10n ** BigInt(DECIMALS)) {
    const fracPart = formatUnits(abs, DECIMALS).split(".")[1] ?? "";
    const firstNonZero = fracPart.search(/[1-9]/);
    if (firstNonZero >= 0) keep = Math.max(digits, firstNonZero + 4);
  }
  keep = Math.min(keep, DECIMALS);

  // Làm tròn tới `keep` chữ số thập phân
  const unit = 10n ** BigInt(DECIMALS - keep);
  const digitsStr = ((abs + unit / 2n) / unit).toString().padStart(keep + 1, "0");
  const intPart = digitsStr.slice(0, digitsStr.length - keep);
  const frac = digitsStr.slice(digitsStr.length - keep).replace(/0+$/, "");

  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (negative ? "-" : "") + grouped + (frac ? "," + frac : "");
}

// Đọc số người dùng gõ theo kiểu Việt Nam: "100.000" hoặc "1,5" → BigInt (đơn vị nhỏ nhất)
// Trả về null nếu không hợp lệ
export function parseAmount(text) {
  const cleaned = String(text).trim().replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,18})?$/.test(cleaned)) return null;
  return parseUnits(cleaned, DECIMALS);
}

// Phần trăm, đầu vào tính bằng phần vạn (bps): 73n → "0,73%"
export function fmtPct(bps) {
  return (Number(bps) / 100).toLocaleString("vi-VN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + "%";
}

// Thời điểm (giây Unix) → "14:05 07/10/2026"
export function fmtTime(seconds) {
  const d = new Date(Number(seconds) * 1000);
  return d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) + " " + d.toLocaleDateString("vi-VN");
}

// 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 → 0x7099…79C8
export const shortAddr = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
