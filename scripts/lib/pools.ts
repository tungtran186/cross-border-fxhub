// Số liệu quỹ dùng chung cho Ignition module và scripts/seed.ts (đơn vị: token "người đọc")
// Tỷ giá minh hoạ: 1 USD = 26.000 VND = 150 JPY = 1.400 KRW = 32 TWD

/// Mỗi quỹ được nạp 1.000.000 vUSD
export const USD_PER_POOL = 1_000_000n;

/// Lượng đồng địa phương ghép với 1.000.000 vUSD trong từng quỹ
export const POOLS = {
  vVND: 26_000_000_000n,
  vJPY: 150_000_000n,
  vKRW: 1_400_000_000n,
  vTWD: 32_000_000n,
} as const;

export type LocalSymbol = keyof typeof POOLS;
