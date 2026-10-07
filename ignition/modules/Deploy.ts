import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { POOLS, USD_PER_POOL } from "../../scripts/lib/pools.js";

// Đổi số token "người đọc" sang đơn vị nhỏ nhất (18 số lẻ)
const units = (n: bigint) => n * 10n ** 18n;

// initialSupply = lượng cần nạp quỹ + 10% dự phòng
const withBuffer = (n: bigint) => units((n * 110n) / 100n);

export default buildModule("CrossBorderModule", (m) => {
  // 5 đồng stablecoin giả lập: [tên, ký hiệu, initialSupply, faucetAmount]
  // vUSD phải nạp vào cả 4 quỹ nên cần 4 × 1.000.000
  const usd = m.contract("StableToken", ["Virtual US Dollar", "vUSD", withBuffer(4n * USD_PER_POOL), units(1_000n)], { id: "vUSD" });
  const vnd = m.contract("StableToken", ["Virtual Vietnam Dong", "vVND", withBuffer(POOLS.vVND), units(20_000_000n)], { id: "vVND" });
  const jpy = m.contract("StableToken", ["Virtual Japanese Yen", "vJPY", withBuffer(POOLS.vJPY), units(100_000n)], { id: "vJPY" });
  const krw = m.contract("StableToken", ["Virtual Korean Won", "vKRW", withBuffer(POOLS.vKRW), units(1_000_000n)], { id: "vKRW" });
  const twd = m.contract("StableToken", ["Virtual Taiwan Dollar", "vTWD", withBuffer(POOLS.vTWD), units(30_000n)], { id: "vTWD" });

  // Sàn hoán đổi, vUSD làm trục
  const hub = m.contract("FXHub", [usd], { id: "FXHub" });

  // Mở quỹ cho 4 đồng còn lại (quỹ rỗng, seed.ts sẽ nạp tiền)
  m.call(hub, "listToken", [vnd], { id: "listVND" });
  m.call(hub, "listToken", [jpy], { id: "listJPY" });
  m.call(hub, "listToken", [krw], { id: "listKRW" });
  m.call(hub, "listToken", [twd], { id: "listTWD" });

  return { usd, vnd, jpy, krw, twd, hub };
});
