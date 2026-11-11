// Đo thời gian tải lịch sử của frontend trên Sepolia: cách CŨ vs cách MỚI (lần đầu / mở lại).
// Chỉ ĐỌC qua RPC công cộng trong frontend/src/contracts.json → không cần mật khẩu keystore, không tốn gas.
//
// Chạy:   node scripts/bench-history.mjs [RPC_URL]
// (cần cài thư viện frontend trước: cd frontend && npm install)
//
//  - Cách cũ: quét XUÔI từ block deploy, mỗi đoạn 10.000 block, chỉ hiện khi quét xong.
//  - Cách mới: frontend/src/logcache.js – quét NGƯỢC, đoạn 50.000 block tự chia nhỏ, có bộ nhớ đệm.
//    "Lần đầu" = bộ nhớ đệm trống; "Mở lại" = chạy lần 2 với bộ nhớ đệm vừa lưu.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const FE = fileURLToPath(new URL("../frontend/", import.meta.url));
const require = createRequire(FE + "package.json"); // dùng ethers của frontend
const { JsonRpcProvider, Contract } = require("ethers");
const config = require(FE + "src/contracts.json");

// Node không có localStorage như trình duyệt → làm bản giả lưu trong bộ nhớ
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};
const { scanWithCache, cacheKey } = await import(pathToFileURL(FE + "src/logcache.js").href);

const CHAIN_ID = 11155111;
const chain = config.chains[CHAIN_ID];
const rpcUrl = process.argv[2] || chain.rpcUrl;
const provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
const hub = new Contract(chain.hub, config.abi.FXHub, provider);
const me = await hub.owner(); // đo lịch sử của ví owner (ví đã gửi các lệnh mẫu)
const latest = await provider.getBlockNumber();
console.log(`RPC ${rpcUrl} · block ${chain.deployBlock} → ${latest} (${latest - chain.deployBlock + 1} block) · ví ${me}`);

// Hai loại lịch sử giống frontend: chuyển tiền của 1 ví (lọc topic) và toàn bộ nạp/rút thanh khoản
const remit = async (a, b) =>
  (await Promise.all([hub.queryFilter(hub.filters.Remittance(me), a, b), hub.queryFilter(hub.filters.Remittance(null, me), a, b)])).flat();
const liq = async (a, b) =>
  (await Promise.all([hub.queryFilter(hub.filters.LiquidityAdded(), a, b), hub.queryFilter(hub.filters.LiquidityRemoved(), a, b)])).flat();

// Cách cũ: quét xuôi đoạn 10.000 block, rồi hỏi giờ của từng block có event
async function oldWay(query) {
  const t0 = performance.now();
  const events = [];
  for (let s = chain.deployBlock; s <= latest; s += 10_000) events.push(...(await query(s, Math.min(s + 9_999, latest))));
  await Promise.all([...new Set(events.map((e) => e.blockNumber))].map((n) => provider.getBlock(n)));
  return { ms: Math.round(performance.now() - t0), count: new Set(events.map((e) => `${e.transactionHash}-${e.index}`)).size };
}

// Cách mới: đúng hàm frontend đang dùng; ghi lại lúc dòng đầu tiên hiện ra
async function newWay(key, query) {
  let firstRow = null;
  const t0 = performance.now();
  const stats = await scanWithCache({
    provider,
    chainId: CHAIN_ID,
    key,
    firstBlock: chain.deployBlock,
    query,
    isCancelled: () => false,
    onUpdate: (records) => {
      if (firstRow === null && records.length) firstRow = Math.round(performance.now() - t0);
    },
  });
  return { ...stats, firstRow };
}

const cases = [
  ["Lịch sử chuyển tiền (ví owner)", remit, `remit:${me.toLowerCase()}`],
  ["Lịch sử thanh khoản", liq, "liquidity"],
];
for (const [name, query, scope] of cases) {
  const key = cacheKey(CHAIN_ID, chain.hub, scope);
  const old = await oldWay(query);
  const cold = await newWay(key, query);
  const warm = await newWay(key, query);
  console.log(`\n${name}: ${old.count} event`);
  console.log(`  Cũ            : xong ${old.ms} ms (chỉ hiện khi xong)`);
  console.log(`  Mới – lần đầu : dòng đầu ${cold.firstRow ?? "–"} ms, xong ${cold.ms} ms, ${cold.chunks} đoạn, chia nhỏ ${cold.retries} lần`);
  console.log(`  Mới – mở lại  : dòng đầu ${warm.firstRow ?? "–"} ms (bộ nhớ đệm), xong ${warm.ms} ms, quét ${warm.newBlocks} block mới`);
}
