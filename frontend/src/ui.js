// Phần thuần giao diện: icon, huy hiệu đồng tiền, khung thông báo.
// Không gọi contract, không xử lý ví – chỉ trả về chuỗi HTML để main.js chèn vào trang.
import {
  ArrowDownLeft,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CircleAlert,
  CircleCheck,
  Clock,
  Copy,
  ExternalLink,
  Gift,
  History,
  Info,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
  Wallet,
} from "lucide";

const ICONS = {
  "arrow-down-left": ArrowDownLeft,
  "arrow-down-up": ArrowDownUp,
  "arrow-right": ArrowRight,
  "arrow-up-right": ArrowUpRight,
  "book-open": BookOpen,
  check: Check,
  "circle-alert": CircleAlert,
  "circle-check": CircleCheck,
  clock: Clock,
  copy: Copy,
  "external-link": ExternalLink,
  gift: Gift,
  history: History,
  info: Info,
  loader: LoaderCircle,
  lock: Lock,
  pause: Pause,
  play: Play,
  plus: Plus,
  "refresh-cw": RefreshCw,
  send: Send,
  "shield-check": ShieldCheck,
  smartphone: Smartphone,
  "triangle-alert": TriangleAlert,
  wallet: Wallet,
};

// Icon lucide dạng chuỗi <svg> (dữ liệu icon là danh sách [thẻ, thuộc tính])
export function icon(name, cls = "") {
  const node = ICONS[name];
  if (!node) return "";
  const children = node
    .map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`)
    .join("");
  return (
    `<svg class="icon ${cls}" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
    `${children}</svg>`
  );
}

// Gắn icon vào mọi phần tử tĩnh trong index.html có thuộc tính data-icon="tên"
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll("[data-icon]")) {
    el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon));
    el.removeAttribute("data-icon");
  }
}

// Thông tin hiển thị của từng đồng tiền: ký hiệu trên huy hiệu tròn, tên tiếng Việt, lớp màu
export const COINS = {
  vUSD: { sign: "$", name: "Đô la Mỹ", cls: "coin-usd" },
  vVND: { sign: "₫", name: "Việt Nam Đồng", cls: "coin-vnd" },
  vJPY: { sign: "¥", name: "Yên Nhật", cls: "coin-jpy" },
  vKRW: { sign: "₩", name: "Won Hàn Quốc", cls: "coin-krw" },
  vTWD: { sign: "NT$", name: "Đài tệ", cls: "coin-twd" },
};

// Huy hiệu tròn màu riêng cho mỗi đồng tiền (vẽ bằng CSS)
export function coinBadge(symbol, size = "") {
  const c = COINS[symbol] ?? { sign: "?", cls: "" };
  const small = c.sign.length > 1 ? " coin-long" : "";
  return `<span class="coin ${c.cls}${small} ${size}" aria-hidden="true">${c.sign}</span>`;
}

export const coinName = (symbol) => COINS[symbol]?.name ?? symbol;

// Icon theo loại thông báo
const STATUS_ICON = { success: "circle-check", error: "circle-alert", info: "loader", warn: "triangle-alert" };

// Khung thông báo: icon + nội dung (html đã được escape ở nơi gọi)
export function statusBody(type, html) {
  const spin = type === "info" ? "spin" : "";
  return `${icon(STATUS_ICON[type] ?? "info", `status-icon ${spin}`)}<div class="status-text">${html}</div>`;
}
