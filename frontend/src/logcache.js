// Đọc event (log) từ blockchain nhanh hơn:
//  - Lưu event đã đọc vào localStorage (bộ nhớ đệm của trình duyệt), kèm các đoạn block đã quét.
//    Mở lại tab: hiện NGAY dữ liệu đã lưu, rồi chỉ quét phần block chưa quét.
//  - Quét NGƯỢC từ block mới nhất về trước, hiện dần → giao dịch gần đây hiện ra trước.
//  - Kích thước đoạn quét tự điều chỉnh: thử 50.000 block, RPC báo lỗi thì chia đôi rồi thử lại.
// localStorage có thể bị chặn (chế độ ẩn danh, đầy bộ nhớ…) → mọi thao tác đều bọc try/catch,
// khi đó trang vẫn chạy bình thường, chỉ là không nhớ được giữa các lần mở.

const VERSION = 1;
const MAX_CHUNK = 50_000; // đoạn lớn nhất thử trước
const MIN_CHUNK = 500; // nhỏ hơn mức này vẫn lỗi thì báo lỗi thật
const REORG_DEPTH = 12; // mỗi lần mở quét lại 12 block cuối, phòng block gần nhất bị mạng thay thế

function readJSON(key) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // hết chỗ hoặc bị chặn: bỏ qua, lần sau quét lại
  }
}
export function clearCache(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // bỏ qua
  }
}

// Tách riêng theo chainId + địa chỉ FXHub + loại dữ liệu (vd lịch sử của 1 ví)
export const cacheKey = (chainId, hubAddress, scope) => `fxhub:logs:v${VERSION}:${chainId}:${hubAddress.toLowerCase()}:${scope}`;
const chunkKey = (chainId) => `fxhub:chunk:v${VERSION}:${chainId}`;

// ── Danh sách đoạn block đã quét, dạng [[từ, đến], ...] ──
function addRange(ranges, from, to) {
  const all = [...ranges, [from, to]].sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of all) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
// Bỏ phần đã quét nằm trên block `top`
const cutAbove = (ranges, top) => ranges.filter(([a]) => a <= top).map(([a, b]) => [a, Math.min(b, top)]);
// Các đoạn CHƯA quét trong [lo, hi], đoạn mới nhất đứng đầu
function gaps(ranges, lo, hi) {
  const out = [];
  let cursor = hi;
  for (const [a, b] of [...ranges].sort((x, y) => y[0] - x[0])) {
    if (b < lo) break;
    if (b < cursor) out.push([Math.max(b + 1, lo), cursor]);
    cursor = Math.min(cursor, a - 1);
    if (cursor < lo) break;
  }
  if (cursor >= lo) out.push([lo, cursor]);
  return out.filter(([a, b]) => a <= b);
}

const sortNewest = (records) => records.sort((a, b) => b.block - a.block || b.index - a.index);

// Event của ethers → bản ghi gọn để lưu (BigInt đổi thành chuỗi vì JSON không lưu được BigInt)
function toRecord(log) {
  const args = {};
  for (const [k, v] of Object.entries(log.args.toObject())) args[k] = String(v);
  return { id: `${log.transactionHash}-${log.index}`, block: log.blockNumber, index: log.index, tx: log.transactionHash, name: log.eventName, args };
}

/**
 * Quét event có dùng bộ nhớ đệm.
 *  key        – khoá localStorage (từ cacheKey)
 *  firstBlock – block deploy FXHub (không quét trước block này)
 *  query(from, to) → Promise<danh sách event ethers> trong đoạn [from, to]
 *  onUpdate(records, info) – gọi mỗi khi có dữ liệu mới để vẽ lại; records: mới nhất trước
 *      info = { phase: "cache" | "scan" | "done", progress (0–1), scanning: [từ, đến], stats }
 *  isCancelled() → true nếu người dùng đã bấm tải lại / rời tab (dừng, không ghi đè)
 */
export async function scanWithCache({ provider, chainId, key, firstBlock, query, onUpdate, isCancelled }) {
  const t0 = performance.now();
  const stats = { chunks: 0, retries: 0, fromCache: 0, newBlocks: 0, firstShownMs: null, ms: 0 };
  const shown = () => {
    if (stats.firstShownMs === null) stats.firstShownMs = Math.round(performance.now() - t0);
  };

  // 1. Hiện ngay dữ liệu đã lưu (chưa cần hỏi blockchain)
  let cache = readJSON(key);
  if (cache?.events?.length) {
    stats.fromCache = cache.events.length;
    onUpdate(cache.events, { phase: "cache", progress: 0, stats });
    shown();
  }

  // 2. Kiểm tra bộ nhớ đệm còn đúng chuỗi này không (node local khởi động lại → block cũ không còn)
  const [latest, anchorBlock] = await Promise.all([provider.getBlockNumber(), provider.getBlock(firstBlock)]);
  if (isCancelled()) return null;
  const anchor = anchorBlock?.hash ?? null;
  const top = (cache?.ranges ?? []).reduce((m, [, b]) => Math.max(m, b), -1);
  if (!cache || cache.anchor !== anchor || cache.firstBlock !== firstBlock || top > latest) {
    if (cache) onUpdate([], { phase: "cache", progress: 0, stats }); // dữ liệu cũ sai → xoá khỏi màn hình
    cache = { anchor, firstBlock, ranges: [], events: [] };
    stats.fromCache = 0;
  }
  // Quét lại vài block cuối (không xoá khỏi màn hình ngay – lần quét đầu tiên sẽ trả lại chúng)
  const safeTop = latest - REORG_DEPTH;
  cache.ranges = cutAbove(cache.ranges, safeTop);
  const byId = new Map(cache.events.filter((e) => e.block <= safeTop).map((e) => [e.id, e]));

  // 3. Quét các đoạn còn thiếu, từ mới nhất về cũ nhất
  const todo = gaps(cache.ranges, firstBlock, latest);
  const total = todo.reduce((s, [a, b]) => s + b - a + 1, 0);
  let done = 0;
  let chunk = Number(readJSON(chunkKey(chainId))) || MAX_CHUNK;

  for (const [gapFrom, gapTo] of todo) {
    let end = gapTo;
    while (end >= gapFrom) {
      if (isCancelled()) return null;
      const start = Math.max(gapFrom, end - chunk + 1);
      onUpdate(sortNewest([...byId.values()]), { phase: "scan", progress: total ? done / total : 1, scanning: [start, end], stats });

      let logs;
      try {
        stats.chunks++;
        logs = await query(start, end);
      } catch (e) {
        // RPC từ chối (đoạn quá dài / quá nhiều kết quả / quá thời gian) → chia đôi rồi thử lại
        if (chunk <= MIN_CHUNK) throw e;
        chunk = Math.max(MIN_CHUNK, Math.floor(chunk / 2));
        stats.retries++;
        writeJSON(chunkKey(chainId), chunk); // nhớ cho lần sau khỏi thử lại đoạn quá lớn
        continue;
      }
      if (isCancelled()) return null;

      // Thời điểm của từng block (lưu luôn để lần sau khỏi hỏi lại)
      const records = logs.map(toRecord);
      const times = new Map();
      await Promise.all(
        [...new Set(records.map((r) => r.block))].map(async (n) => times.set(n, (await provider.getBlock(n)).timestamp)),
      );
      if (isCancelled()) return null;
      for (const r of records) byId.set(r.id, { ...r, time: times.get(r.block) });

      // Lưu ngay sau mỗi đoạn: rời tab giữa chừng thì lần sau quét tiếp, không mất công
      cache.ranges = addRange(cache.ranges, start, end);
      cache.events = sortNewest([...byId.values()]);
      writeJSON(key, cache);

      const size = end - start + 1;
      done += size;
      stats.newBlocks += size;
      if (records.length || byId.size) shown();
      end = start - 1;
    }
  }

  cache.events = sortNewest([...byId.values()]);
  writeJSON(key, cache);
  // Lượt này không bị từ chối lần nào mà đoạn đang nhỏ → lần sau thử gấp đôi (phòng lỗi lúc trước chỉ là tạm thời).
  // Trong cùng 1 lượt thì không tăng lại, để khỏi bị RPC từ chối lặp đi lặp lại.
  writeJSON(chunkKey(chainId), stats.retries === 0 ? Math.min(MAX_CHUNK, chunk * 2) : chunk);
  stats.ms = Math.round(performance.now() - t0);
  shown();
  onUpdate(cache.events, { phase: "done", progress: 1, stats });
  return stats;
}
