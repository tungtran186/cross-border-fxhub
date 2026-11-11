import "./style.css";
import { BrowserProvider, Contract, getAddress, isAddress } from "ethers";
import config from "./contracts.json";
import { fmtAmount, fmtFixed, parseAmount, fmtPct, fmtTime, shortAddr } from "./format.js";
import { friendlyError, initErrors, UserError } from "./errors.js";
import { icon, hydrateIcons, coinBadge, coinName, statusBody } from "./ui.js";
import { scanWithCache, cacheKey, clearCache } from "./logcache.js";
import { attachAmountInput } from "./amount-input.js";

initErrors(config.abi);

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const eth = window.ethereum; // MetaMask gắn object này vào trang
const ONE = 10n ** 18n; // 1 token = 10^18 đơn vị nhỏ nhất

// config.networks: các mạng hỗ trợ (31337, 11155111) – có nút "Chuyển sang ..."
// config.chains:   các mạng đã deploy contract (có địa chỉ FXHub, token)
// Bản build đưa lên mạng chỉ dùng Sepolia; Hardhat Local chỉ hiện khi chạy `npm run dev`.
const LOCAL_CHAIN_ID = 31337;
const SHOW_LOCAL = import.meta.env.DEV;
const NETWORKS = Object.values(config.networks)
  .filter((n) => SHOW_LOCAL || n.chainId !== LOCAL_CHAIN_ID)
  .sort((a, b) => (a.chainId === LOCAL_CHAIN_ID) - (b.chainId === LOCAL_CHAIN_ID)); // Sepolia đứng trước
const networkOf = (chainId) => NETWORKS.find((n) => n.chainId === chainId) ?? null;

const FAUCET_URL = "https://cloud.google.com/application/web3/faucet/ethereum/sepolia";
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
// Link mở trang này bên trong trình duyệt của app MetaMask (dùng trên điện thoại)
const metamaskAppLink = `https://metamask.app.link/dapp/${location.host}${location.pathname}`;

// Trạng thái hiện tại của trang
const state = {
  account: null, // địa chỉ ví đang kết nối
  chain: null, // cấu hình mạng (lấy từ contracts.json)
  provider: null,
  hub: null, // contract FXHub
  tokens: [], // [{ symbol, address, contract }]
  usd: null, // token vUSD (đồng trục)
  isOwner: false,
  tab: "wallet",
  pools: {}, // số dư các quỹ, dùng cho tab Quản trị
};
const tokenBySymbol = (s) => state.tokens.find((t) => t.symbol === s);
const tokenByAddress = (a) => state.tokens.find((t) => t.address.toLowerCase() === a.toLowerCase());

// ───────────────────────── Thông báo ─────────────────────────

function showMessage(text, type = "info") {
  const el = $("message");
  const t = String(text ?? "").trim();
  el.className = `status ${type}`;
  el.innerHTML = t ? statusBody(type, esc(t)) : "";
  el.hidden = !t; // thông báo trống thì ẩn hẳn
}

// html: chỉ truyền nội dung do chính trang tạo ra; lỗi phải đi qua esc()
function setStatus(id, html, type = "info") {
  const el = $(id);
  el.className = `status ${type}`;
  el.innerHTML = html ? statusBody(type, html) : "";
  el.hidden = !html;
}

// Mã giao dịch; trên Sepolia thì thành link Etherscan
function txLink(hash, short = false) {
  const text = short ? shortAddr(hash) : hash;
  const ex = state.chain?.explorer;
  return ex
    ? `<a href="${ex}/tx/${hash}" target="_blank" rel="noopener"><code>${text}</code>${icon("external-link")}</a>`
    : `<code>${text}</code>`;
}

// Chạy hàm async, lỗi thì hiện lên thanh thông báo
const safe = (fn) => (...args) => fn(...args).catch((e) => showMessage(friendlyError(e), "error"));

// ───────────────────────── Chờ xác nhận giao dịch ─────────────────────────

const SLOW_AFTER_SEC = 45; // sau 45 giây: báo mạng chậm
const GIVE_UP_AFTER_SEC = 180; // sau 3 phút: dừng xoay, cho bấm "Kiểm tra lại"
const pendingChecks = new Set(); // các giao dịch đang chờ – kiểm tra lại khi người dùng quay lại tab

// Nơi hiện trạng thái: ô trạng thái của form, hoặc thanh thông báo chung
const statusIn = (id) => (html, type) => setStatus(id, html, type);
const messageBox = (html, type) => {
  const el = $("message");
  el.className = `status ${type}`;
  el.innerHTML = statusBody(type, html);
  el.hidden = false;
};

// Thay cho `await tx.wait()`: vẫn trả về đúng biên nhận (receipt) như tx.wait(),
// chỉ thêm phần hiển thị: số giây đã chờ, cảnh báo mạng chậm, link Etherscan, nút "Kiểm tra lại".
function waitForConfirmation(tx, render, label = "") {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const net = state.chain?.name ?? "blockchain";
    const ex = state.chain?.explorer;
    const track = ex
      ? `<a href="${ex}/tx/${tx.hash}" target="_blank" rel="noopener">mở Etherscan${icon("external-link")}</a>`
      : `xem mã giao dịch <code>${shortAddr(tx.hash)}</code>`;
    let done = false;
    let timer = null;

    const finish = (settle, value) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      pendingChecks.delete(check);
      settle(value);
    };
    // Đã có biên nhận → lấy kết quả qua tx.wait() (trả ngay, báo lỗi nếu giao dịch bị huỷ)
    const settleFromChain = () => tx.wait().then((r) => finish(resolve, r), (e) => finish(reject, e));

    // Hỏi lại blockchain: giao dịch đã vào block chưa?
    async function check() {
      if (done) return true;
      const receipt = await state.provider.getTransactionReceipt(tx.hash);
      if (receipt) settleFromChain();
      return Boolean(receipt);
    }

    function showGiveUp(note = "") {
      render(
        `${label}<b>Chưa nhận được xác nhận</b> sau 3 phút. Giao dịch đã được gửi và có thể vẫn đang chờ trên mạng ${net} – ${track}.` +
          `${note ? `<br><span class="small-text">${note}</span>` : ""}` +
          `<div class="status-actions"><button type="button" class="btn small outline" data-recheck="${tx.hash}">${icon("refresh-cw")}Kiểm tra lại</button></div>`,
        "warn",
      );
      document.querySelector(`[data-recheck="${tx.hash}"]`)?.addEventListener("click", async (e) => {
        e.currentTarget.disabled = true;
        try {
          if (!(await check())) showGiveUp(`Đã kiểm tra lúc ${new Date().toLocaleTimeString("vi-VN")}: vẫn chưa có kết quả.`);
        } catch {
          showGiveUp("Không kiểm tra được (mất kết nối mạng?). Hãy thử lại.");
        }
      });
    }

    function tick() {
      if (done) return;
      const secs = Math.floor((Date.now() - started) / 1000);
      if (secs >= GIVE_UP_AFTER_SEC) {
        clearInterval(timer);
        showGiveUp();
        return;
      }
      let html = `${label}Đang xác nhận trên blockchain… <b>${secs} giây</b> · ${txLink(tx.hash, true)}`;
      if (secs >= SLOW_AFTER_SEC) {
        html += `<br>Mạng ${net} đang chậm. Giao dịch đã được gửi, bạn có thể ${track} để theo dõi hoặc chờ thêm.`;
      }
      render(html, "info");
    }

    pendingChecks.add(check);
    tick();
    timer = setInterval(tick, 1000);
    settleFromChain();
  });
}

// Người dùng quay lại tab → hỏi lại ngay trạng thái các giao dịch đang chờ
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  for (const check of pendingChecks) check().catch(() => {});
});

// ───────────────────────── a. Kết nối ví & chuyển mạng ─────────────────────────

async function connect() {
  if (!eth) {
    showMessage(
      isMobile
        ? 'Trình duyệt này không có MetaMask. Hãy bấm "Mở trong app MetaMask" trong phần Hướng dẫn.'
        : "Không tìm thấy MetaMask. Hãy cài tiện ích MetaMask cho trình duyệt (xem phần Hướng dẫn) rồi tải lại trang.",
      "error",
    );
    $("guide").open = true;
    return;
  }
  await eth.request({ method: "eth_requestAccounts" }); // mở MetaMask xin quyền kết nối
  await init();
}

async function switchNetwork(chainId) {
  const c = config.networks[chainId];
  const chainIdHex = "0x" + Number(chainId).toString(16);
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (e) {
    // 4902 = MetaMask chưa có mạng này → thêm mạng mới
    const code = e?.code ?? e?.data?.originalError?.code;
    if (code !== 4902) throw e;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: c.name,
          rpcUrls: [c.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          ...(c.explorer ? { blockExplorerUrls: [c.explorer] } : {}),
        },
      ],
    });
  }
  // Đổi mạng xong MetaMask phát sự kiện chainChanged → trang tự tải lại
}

// Ẩn các tab và quên kết nối cũ, để không hàm nào đọc số dư/lịch sử khi chưa sẵn sàng
function hideApp() {
  $("tabs").hidden = true;
  for (const p of ["wallet", "send", "history", "admin"]) $(`panel-${p}`).hidden = true;
  state.hub = null;
  state.tokens = [];
  state.isOwner = false;
  $("guide").open = true; // chưa dùng được thì mở sẵn hướng dẫn
}

// Nút "Chuyển sang ..." cho mọi mạng hỗ trợ, trừ mạng đang dùng
function renderSwitchButtons(currentChainId, wrongNetwork) {
  $("network-switch").innerHTML = NETWORKS.filter((n) => n.chainId !== currentChainId)
    .map(
      (n) =>
        `<button class="btn small ${wrongNetwork ? "primary" : "outline"}" data-switch="${n.chainId}">${icon("arrow-right")}Chuyển sang ${esc(n.name)}</button>`,
    )
    .join("");
}

function showDisconnected() {
  hideApp();
  showMessage("");
  $("intro").hidden = false;
  $("btn-connect").hidden = false;
  $("network-switch").innerHTML = "";
  $("account-badge").hidden = true;
  $("network-badge").hidden = true;
}

function showWrongNetwork(chainId) {
  hideApp();
  const badge = $("network-badge");
  badge.hidden = false;
  badge.className = "chip chip-network bad";
  badge.textContent = `Sai mạng (chain ${chainId})`;
  renderSwitchButtons(chainId, true);
  const names = NETWORKS.map((n) => n.name).join(" hoặc ");
  showMessage(`MetaMask đang ở mạng không được hỗ trợ. Hãy bấm nút chuyển sang ${names}.`, "error");
}

// Đọc lại toàn bộ trạng thái: khi tải trang, khi kết nối, khi đổi tài khoản
async function init() {
  if (!eth) return;
  const accounts = await eth.request({ method: "eth_accounts" });
  if (accounts.length === 0) return showDisconnected();

  state.account = getAddress(accounts[0]);
  state.provider = new BrowserProvider(eth);
  state.provider.pollingInterval = 1000; // hỏi trạng thái giao dịch mỗi giây
  const chainId = Number((await state.provider.getNetwork()).chainId);

  $("intro").hidden = true;
  $("btn-connect").hidden = true;
  $("account-badge").hidden = false;
  $("account-addr").textContent = shortAddr(state.account);
  $("account-badge").title = state.account;

  const network = networkOf(chainId);
  if (!network) return showWrongNetwork(chainId);

  renderSwitchButtons(chainId, false);
  const badge = $("network-badge");
  badge.hidden = false;
  badge.className = "chip chip-network";
  badge.textContent = network.name;

  // Mạng được hỗ trợ nhưng chưa deploy contract lên đó
  state.chain = config.chains[chainId] ?? null;
  if (!state.chain) {
    hideApp();
    showMessage(
      `Chưa có contract trên mạng ${network.name}. Hãy deploy rồi chạy export-frontend (xem README), ` +
        `hoặc chuyển sang mạng khác.`,
      "error",
    );
    return;
  }

  // Node local vừa khởi động lại thì contract cũ không còn
  if ((await state.provider.getCode(state.chain.hub)) === "0x") {
    hideApp();
    showMessage(
      "Không tìm thấy contract FXHub trên mạng này. Nếu vừa khởi động lại hardhat node, " +
        "hãy chạy lại deploy → seed → export-frontend (xem README) rồi tải lại trang.",
      "error",
    );
    return;
  }

  const signer = await state.provider.getSigner();
  state.hub = new Contract(state.chain.hub, config.abi.FXHub, signer);
  state.tokens = state.chain.tokens.map((t) => ({
    ...t,
    contract: new Contract(t.address, config.abi.StableToken, signer),
  }));
  state.usd = tokenBySymbol("vUSD");
  state.isOwner = getAddress(await state.hub.owner()) === state.account;

  showMessage("");
  $("guide").open = false; // đã sẵn sàng thì thu gọn hướng dẫn
  $("tabs").hidden = false;
  $("tab-admin").hidden = !state.isOwner;
  if (!state.isOwner && state.tab === "admin") state.tab = "wallet";
  fillSelects();
  showTab(state.tab);
}

// ───────────────────────── Tab ─────────────────────────

const loaders = {
  wallet: () => loadBalances(),
  send: () => updateQuote(),
  history: () => loadHistory(),
  admin: () => loadAdmin(),
};

// Chỉ chạy khi đã kết nối ví đúng mạng (có contract FXHub); chưa thì bỏ qua
const whenConnected = (fn) => (...args) => (state.hub ? fn(...args) : Promise.resolve());

function showTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll(".tab")) btn.classList.toggle("active", btn.dataset.tab === tab);
  if (!state.hub) return; // chưa kết nối: không đọc số dư/lịch sử
  for (const p of Object.keys(loaders)) $(`panel-${p}`).hidden = p !== tab;
  safe(loaders[tab])();
}

// Huy hiệu tròn cạnh ô chọn đồng gửi / đồng nhận
function updateCoinBadges() {
  $("send-from-coin").innerHTML = coinBadge($("send-from").value, "sm");
  $("send-to-coin").innerHTML = coinBadge($("send-to").value, "sm");
}

function fillSelects() {
  const options = (list) => list.map((t) => `<option value="${t.symbol}">${t.symbol}</option>`).join("");
  if (!$("send-from").options.length) {
    $("send-from").innerHTML = options(state.tokens);
    $("send-to").innerHTML = options(state.tokens);
    $("send-from").value = "vJPY";
    $("send-to").value = "vVND";
  }
  updateCoinBadges();
  if (!$("liq-token").options.length) {
    $("liq-token").innerHTML = options(state.tokens.filter((t) => t !== state.usd));
    updateLiqLabel();
  }
}

// ───────────────────────── b + c. Số dư, thêm vào MetaMask, faucet ─────────────────────────

// Giờ hiện tại theo blockchain (node local có thể đã bị "tua" thời gian)
async function chainNow() {
  const block = await state.provider.getBlock("latest");
  return Math.max(block.timestamp, Math.floor(Date.now() / 1000));
}

async function loadBalances() {
  const [ethBalance, now, rows] = await Promise.all([
    state.provider.getBalance(state.account),
    chainNow(),
    Promise.all(
      state.tokens.map(async (t) => {
        const [balance, last, cooldown, amount] = await Promise.all([
          t.contract.balanceOf(state.account),
          t.contract.lastFaucetAt(state.account),
          t.contract.FAUCET_COOLDOWN(),
          t.contract.faucetAmount(),
        ]);
        return { t, balance, last, cooldown, amount };
      }),
    ),
  ]);

  $("eth-balance").textContent = `ETH để trả phí gas: ${fmtAmount(ethBalance, 4)} ETH`;
  $("balances").innerHTML = rows
    .map(({ t, balance, last, cooldown, amount }) => {
      const nextAt = last === 0n ? 0 : Number(last + cooldown); // 0 = chưa xin lần nào
      const waiting = nextAt > now;
      return `
        <div class="coin-row">
          <div class="coin-info">
            ${coinBadge(t.symbol)}
            <div class="coin-text">
              <span class="amount">${fmtAmount(balance)}<small>${t.symbol}</small></span>
              <span class="name">${coinName(t.symbol)}</span>
              ${waiting ? `<span class="wait">${icon("clock")}Xin lại lúc ${fmtTime(nextAt)}</span>` : ""}
            </div>
          </div>
          <div class="coin-actions">
            ${
              waiting
                ? `<button class="btn small" data-faucet="${t.symbol}" disabled title="Đã nhận hôm nay">${icon("lock")}Đã nhận · chờ 24 giờ</button>`
                : `<button class="btn small primary" data-faucet="${t.symbol}">${icon("gift")}Nhận coin thử nghiệm (+${fmtAmount(amount, 0)})</button>`
            }
            <button class="btn small outline" data-watch="${t.symbol}">${icon("wallet")}Thêm vào MetaMask</button>
          </div>
        </div>`;
    })
    .join("");
}

async function claimFaucet(symbol, btn) {
  const t = tokenBySymbol(symbol);
  btn.disabled = true;
  try {
    showMessage(`Chờ bạn xác nhận nhận ${symbol} trong MetaMask…`);
    const tx = await t.contract.faucet();
    await waitForConfirmation(tx, messageBox, `Nhận ${symbol} · `);
    showMessage(`Đã nhận ${symbol} thử nghiệm.`, "success");
  } catch (e) {
    showMessage(friendlyError(e), "error");
  }
  await loadBalances();
}

// Nhờ MetaMask hiển thị token này trong danh sách tài sản
async function watchAsset(symbol) {
  const t = tokenBySymbol(symbol);
  const added = await eth.request({
    method: "wallet_watchAsset",
    params: { type: "ERC20", options: { address: t.address, symbol: t.symbol, decimals: 18 } },
  });
  if (added) showMessage(`Đã thêm ${symbol} vào MetaMask.`, "success");
}

// ───────────────────────── d. Form chuyển tiền & báo giá ─────────────────────────

// Đọc ô trượt giá (%) → phần vạn (bps); null nếu không hợp lệ (cho phép 0–50%)
function slippageBps() {
  const pct = parseAmount($("send-slippage").value);
  if (pct === null) return null;
  const bps = (pct * 100n) / ONE;
  return bps <= 5000n ? bps : null;
}

async function poolOf(t) {
  const p = await state.hub.pools(t.address);
  if (p.reserveToken === 0n || p.reserveUsd === 0n) throw new UserError(`Quỹ ${t.symbol} chưa có thanh khoản.`);
  return { token: p.reserveToken, usd: p.reserveUsd };
}

// Số nhận được nếu đổi đúng tỷ giá quỹ (chưa tính phí, chưa trượt giá)
async function listedOut(from, to, amount) {
  if (from === state.usd) {
    const p = await poolOf(to);
    return (amount * p.token) / p.usd;
  }
  if (to === state.usd) {
    const p = await poolOf(from);
    return (amount * p.usd) / p.token;
  }
  const [a, b] = await Promise.all([poolOf(from), poolOf(to)]);
  return (amount * a.usd * b.token) / (a.token * b.usd);
}

function showQuoteError(text) {
  const box = $("quote");
  box.className = "quote error";
  box.innerHTML = `${icon("circle-alert")}<span>${esc(text)}</span>`;
  box.hidden = false;
  $("send-out").textContent = "—";
}

const WARN_SHORTFALL_BPS = 500n; // hụt (phí + trượt giá) trên 5% → cảnh báo màu cam
const TOO_BIG_SHORTFALL_BPS = 5000n; // hụt từ 50% → coi là lệnh quá lớn so với quỹ, khoá nút Gửi

// Dòng lý do / cảnh báo ngay dưới ô "Bạn gửi"; type: "error" (đỏ) | "warn" (cam) | "" (ẩn)
function setAmountMsg(text = "", type = "") {
  const el = $("send-amount-msg");
  const box = el.closest(".amount-box");
  box.classList.toggle("has-error", type === "error");
  box.classList.toggle("has-warn", type === "warn");
  el.hidden = !text;
  el.className = `amount-msg ${type}`;
  el.innerHTML = text ? `${icon(type === "warn" ? "triangle-alert" : "circle-alert")}<span>${esc(text)}</span>` : "";
}

// Khoá/mở nút Gửi theo kết quả báo giá (đang gửi dở thì luôn khoá)
let sending = false;
const lockSend = (locked) => ($("btn-send").disabled = sending || locked);

let quoteSeq = 0; // chỉ hiện kết quả của lần báo giá mới nhất
let quoteTimer = null;
function scheduleQuote() {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(safe(updateQuote), 300); // đợi người dùng gõ xong 0,3 giây
}

async function updateQuote() {
  const seq = ++quoteSeq;
  const box = $("quote");
  const from = tokenBySymbol($("send-from").value);
  const to = tokenBySymbol($("send-to").value);
  const amountText = $("send-amount").value.trim();
  const balancePromise = from.contract.balanceOf(state.account);

  // Số dư đồng gửi, hiện cạnh ô số tiền
  balancePromise.then((b) => {
    if (seq === quoteSeq) $("send-balance").textContent = `Số dư: ${fmtAmount(b)} ${from.symbol}`;
  });

  updateCoinBadges();
  setAmountMsg();
  lockSend(false);
  if (!amountText) {
    box.hidden = true;
    $("send-out").textContent = "0"; // chưa gõ gì
    return;
  }
  if (from === to) return showQuoteError("Đồng gửi và đồng nhận phải khác nhau.");
  const amount = parseAmount(amountText);
  const notQuotable = (text, lock = true) => {
    box.hidden = true;
    $("send-out").textContent = "—";
    setAmountMsg(text, "error");
    lockSend(lock);
  };
  if (amount === null) return notQuotable("Số tiền không hợp lệ. Gõ kiểu 100.000 hoặc 1,5.");
  if (amount === 0n) return notQuotable("Số tiền phải lớn hơn 0.");

  try {
    const [out, listed, balance] = await Promise.all([
      state.hub.quote(from.address, to.address, amount),
      listedOut(from, to, amount),
      balancePromise,
    ]);
    if (seq !== quoteSeq) return; // người dùng đã gõ tiếp, bỏ kết quả cũ

    const shortfall = listed > 0n ? ((listed - out) * 10000n) / listed : 0n;
    // x*y=k không báo lỗi khi lệnh lớn – chỉ là nhận càng hụt; hụt quá nửa (hoặc nhận 0) thì coi là quá lớn
    if (out === 0n || shortfall >= TOO_BIG_SHORTFALL_BPS) {
      return notQuotable("Số tiền quá lớn so với thanh khoản của quỹ, hãy giảm bớt.");
    }

    const bps = slippageBps();
    const minOut = bps === null ? null : (out * (10000n - bps)) / 10000n;
    // Lộ trình dạng vJPY → vUSD → vVND
    const hops = from === state.usd || to === state.usd ? [from.symbol, to.symbol] : [from.symbol, "vUSD", to.symbol];
    const route = hops.map((sym) => `<span class="step">${coinBadge(sym, "sm")}${sym}</span>`).join(icon("arrow-right"));

    box.className = "quote";
    box.hidden = false;
    $("send-out").textContent = fmtAmount(out);
    box.innerHTML = `
      <dl>
        <dt>Tỷ giá thực tế</dt><dd>1 ${from.symbol} = ${fmtAmount((out * ONE) / amount, 4)} ${to.symbol}</dd>
        <dt>Tỷ giá quỹ</dt><dd>1 ${from.symbol} = ${fmtAmount((listed * ONE) / amount, 4)} ${to.symbol}</dd>
        <dt>Hụt so với tỷ giá quỹ</dt><dd>${fmtPct(shortfall)} <span class="hint">(phí + trượt giá)</span></dd>
        <dt>Nhận tối thiểu</dt><dd>${minOut === null ? "Trượt giá phải từ 0 đến 50%" : `${fmtAmount(minOut)} ${to.symbol}`}</dd>
        <dt>Lộ trình (${hops.length - 1} chặng)</dt><dd class="route">${route}</dd>
      </dl>`;

    // Vẫn hiện báo giá để tham khảo, nhưng vượt số dư thì báo đỏ và khoá nút Gửi
    if (amount > balance) {
      setAmountMsg(`Vượt số dư (bạn có ${fmtAmount(balance)} ${from.symbol})`, "error");
      lockSend(true);
    } else if (shortfall > WARN_SHORTFALL_BPS) {
      setAmountMsg(`Lệnh lớn, người nhận bị hụt ${fmtPct(shortfall)} so với tỷ giá quỹ (phí + trượt giá).`, "warn");
    }
  } catch (e) {
    if (seq !== quoteSeq) return;
    // Lỗi đã biết (quỹ trống, thiếu thanh khoản…) → khoá; lỗi mạng → không khoá, bấm Gửi sẽ kiểm tra lại
    notQuotable(friendlyError(e), e instanceof UserError || /thanh khoản/i.test(friendlyError(e)));
  }
}

// ───────────────────────── e. Gửi: approve (nếu cần) rồi sendCrossBorder ─────────────────────────

async function send(ev) {
  ev.preventDefault();
  const btn = $("btn-send");
  const from = tokenBySymbol($("send-from").value);
  const to = tokenBySymbol($("send-to").value);
  const amount = parseAmount($("send-amount").value);
  const recipientText = $("send-recipient").value.trim();
  const bps = slippageBps();
  const hubAddr = state.chain.hub;

  sending = true; // đang gửi: báo giá chạy lại cũng không mở khoá nút
  btn.disabled = true;
  try {
    // Kiểm tra trước để báo lỗi dễ hiểu, khỏi tốn công ký
    if (from === to) throw new UserError("Đồng gửi và đồng nhận phải khác nhau.");
    if (!amount) throw new UserError("Hãy nhập số tiền hợp lệ, lớn hơn 0.");
    if (!isAddress(recipientText)) throw new UserError("Địa chỉ người nhận không hợp lệ (dạng 0x… gồm 42 ký tự).");
    if (bps === null) throw new UserError("Trượt giá chấp nhận phải từ 0 đến 50%.");
    const recipient = getAddress(recipientText);
    if (await state.hub.paused()) throw new UserError("Hệ thống đang tạm dừng để bảo trì. Vui lòng thử lại sau.");
    const balance = await from.contract.balanceOf(state.account);
    if (balance < amount) {
      throw new UserError(`Không đủ số dư: ví có ${fmtAmount(balance)} ${from.symbol}, cần ${fmtAmount(amount)} ${from.symbol}.`);
    }

    // Bước 1: approve = cho phép FXHub rút đúng số tiền này từ ví (chỉ khi hạn mức hiện tại chưa đủ)
    const allowance = await from.contract.allowance(state.account, hubAddr);
    const needApprove = allowance < amount;
    if (needApprove) {
      setStatus("send-status", `Bước 1/2 · Chờ bạn ký <b>cấp hạn mức (approve)</b> ${fmtAmount(amount)} ${from.symbol} trong MetaMask…`);
      const tx = await from.contract.approve(hubAddr, amount);
      await waitForConfirmation(tx, statusIn("send-status"), "Bước 1/2 · approve · ");
    }

    // Bước 2: lấy báo giá mới nhất, tính minOut, gửi
    const step = needApprove ? "Bước 2/2 · " : "";
    const quoted = await state.hub.quote(from.address, to.address, amount);
    const minOut = (quoted * (10000n - bps)) / 10000n;
    setStatus("send-status", `${step}Chờ bạn ký <b>giao dịch gửi tiền</b> trong MetaMask…`);
    const tx = await state.hub.sendCrossBorder(from.address, to.address, amount, minOut, recipient);
    const receipt = await waitForConfirmation(tx, statusIn("send-status"), step);

    // Số nhận thực tế lấy từ event Remittance trong giao dịch
    const event = receipt.logs
      .map((log) => {
        try {
          return state.hub.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((e) => e?.name === "Remittance");
    const received = event ? event.args.amountOut : quoted;

    setStatus(
      "send-status",
      `<b>Thành công!</b> Đã gửi ${fmtAmount(amount)} ${from.symbol}; ${shortAddr(recipient)} nhận ` +
        `<b>${fmtAmount(received)} ${to.symbol}</b>.<br>Mã giao dịch: ${txLink(receipt.hash)}`,
      "success",
    );
    $("send-amount").value = "";
    $("quote").hidden = true;
  } catch (e) {
    setStatus("send-status", esc(friendlyError(e)), "error");
  } finally {
    sending = false;
    btn.disabled = false; // updateQuote bên dưới khoá lại nếu cần
    updateQuote().catch(() => {});
  }
}

// ───────────────────────── f. Lịch sử (đọc event Remittance) ─────────────────────────

const fmtSec = (ms) => (ms / 1000).toLocaleString("vi-VN", { maximumFractionDigits: 1 }) + " giây";

// Quét event có bộ nhớ đệm (xem logcache.js), cập nhật dòng tiến trình và đo thời gian tải.
// Thời gian được ghi ra Console (F12) để so sánh trước/sau.
async function runScan({ label, progressId, key, query, render, isCancelled }) {
  const progress = $(progressId);
  const setProgress = (html, cls = "") => {
    progress.className = `scan-progress ${cls}`;
    progress.innerHTML = html;
    progress.hidden = false;
  };
  try {
    const stats = await scanWithCache({
      provider: state.provider,
      chainId: state.chain.chainId,
      key,
      firstBlock: state.chain.deployBlock,
      query,
      isCancelled,
      onUpdate: (records, info) => {
        if (isCancelled()) return;
        render(records, info);
        if (info.phase === "cache") {
          setProgress(`${icon("loader", "spin")}Đang hiện ${records.length} mục đã lưu, kiểm tra giao dịch mới…`);
        } else if (info.phase === "scan") {
          const [from, to] = info.scanning;
          setProgress(
            `${icon("loader", "spin")}Đang quét block ${to.toLocaleString("vi-VN")} → ${from.toLocaleString("vi-VN")} · ${Math.round(info.progress * 100)}%`,
          );
        }
      },
    });
    if (!stats || isCancelled()) return; // đã có lượt tải mới thay thế
    const s = stats;
    setProgress(
      `${icon("circle-check")}Cập nhật lúc ${new Date().toLocaleTimeString("vi-VN")} · tải xong sau ${fmtSec(s.ms)}` +
        ` · ${s.newBlocks.toLocaleString("vi-VN")} block mới quét (${s.chunks} đoạn)` +
        (s.fromCache ? ` · ${s.fromCache} mục lấy từ bộ nhớ đệm` : ""),
    );
    console.info(
      `[${label}] hiện dữ liệu đầu tiên sau ${s.firstShownMs} ms, xong sau ${s.ms} ms; ` +
        `quét ${s.newBlocks} block trong ${s.chunks} đoạn (chia nhỏ lại ${s.retries} lần); ${s.fromCache} mục từ bộ nhớ đệm`,
    );
  } catch (e) {
    if (!isCancelled()) setProgress(`${icon("circle-alert")}Không tải được: ${esc(friendlyError(e))}`, "error");
  }
}

let historySeq = 0; // bấm Làm mới khi đang tải thì bỏ lượt tải cũ

// Bộ nhớ đệm riêng cho từng ví (mỗi ví chỉ lưu giao dịch của mình)
const historyCacheKey = () => cacheKey(state.chain.chainId, state.chain.hub, `remit:${state.account.toLowerCase()}`);

function renderHistory(records, info) {
  const box = $("history");
  if (records.length === 0) {
    box.innerHTML = `<div class="empty">${info.phase === "done" ? "Chưa có giao dịch nào liên quan tới ví này." : "Đang tải…"}</div>`;
    return;
  }
  const sym = (addr) => tokenByAddress(addr)?.symbol ?? shortAddr(addr);
  box.innerHTML = records
    .map((r) => {
      const { sender, recipient, fromToken, toToken, amountIn, amountOut } = r.args;
      const isSender = getAddress(sender) === state.account;
      const isRecipient = getAddress(recipient) === state.account;
      const kind = isSender && isRecipient ? "self" : isSender ? "out" : "in";
      const label = { self: "Tự gửi", out: "Gửi đi", in: "Nhận về" }[kind];
      const kindIcon = { self: "arrow-down-up", out: "arrow-up-right", in: "arrow-down-left" }[kind];
      const other = isSender ? `Tới ${shortAddr(recipient)}` : `Từ ${shortAddr(sender)}`;
      return `
        <div class="tx-card ${kind}">
          <span class="tx-icon">${icon(kindIcon)}</span>
          <div class="tx-body">
            <div class="tx-top">
              <span class="tag ${kind}">${label}</span>
              <span class="muted small-text">${fmtTime(r.time)}</span>
            </div>
            <div class="tx-amounts">
              <span class="amt">${coinBadge(sym(fromToken), "sm")}${fmtAmount(BigInt(amountIn))} ${sym(fromToken)}</span>
              ${icon("arrow-right")}
              <span class="amt">${coinBadge(sym(toToken), "sm")}${fmtAmount(BigInt(amountOut))} ${sym(toToken)}</span>
            </div>
            <div class="tx-meta"><span>${other}</span><span>Mã GD ${txLink(r.tx, true)}</span></div>
          </div>
        </div>`;
    })
    .join("");
}

async function loadHistory() {
  const seq = ++historySeq;
  const hub = state.hub;
  const me = state.account;
  await runScan({
    label: "Lịch sử chuyển tiền",
    progressId: "history-progress",
    key: historyCacheKey(),
    isCancelled: () => seq !== historySeq,
    render: renderHistory,
    // sender, recipient là "indexed" → lọc ngay trên node (topic filter): 2 truy vấn, ví là người gửi / người nhận.
    // Giao dịch tự gửi cho mình xuất hiện ở cả 2 → bộ nhớ đệm tự loại trùng theo mã giao dịch.
    query: async (from, to) =>
      (
        await Promise.all([
          hub.queryFilter(hub.filters.Remittance(me), from, to),
          hub.queryFilter(hub.filters.Remittance(null, me), from, to),
        ])
      ).flat(),
  });
}

// "Quét lại từ đầu": xoá bộ nhớ đệm rồi tải lại
function resetHistory() {
  clearCache(historyCacheKey());
  $("history").innerHTML = "";
  return loadHistory();
}
function resetLiqHistory() {
  clearCache(liqCacheKey());
  $("liq-history").innerHTML = "";
  return loadLiqHistory();
}

// ───────────────────────── g. Quản trị (chỉ owner) ─────────────────────────

// Tỷ giá quỹ = số token đổi được cho 1 vUSD (BigInt, 18 số lẻ); quỹ thiếu 1 bên → null
const poolRate = (token, usd) => (token > 0n && usd > 0n ? (token * ONE) / usd : null);
const fmtRate = (rate, sym) => (rate === null ? "chưa có" : `1 vUSD = ${fmtAmount(rate, 4)} ${sym}`);
const fmtReserves = (p, sym) => `${fmtAmount(p.token)} ${sym} · ${fmtAmount(p.usd)} vUSD`;

// Đọc số dư 1 quỹ; blockTag: đọc tại 1 block cụ thể (mặc định: mới nhất)
async function readPool(t, blockTag) {
  const p = await state.hub.pools(t.address, blockTag === undefined ? {} : { blockTag });
  return { t, token: p.reserveToken, usd: p.reserveUsd };
}

// Mở tab Quản trị / bấm Làm mới: đọc trạng thái quỹ + lịch sử thanh khoản
async function loadAdmin() {
  await Promise.all([loadAdminState(), loadLiqHistory()]);
}

// Trạng thái hệ thống (pause) + số dư các quỹ
async function loadAdminState() {
  const paused = await state.hub.paused();
  $("pause-state").textContent = paused ? "Đang tạm dừng" : "Đang hoạt động";
  $("pause-state").className = `pill ${paused ? "paused" : "running"}`;
  $("btn-pause").innerHTML = paused ? `${icon("play")}Mở lại (unpause)` : `${icon("pause")}Tạm dừng (pause)`;
  $("btn-pause").classList.toggle("on", paused);

  const locals = state.tokens.filter((t) => t !== state.usd);
  const pools = await Promise.all(locals.map((t) => readPool(t)));
  state.pools = Object.fromEntries(pools.map((p) => [p.t.symbol, p]));

  $("pools").innerHTML = pools
    .map(
      (p) => `
        <div class="pool-card">
          <div class="pool-head">${coinBadge(p.t.symbol, "sm")}${p.t.symbol} / vUSD</div>
          <div class="pool-rate">${fmtRate(poolRate(p.token, p.usd), p.t.symbol)}</div>
          <div class="pool-reserves">${fmtReserves(p, p.t.symbol)}</div>
        </div>`,
    )
    .join("");
  updateLiqForm(); // số dư quỹ mới → tính lại gợi ý và phần xem trước
}

async function togglePause() {
  const btn = $("btn-pause");
  btn.disabled = true;
  try {
    const paused = await state.hub.paused();
    setStatus("admin-status", "Chờ bạn ký trong MetaMask…");
    const tx = paused ? await state.hub.unpause() : await state.hub.pause();
    await waitForConfirmation(tx, statusIn("admin-status"));
    setStatus(
      "admin-status",
      paused ? "Đã mở lại hệ thống." : "Đã tạm dừng hệ thống. Mọi lệnh gửi tiền sẽ bị chặn cho tới khi mở lại.",
      "success",
    );
  } catch (e) {
    setStatus("admin-status", esc(friendlyError(e)), "error");
  } finally {
    btn.disabled = false;
    await loadAdminState();
  }
}

function updateLiqLabel() {
  $("liq-token-label").textContent = `Số ${$("liq-token").value}`;
}

// ── Tự điền 2 chiều theo tỷ giá quỹ ──
// liqManual[ô] = true khi người dùng TỰ GÕ số vào ô đó → không bao giờ ghi đè ô này.
// Ô còn lại (trống hoặc đang là số tự điền) sẽ được điền theo tỷ giá quỹ.
const LIQ_INPUT = { token: "liq-amount-token", usd: "liq-amount-usd" };
const liqManual = { token: false, usd: false };
let liqLastTyped = "token"; // ô người dùng gõ gần nhất – làm gốc cho nút "Điền theo tỷ giá"
const otherSide = (side) => (side === "token" ? "usd" : "token");
const RATE_WARN_PPM = 50_000n; // ngưỡng cảnh báo: tỷ giá đổi quá ±5% (50.000 phần triệu)

// Quỹ đang chọn đã có tỷ giá chưa (cần cả 2 bên > 0)
const selectedPool = () => state.pools[$("liq-token").value];
const poolHasRate = (p) => Boolean(p && p.token > 0n && p.usd > 0n);

// Lấy số ở ô `side`, tính số ô kia theo tỷ giá quỹ và đánh dấu ô kia là "tự điền"
function fillFrom(side) {
  const p = selectedPool();
  if (!poolHasRate(p)) return false;
  const target = $(LIQ_INPUT[otherSide(side)]);
  const amount = parseAmount($(LIQ_INPUT[side]).value);
  if (amount === null) target.value = ""; // ô gốc trống / sai → xoá số tự điền cũ
  // Số tự điền: có dấu chấm hàng nghìn, tối đa 2 chữ số lẻ
  else target.value = fmtFixed(side === "token" ? (amount * p.usd) / p.token : (amount * p.token) / p.usd, 2);
  liqManual[otherSide(side)] = false;
  return true;
}

// Người dùng gõ vào 1 ô
function onLiqInput(side) {
  liqManual[side] = $(LIQ_INPUT[side]).value.trim() !== "";
  if (liqManual[side]) liqLastTyped = side;
  if (!liqManual[otherSide(side)]) fillFrom(side); // ô kia chưa tự gõ → điền theo tỷ giá
  updateLiqForm();
}

// Nút "Điền theo tỷ giá": giữ ô gõ gần nhất, tính lại ô kia (ô kia quay về "tự điền")
function refillLiq() {
  let base = liqLastTyped;
  if (!$(LIQ_INPUT[base]).value.trim()) base = otherSide(base);
  if (!$(LIQ_INPUT[base]).value.trim()) return;
  fillFrom(base);
  updateLiqForm();
}

// Nút "Xoá": xoá cả 2 ô, quay về trạng thái tự điền
function clearLiq() {
  for (const side of ["token", "usd"]) {
    $(LIQ_INPUT[side]).value = "";
    liqManual[side] = false;
  }
  updateLiqForm();
}

// Đổi quỹ: tính lại ô tự điền theo tỷ giá quỹ mới (nếu chỉ 1 ô là nhập tay)
function onLiqTokenChange() {
  updateLiqLabel();
  if (liqManual.token !== liqManual.usd) fillFrom(liqManual.token ? "token" : "usd");
  updateLiqForm();
}

// Cập nhật nhãn "tự điền"/"nhập tay", dòng gợi ý và khung xem trước
function updateLiqForm() {
  for (const side of ["token", "usd"]) {
    const el = $(`liq-${side}-mode`);
    const filled = $(LIQ_INPUT[side]).value.trim() !== "";
    el.textContent = !filled ? "" : liqManual[side] ? "nhập tay" : "tự điền";
    el.className = `field-mode${filled && liqManual[side] ? " manual" : ""}`;
  }
  const p = selectedPool();
  $("liq-hint").textContent =
    p && !poolHasRate(p) ? "Quỹ chưa có tỷ giá nên không tự điền được: tỷ lệ bạn nạp sẽ thành tỷ giá đầu tiên." : "";
  updateLiqPreview();
}

// Phần trăm thay đổi tính theo phần triệu (ppm): 12345n → "+1,2345%"
const fmtPpm = (ppm) =>
  (ppm > 0n ? "+" : "") +
  (Number(ppm) / 10000).toLocaleString("vi-VN", { maximumFractionDigits: 4 }) +
  "%";

// Phân tích lần nạp theo số trong form: tỷ giá trước/sau, % thay đổi, có cần cảnh báo không.
// Dùng chung cho khung xem trước và lúc bấm Nạp. Trả về null nếu chưa nhập gì.
function liqPlan() {
  const p = selectedPool();
  const tokenText = $("liq-amount-token").value.trim();
  const usdText = $("liq-amount-usd").value.trim();
  if (!p || (!tokenText && !usdText)) return null;
  const addToken = parseAmount(tokenText || "0");
  const addUsd = parseAmount(usdText || "0");
  if (addToken === null || addUsd === null) return { invalid: true };

  const after = { token: p.token + addToken, usd: p.usd + addUsd };
  const rateBefore = poolRate(p.token, p.usd);
  const rateAfter = poolRate(after.token, after.usd);
  const ppm = rateBefore !== null && rateAfter !== null ? ((rateAfter - rateBefore) * 1_000_000n) / rateBefore : null;
  const nothing = addToken === 0n && addUsd === 0n;
  // Cần xác nhận khi: tỷ giá đổi quá ±5%, hoặc nạp 1 phía vào quỹ trống (quỹ vẫn chưa có tỷ giá)
  const risky = !nothing && (ppm !== null ? ppm >= RATE_WARN_PPM || ppm <= -RATE_WARN_PPM : rateAfter === null);
  return { p, sym: p.t.symbol, addToken, addUsd, after, rateBefore, rateAfter, ppm, nothing, risky };
}

// Xem trước ngay khi gõ số: tỷ giá quỹ và số dư quỹ SAU khi nạp
function updateLiqPreview() {
  const box = $("liq-preview");
  const plan = liqPlan();
  if (!plan) return void (box.hidden = true);
  box.hidden = false;
  if (plan.invalid) {
    box.className = "quote error";
    box.innerHTML = `${icon("circle-alert")}<span>Số tiền không hợp lệ. Gõ kiểu 100.000 hoặc 1,5.</span>`;
    return;
  }

  const { p, sym, addToken, addUsd, after, rateBefore, rateAfter, ppm, nothing, risky } = plan;
  // Nhận xét: tỷ giá giữ nguyên hay đổi bao nhiêu %
  let verdict;
  if (nothing) verdict = "Chưa nạp gì (cả 2 số đều bằng 0)";
  else if (rateAfter === null) verdict = `<span class="up">Quỹ vẫn chưa có tỷ giá (cần cả 2 đồng)</span>`;
  else if (rateBefore === null) verdict = "Quỹ đang trống: tỷ lệ bạn nạp sẽ thành tỷ giá đầu tiên";
  else if (addToken * p.usd === addUsd * p.token) verdict = `<span class="same">Giữ nguyên (nạp đúng tỷ lệ)</span>`;
  else if (ppm > -100n && ppm < 100n) verdict = `<span class="same">Gần như giữ nguyên (${fmtPpm(ppm)}, do làm tròn)</span>`;
  else if (risky) verdict = `<span class="up">${fmtPpm(ppm)} – lệch mạnh, quá ±5%</span>`;
  else verdict = `<span class="up">${fmtPpm(ppm)} – nạp lệch tỷ lệ</span>`;

  // Nạp 1 phía (1 ô bằng 0): contract cho phép, nhưng tỷ giá chắc chắn đổi
  const oneSide =
    !nothing && (addToken === 0n || addUsd === 0n)
      ? `<dt>Lưu ý</dt><dd>Chỉ nạp ${addToken === 0n ? "vUSD" : sym} (một phía)</dd>`
      : "";

  box.className = `quote${risky ? " warn" : ""}`;
  box.innerHTML = `
    <dl>
      <dt>Tỷ giá quỹ hiện tại</dt><dd>${fmtRate(rateBefore, sym)}</dd>
      <dt>Tỷ giá quỹ sau khi nạp</dt><dd>${fmtRate(rateAfter, sym)}</dd>
      <dt>Thay đổi tỷ giá</dt><dd>${verdict}</dd>
      <dt>Số dư quỹ sau khi nạp</dt><dd>${fmtReserves(after, sym)}</dd>
      ${oneSide}
    </dl>`;
}

// Hộp xác nhận ngay trên trang (<dialog>); trả về true nếu bấm "Vẫn nạp"
function askConfirm(html) {
  const dlg = $("liq-confirm");
  $("liq-confirm-text").innerHTML = html;
  dlg.returnValue = "";
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true }));
}

// Câu hỏi xác nhận cho lần nạp lệch mạnh
function riskText(plan) {
  const { sym, rateBefore, rateAfter, ppm, addToken } = plan;
  if (ppm === null) {
    return `Lần nạp này chỉ nạp <b>${addToken === 0n ? "vUSD" : sym}</b> vào quỹ đang trống, nên quỹ <b>vẫn chưa có tỷ giá</b> và chưa đổi tiền được. Bạn chắc chắn?`;
  }
  return `Lần nạp này làm tỷ giá quỹ đổi từ <b>${fmtRate(rateBefore, sym)}</b> sang <b>${fmtRate(rateAfter, sym)}</b> (<b>${fmtPpm(ppm)}</b>). Bạn chắc chắn?`;
}

// Tiến trình nạp: mỗi bước có trạng thái wait (chờ) / active (đang làm) / done / skip (bỏ qua) / fail
const STEP_ICON = { wait: "circle-dashed", active: "loader", done: "circle-check", skip: "circle-minus", fail: "circle-alert" };
function stepsHtml(steps) {
  const items = steps.map(
    (s, i) => `
      <li class="${s.state}">
        ${icon(STEP_ICON[s.state], s.state === "active" ? "spin" : "")}
        <div><b>Bước ${i + 1}/${steps.length}: ${s.title}</b>${s.detail ? `<span class="step-detail">${s.detail}</span>` : ""}</div>
      </li>`,
  );
  return `<ol class="progress-steps">${items.join("")}</ol>`;
}

// Nạp thanh khoản: approve token (nếu cần) → approve vUSD (nếu cần) → addLiquidity
async function addLiquidity() {
  const btn = $("btn-liq");
  const t = tokenBySymbol($("liq-token").value);
  const hubAddr = state.chain.hub;
  const steps = [`Approve ${t.symbol}`, "Approve vUSD", "Nạp vào quỹ"].map((title) => ({ title, state: "wait", detail: "" }));
  let started = false; // đã bắt đầu các bước chưa (lỗi nhập liệu thì chỉ hiện lỗi)
  const render = (type = "info", head = "", tail = "") => setStatus("admin-status", head + stepsHtml(steps) + tail, type);

  btn.disabled = true;
  try {
    const amountToken = parseAmount($("liq-amount-token").value || "0");
    const amountUsd = parseAmount($("liq-amount-usd").value || "0");
    if (amountToken === null || amountUsd === null) throw new UserError("Số tiền không hợp lệ. Gõ kiểu 100.000 hoặc 1,5.");
    // Contract chỉ từ chối khi CẢ 2 số bằng 0 (ZeroAmount); nạp 1 phía vẫn được, nhưng qua cảnh báo bên dưới
    if (amountToken === 0n && amountUsd === 0n) throw new UserError("Hãy nhập số tiền cần nạp (ít nhất một ô lớn hơn 0).");

    // Đọc lại số dư quỹ mới nhất rồi mới đánh giá; tỷ giá đổi quá ±5% → hỏi xác nhận trên trang
    state.pools[t.symbol] = await readPool(t);
    updateLiqForm();
    const plan = liqPlan();
    if (plan?.risky && !(await askConfirm(riskText(plan)))) {
      setStatus("admin-status", "Đã huỷ – chưa nạp gì. Bạn có thể sửa số rồi bấm Nạp lại.", "warn");
      return;
    }

    const parts = [
      [steps[0], t, amountToken],
      [steps[1], state.usd, amountUsd],
    ];

    // Kiểm tra số dư cả 2 đồng trước, để không approve xong mới báo thiếu tiền
    for (const [, tok, amt] of parts) {
      if (amt === 0n) continue;
      const balance = await tok.contract.balanceOf(state.account);
      if (balance < amt) throw new UserError(`Không đủ số dư: ví có ${fmtAmount(balance)} ${tok.symbol}, cần ${fmtAmount(amt)}.`);
    }

    // Bước 1, 2: approve = cho phép FXHub rút token từ ví owner; hạn mức đã đủ thì bỏ qua
    started = true;
    for (const [step, tok, amt] of parts) {
      if (amt === 0n) {
        Object.assign(step, { state: "skip", detail: `Bỏ qua – lần này không nạp ${tok.symbol}.` });
        continue;
      }
      const allowance = await tok.contract.allowance(state.account, hubAddr);
      if (allowance >= amt) {
        Object.assign(step, { state: "skip", detail: `Bỏ qua – hạn mức đã đủ (${fmtAmount(allowance)} ${tok.symbol}).` });
        continue;
      }
      Object.assign(step, { state: "active", detail: `Chờ bạn ký approve ${fmtAmount(amt)} ${tok.symbol} trong MetaMask…` });
      render();
      const tx = await tok.contract.approve(hubAddr, amt);
      await waitForConfirmation(tx, (html, type) => {
        step.detail = html;
        render(type);
      });
      Object.assign(step, { state: "done", detail: `Đã approve ${fmtAmount(amt)} ${tok.symbol} · ${txLink(tx.hash, true)}` });
    }

    // Bước 3: nạp vào quỹ
    const step = steps[2];
    const poolBefore = await readPool(t); // dự phòng nếu không đọc được theo block
    Object.assign(step, { state: "active", detail: "Chờ bạn ký giao dịch nạp thanh khoản trong MetaMask…" });
    render();
    const tx = await state.hub.addLiquidity(t.address, amountToken, amountUsd);
    const receipt = await waitForConfirmation(tx, (html, type) => {
      step.detail = html;
      render(type);
    });
    Object.assign(step, { state: "done", detail: `Đã nạp · ${txLink(receipt.hash, true)}` });

    // Số dư quỹ ngay TRƯỚC và SAU block chứa giao dịch nạp (chính xác kể cả khi có người chuyển tiền xen giữa)
    const [before, after] = await Promise.all([
      readPool(t, receipt.blockNumber - 1).catch(() => poolBefore),
      readPool(t, receipt.blockNumber).catch(() => readPool(t)),
    ]);
    const sym = t.symbol;
    render(
      "success",
      "<b>Nạp thanh khoản thành công!</b>",
      `<dl class="liq-summary">
        <dt>Đã nạp</dt><dd>${fmtAmount(amountToken)} ${sym} + ${fmtAmount(amountUsd)} vUSD</dd>
        <dt>Tỷ giá quỹ</dt><dd>Trước: ${fmtRate(poolRate(before.token, before.usd), sym)}<br>Sau: ${fmtRate(poolRate(after.token, after.usd), sym)}</dd>
        <dt>Số dư quỹ</dt><dd>Trước: ${fmtReserves(before, sym)}<br>Sau: ${fmtReserves(after, sym)}</dd>
        <dt>Giao dịch nạp</dt><dd>${txLink(receipt.hash, true)}</dd>
      </dl>`,
    );
    clearLiq();
  } catch (e) {
    const msg = esc(friendlyError(e));
    if (!started) {
      setStatus("admin-status", msg, "error");
    } else {
      // Đánh dấu bước đang dở là thất bại, các bước đã xong vẫn giữ link
      const cur = steps.find((s) => s.state === "active");
      if (cur) Object.assign(cur, { state: "fail", detail: "" });
      render("error", `<b>${msg}</b>`);
    }
  } finally {
    btn.disabled = false;
    // Đã gửi giao dịch (hoặc thử gửi) → tự làm mới khu "Các quỹ" và bảng lịch sử thanh khoản
    if (started) await Promise.all([safe(loadAdminState)(), safe(loadLiqHistory)()]);
  }
}

// ───────────────────────── h. Lịch sử thanh khoản (event LiquidityAdded / LiquidityRemoved) ─────────────────────────

let liqHistorySeq = 0; // bấm Làm mới khi đang tải thì bỏ lượt tải cũ

// Owner xem TOÀN BỘ lần nạp/rút (không lọc theo ví); dùng bộ nhớ đệm riêng
const liqCacheKey = () => cacheKey(state.chain.chainId, state.chain.hub, "liquidity");

function renderLiqHistory(records, info) {
  const box = $("liq-history");
  if (records.length === 0) {
    box.innerHTML = `<div class="empty">${info.phase === "done" ? "Chưa có lần nạp/rút thanh khoản nào." : "Đang tải…"}</div>`;
    return;
  }
  const rows = records.map((r) => {
    const { token, amountToken, amountUsd } = r.args;
    const sym = tokenByAddress(token)?.symbol ?? shortAddr(token);
    const isAdd = r.name === "LiquidityAdded";
    return `
      <tr>
        <td>${fmtTime(r.time)}</td>
        <td><span class="pool-name">${coinBadge(sym, "sm")}${sym}</span></td>
        <td><span class="tag ${isAdd ? "add" : "remove"}">${isAdd ? "Nạp" : "Rút"}</span></td>
        <td class="num">${fmtAmount(BigInt(amountToken))} ${sym}</td>
        <td class="num">${fmtAmount(BigInt(amountUsd))} vUSD</td>
        <td>${txLink(r.tx, true)}</td>
      </tr>`;
  });
  box.innerHTML = `
    <div class="table-wrap">
      <table class="liq-table">
        <thead><tr><th>Thời gian</th><th>Quỹ</th><th>Loại</th><th class="num">Số token</th><th class="num">Số vUSD</th><th>Giao dịch</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
      </table>
    </div>`;
}

async function loadLiqHistory() {
  const seq = ++liqHistorySeq;
  const hub = state.hub;
  await runScan({
    label: "Lịch sử thanh khoản",
    progressId: "liq-history-progress",
    key: liqCacheKey(),
    isCancelled: () => seq !== liqHistorySeq,
    render: renderLiqHistory,
    query: async (from, to) =>
      (
        await Promise.all([
          hub.queryFilter(hub.filters.LiquidityAdded(), from, to),
          hub.queryFilter(hub.filters.LiquidityRemoved(), from, to),
        ])
      ).flat(),
  });
}

// ───────────────────────── Gắn sự kiện ─────────────────────────

hydrateIcons();
// Ô nhập tiền: tự thêm dấu chấm hàng nghìn khi gõ (gắn TRƯỚC các listener khác để chúng đọc số đã định dạng)
for (const id of ["send-amount", "liq-amount-token", "liq-amount-usd"]) attachAmountInput($(id));
$("btn-copy").innerHTML = icon("copy");
$("btn-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText(state.account);
    $("btn-copy").innerHTML = icon("check");
    setTimeout(() => ($("btn-copy").innerHTML = icon("copy")), 1500);
  } catch {
    showMessage("Không sao chép được. Hãy bôi đen địa chỉ để sao chép.", "error");
  }
};
// Đảo đồng gửi ↔ đồng nhận rồi báo giá lại
$("btn-swap").onclick = () => {
  const from = $("send-from").value;
  $("send-from").value = $("send-to").value;
  $("send-to").value = from;
  $("send-from").dispatchEvent(new Event("input"));
};

$("btn-connect").onclick = safe(connect);
$("network-switch").onclick = (e) => {
  const chainId = e.target.closest("[data-switch]")?.dataset.switch;
  if (chainId) safe(switchNetwork)(chainId);
};
$("tabs").onclick = (e) => {
  const tab = e.target.closest("[data-tab]")?.dataset.tab;
  if (tab) showTab(tab);
};

$("btn-refresh").onclick = safe(whenConnected(loadBalances));
$("balances").onclick = (e) => {
  const faucetBtn = e.target.closest("[data-faucet]");
  if (faucetBtn) return safe(whenConnected(claimFaucet))(faucetBtn.dataset.faucet, faucetBtn);
  const watchBtn = e.target.closest("[data-watch]");
  if (watchBtn) safe(watchAsset)(watchBtn.dataset.watch);
};

for (const id of ["send-from", "send-to", "send-amount", "send-slippage"]) $(id).addEventListener("input", whenConnected(async () => scheduleQuote()));
// Form: luôn chặn tải lại trang, chỉ gửi khi đã kết nối
const onSubmit = (fn) => (e) => {
  e.preventDefault();
  whenConnected(fn)(e);
};
$("send-form").onsubmit = onSubmit(send);

$("btn-history").onclick = safe(whenConnected(loadHistory));
$("btn-history-reset").onclick = safe(whenConnected(resetHistory));

$("btn-admin-refresh").onclick = safe(whenConnected(loadAdmin));
$("btn-pause").onclick = whenConnected(togglePause);
$("liq-token").onchange = onLiqTokenChange;
$("liq-amount-token").addEventListener("input", () => onLiqInput("token"));
$("liq-amount-usd").addEventListener("input", () => onLiqInput("usd"));
$("btn-liq-fill").onclick = refillLiq;
$("btn-liq-clear").onclick = clearLiq;
$("liq-form").onsubmit = onSubmit(addLiquidity);
$("btn-liq-history").onclick = safe(whenConnected(loadLiqHistory));
$("btn-liq-history-reset").onclick = safe(whenConnected(resetLiqHistory));

// Khung hướng dẫn: link faucet, nút mở trong app MetaMask (chỉ hiện trên điện thoại chưa có MetaMask)
$("faucet-link").href = FAUCET_URL;
$("mm-app-link").href = metamaskAppLink;
$("mobile-open").hidden = !(isMobile && !eth);

// Tải trang: nếu MetaMask đã cho phép trang này từ trước (eth_accounts có địa chỉ) thì tự kết nối
if (eth) {
  eth.on("accountsChanged", safe(init)); // đổi tài khoản trong MetaMask
  eth.on("chainChanged", () => window.location.reload()); // đổi mạng → tải lại trang cho sạch
  safe(init)();
} else {
  showDisconnected();
  // Một số trình duyệt (vd app MetaMask trên điện thoại) gắn MetaMask vào trang muộn hơn → tải lại khi nó sẵn sàng
  window.addEventListener("ethereum#initialized", () => window.location.reload(), { once: true });
}
