import "./style.css";
import { BrowserProvider, Contract, getAddress, isAddress } from "ethers";
import config from "./contracts.json";
import { fmtAmount, parseAmount, fmtPct, fmtTime, shortAddr } from "./format.js";
import { friendlyError, initErrors, UserError } from "./errors.js";

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

// Số block tối đa mỗi lần đọc event (RPC công cộng thường giới hạn 10.000)
const LOG_CHUNK = 10_000;

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
  el.className = `message ${type}`;
  el.textContent = text;
  el.hidden = !text;
}

// html: chỉ truyền nội dung do chính trang tạo ra; lỗi phải đi qua esc()
function setStatus(id, html, type = "info") {
  const el = $(id);
  el.className = `status ${type}`;
  el.innerHTML = html;
  el.hidden = !html;
}

// Mã giao dịch; trên Sepolia thì thành link Etherscan
function txLink(hash, short = false) {
  const text = short ? shortAddr(hash) : hash;
  const ex = state.chain?.explorer;
  return ex ? `<a href="${ex}/tx/${hash}" target="_blank" rel="noopener"><code>${text}</code></a>` : `<code>${text}</code>`;
}

// Chạy hàm async, lỗi thì hiện lên thanh thông báo
const safe = (fn) => (...args) => fn(...args).catch((e) => showMessage(friendlyError(e), "error"));

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
        `<button class="btn small ${wrongNetwork ? "warn" : ""}" data-switch="${n.chainId}">Chuyển sang ${esc(n.name)}</button>`,
    )
    .join("");
}

function showDisconnected() {
  hideApp();
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
  badge.className = "badge bad";
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
  $("account-badge").textContent = shortAddr(state.account);

  const network = networkOf(chainId);
  if (!network) return showWrongNetwork(chainId);

  renderSwitchButtons(chainId, false);
  const badge = $("network-badge");
  badge.hidden = false;
  badge.className = "badge";
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

function fillSelects() {
  const options = (list) => list.map((t) => `<option value="${t.symbol}">${t.symbol}</option>`).join("");
  if (!$("send-from").options.length) {
    $("send-from").innerHTML = options(state.tokens);
    $("send-to").innerHTML = options(state.tokens);
    $("send-from").value = "vJPY";
    $("send-to").value = "vVND";
  }
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

  $("eth-balance").textContent = `ETH để trả phí gas: ${fmtAmount(ethBalance, 4)}`;
  $("balances").innerHTML = rows
    .map(({ t, balance, last, cooldown, amount }) => {
      const nextAt = last === 0n ? 0 : Number(last + cooldown); // 0 = chưa xin lần nào
      const waiting = nextAt > now;
      return `
        <div class="row">
          <div class="main">
            <span class="symbol">${t.symbol}</span>
            <span class="amount">${fmtAmount(balance)}</span>
            ${waiting ? `<span class="muted small-text">Đã nhận hôm nay · xin lại lúc ${fmtTime(nextAt)}</span>` : ""}
          </div>
          <div class="actions">
            <button class="btn small primary" data-faucet="${t.symbol}" ${waiting ? "disabled" : ""}>
              Nhận coin thử nghiệm (+${fmtAmount(amount, 0)})
            </button>
            <button class="btn small" data-watch="${t.symbol}">Thêm vào MetaMask</button>
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
    showMessage(`Đang xác nhận giao dịch nhận ${symbol}…`);
    await tx.wait();
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
  box.textContent = text;
  box.hidden = false;
}

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

  // Số dư đồng gửi, hiện cạnh ô số tiền
  from.contract.balanceOf(state.account).then((b) => {
    $("send-balance").textContent = `(số dư: ${fmtAmount(b)} ${from.symbol})`;
  });

  if (!amountText) return void (box.hidden = true);
  if (from === to) return showQuoteError("Đồng gửi và đồng nhận phải khác nhau.");
  const amount = parseAmount(amountText);
  if (amount === null) return showQuoteError("Số tiền không hợp lệ. Gõ kiểu 100.000 hoặc 1,5.");
  if (amount === 0n) return showQuoteError("Số tiền phải lớn hơn 0.");

  try {
    const [out, listed] = await Promise.all([
      state.hub.quote(from.address, to.address, amount),
      listedOut(from, to, amount),
    ]);
    if (seq !== quoteSeq) return; // người dùng đã gõ tiếp, bỏ kết quả cũ

    const bps = slippageBps();
    const minOut = bps === null ? null : (out * (10000n - bps)) / 10000n;
    const shortfall = listed > 0n ? ((listed - out) * 10000n) / listed : 0n;
    const route =
      from === state.usd || to === state.usd
        ? `${from.symbol} → ${to.symbol} (1 chặng)`
        : `${from.symbol} → vUSD → ${to.symbol} (2 chặng)`;

    box.className = "quote";
    box.hidden = false;
    box.innerHTML = `
      <div class="muted">Người nhận được khoảng</div>
      <div class="big">${fmtAmount(out)} ${to.symbol}</div>
      <dl>
        <dt>Tỷ giá thực tế</dt><dd>1 ${from.symbol} = ${fmtAmount((out * ONE) / amount, 4)} ${to.symbol}</dd>
        <dt>Tỷ giá quỹ</dt><dd>1 ${from.symbol} = ${fmtAmount((listed * ONE) / amount, 4)} ${to.symbol}</dd>
        <dt>Hụt so với tỷ giá quỹ</dt><dd>${fmtPct(shortfall)} <span class="muted">(phí + trượt giá)</span></dd>
        <dt>Nhận tối thiểu</dt><dd>${minOut === null ? "Trượt giá phải từ 0 đến 50%" : `${fmtAmount(minOut)} ${to.symbol}`}</dd>
        <dt>Lộ trình</dt><dd>${route}</dd>
      </dl>`;
  } catch (e) {
    if (seq === quoteSeq) showQuoteError(friendlyError(e));
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

    // Bước 1: approve = cho phép sàn rút đúng số tiền này từ ví (chỉ khi hạn mức hiện tại chưa đủ)
    const allowance = await from.contract.allowance(state.account, hubAddr);
    const needApprove = allowance < amount;
    if (needApprove) {
      setStatus("send-status", `Bước 1/2 · Chờ bạn ký <b>cấp hạn mức (approve)</b> ${fmtAmount(amount)} ${from.symbol} trong MetaMask…`);
      const tx = await from.contract.approve(hubAddr, amount);
      setStatus("send-status", `Bước 1/2 · Đang xác nhận approve… ${txLink(tx.hash, true)}`);
      await tx.wait();
    }

    // Bước 2: lấy báo giá mới nhất, tính minOut, gửi
    const step = needApprove ? "Bước 2/2 · " : "";
    const quoted = await state.hub.quote(from.address, to.address, amount);
    const minOut = (quoted * (10000n - bps)) / 10000n;
    setStatus("send-status", `${step}Chờ bạn ký <b>giao dịch gửi tiền</b> trong MetaMask…`);
    const tx = await state.hub.sendCrossBorder(from.address, to.address, amount, minOut, recipient);
    setStatus("send-status", `${step}Đang xác nhận trên blockchain… ${txLink(tx.hash, true)}`);
    const receipt = await tx.wait();

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
      `✅ Thành công! Đã gửi ${fmtAmount(amount)} ${from.symbol}; ${shortAddr(recipient)} nhận ` +
        `<b>${fmtAmount(received)} ${to.symbol}</b>.<br>Mã giao dịch: ${txLink(receipt.hash)}`,
      "success",
    );
    $("send-amount").value = "";
    $("quote").hidden = true;
  } catch (e) {
    setStatus("send-status", esc(friendlyError(e)), "error");
  } finally {
    btn.disabled = false;
    updateQuote().catch(() => {});
  }
}

// ───────────────────────── f. Lịch sử (đọc event Remittance) ─────────────────────────

let historySeq = 0; // bấm Làm mới khi đang tải thì bỏ lượt tải cũ

async function loadHistory() {
  const seq = ++historySeq;
  const box = $("history");
  box.innerHTML = `<div class="empty">Đang tải…</div>`;
  const hub = state.hub;
  const firstBlock = state.chain.deployBlock;
  const lastBlock = await state.provider.getBlockNumber();

  // Đọc từng đoạn tối đa LOG_CHUNK block, mỗi đoạn 2 bộ lọc: ví là người gửi, hoặc là người nhận
  const unique = new Map();
  for (let start = firstBlock; start <= lastBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, lastBlock);
    const [sent, received] = await Promise.all([
      hub.queryFilter(hub.filters.Remittance(state.account), start, end),
      hub.queryFilter(hub.filters.Remittance(null, state.account), start, end),
    ]);
    if (seq !== historySeq) return;
    for (const e of [...sent, ...received]) unique.set(`${e.transactionHash}-${e.index}`, e);
    const pct = Math.round(((end - firstBlock + 1) / (lastBlock - firstBlock + 1)) * 100);
    box.innerHTML = `<div class="empty">Đang tải… ${pct}% (block ${end.toLocaleString("vi-VN")})</div>`;
  }
  const events = [...unique.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);

  if (events.length === 0) {
    box.innerHTML = `<div class="empty">Chưa có giao dịch nào liên quan tới ví này.</div>`;
    return;
  }

  // Thời điểm của từng block
  const times = new Map();
  await Promise.all(
    [...new Set(events.map((e) => e.blockNumber))].map(async (n) => {
      times.set(n, (await state.provider.getBlock(n)).timestamp);
    }),
  );
  if (seq !== historySeq) return;

  const sym = (addr) => tokenByAddress(addr)?.symbol ?? shortAddr(addr);
  box.innerHTML = events
    .map((e) => {
      const { sender, recipient, fromToken, toToken, amountIn, amountOut } = e.args;
      const isSender = getAddress(sender) === state.account;
      const isRecipient = getAddress(recipient) === state.account;
      const tag =
        isSender && isRecipient
          ? `<span class="tag self">Tự gửi</span>`
          : isSender
            ? `<span class="tag out">Gửi đi</span>`
            : `<span class="tag in">Nhận về</span>`;
      const other = isSender ? `Tới ${shortAddr(recipient)}` : `Từ ${shortAddr(sender)}`;
      return `
        <div class="row">
          <div class="main">
            <div>${tag} <span class="muted small-text">${fmtTime(times.get(e.blockNumber))}</span></div>
            <span class="amount">${fmtAmount(amountIn)} ${sym(fromToken)} → ${fmtAmount(amountOut)} ${sym(toToken)}</span>
            <span class="muted small-text">${other} · Mã GD ${txLink(e.transactionHash, true)}</span>
          </div>
        </div>`;
    })
    .join("");
}

// ───────────────────────── g. Quản trị (chỉ owner) ─────────────────────────

async function loadAdmin() {
  const paused = await state.hub.paused();
  $("pause-state").textContent = paused ? "⏸ Đang tạm dừng" : "▶ Đang hoạt động";
  $("btn-pause").textContent = paused ? "Mở lại (unpause)" : "Tạm dừng (pause)";

  const locals = state.tokens.filter((t) => t !== state.usd);
  const pools = await Promise.all(
    locals.map(async (t) => {
      const p = await state.hub.pools(t.address);
      return { t, token: p.reserveToken, usd: p.reserveUsd };
    }),
  );
  state.pools = Object.fromEntries(pools.map((p) => [p.t.symbol, p]));

  $("pools").innerHTML = pools
    .map(
      (p) => `
        <div class="row">
          <div class="main">
            <span class="symbol">${p.t.symbol} / vUSD</span>
            <span class="muted small-text">${fmtAmount(p.token)} ${p.t.symbol} · ${fmtAmount(p.usd)} vUSD</span>
          </div>
          <span class="amount">1 vUSD = ${p.usd > 0n ? fmtAmount((p.token * ONE) / p.usd, 4) : "—"} ${p.t.symbol}</span>
        </div>`,
    )
    .join("");
}

async function togglePause() {
  const btn = $("btn-pause");
  btn.disabled = true;
  try {
    const paused = await state.hub.paused();
    setStatus("admin-status", "Chờ bạn ký trong MetaMask…");
    const tx = paused ? await state.hub.unpause() : await state.hub.pause();
    setStatus("admin-status", `Đang xác nhận… ${txLink(tx.hash, true)}`);
    await tx.wait();
    setStatus(
      "admin-status",
      paused ? "Đã mở lại sàn." : "Đã tạm dừng sàn. Mọi lệnh gửi tiền sẽ bị chặn cho tới khi mở lại.",
      "success",
    );
  } catch (e) {
    setStatus("admin-status", esc(friendlyError(e)), "error");
  } finally {
    btn.disabled = false;
    await loadAdmin();
  }
}

function updateLiqLabel() {
  $("liq-token-label").textContent = `Số ${$("liq-token").value}`;
}

// Gõ số token → tự điền số vUSD theo tỷ giá hiện tại của quỹ (để không làm lệch tỷ giá)
function suggestLiqUsd() {
  const p = state.pools[$("liq-token").value];
  const amount = parseAmount($("liq-amount-token").value);
  if (!p || p.token === 0n || amount === null) return void ($("liq-hint").textContent = "");
  const usd = (amount * p.usd) / p.token;
  $("liq-amount-usd").value = fmtAmount(usd);
  $("liq-hint").textContent = `Đã tự điền số vUSD theo tỷ giá hiện tại của quỹ (sửa được). Nạp lệch tỷ lệ sẽ làm đổi tỷ giá.`;
}

async function addLiquidity(ev) {
  ev.preventDefault();
  const btn = $("btn-liq");
  const t = tokenBySymbol($("liq-token").value);
  const hubAddr = state.chain.hub;
  btn.disabled = true;
  try {
    const amountToken = parseAmount($("liq-amount-token").value || "0");
    const amountUsd = parseAmount($("liq-amount-usd").value || "0");
    if (amountToken === null || amountUsd === null) throw new UserError("Số tiền không hợp lệ. Gõ kiểu 100.000 hoặc 1,5.");
    if (amountToken === 0n && amountUsd === 0n) throw new UserError("Hãy nhập số tiền cần nạp.");

    // Kiểm tra số dư và approve từng token
    for (const [tok, amt] of [
      [t, amountToken],
      [state.usd, amountUsd],
    ]) {
      if (amt === 0n) continue;
      const balance = await tok.contract.balanceOf(state.account);
      if (balance < amt) throw new UserError(`Không đủ số dư: ví có ${fmtAmount(balance)} ${tok.symbol}, cần ${fmtAmount(amt)}.`);
      if ((await tok.contract.allowance(state.account, hubAddr)) < amt) {
        setStatus("admin-status", `Chờ bạn ký <b>approve</b> ${fmtAmount(amt)} ${tok.symbol}…`);
        const tx = await tok.contract.approve(hubAddr, amt);
        setStatus("admin-status", `Đang xác nhận approve ${tok.symbol}… ${txLink(tx.hash, true)}`);
        await tx.wait();
      }
    }

    setStatus("admin-status", "Chờ bạn ký <b>nạp thanh khoản</b>…");
    const tx = await state.hub.addLiquidity(t.address, amountToken, amountUsd);
    setStatus("admin-status", `Đang xác nhận… ${txLink(tx.hash, true)}`);
    await tx.wait();
    setStatus(
      "admin-status",
      `✅ Đã nạp ${fmtAmount(amountToken)} ${t.symbol} + ${fmtAmount(amountUsd)} vUSD vào quỹ.`,
      "success",
    );
    $("liq-amount-token").value = "";
    $("liq-amount-usd").value = "";
    $("liq-hint").textContent = "";
  } catch (e) {
    setStatus("admin-status", esc(friendlyError(e)), "error");
  } finally {
    btn.disabled = false;
    await loadAdmin();
  }
}

// ───────────────────────── Gắn sự kiện ─────────────────────────

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

$("btn-admin-refresh").onclick = safe(whenConnected(loadAdmin));
$("btn-pause").onclick = whenConnected(togglePause);
$("liq-token").onchange = () => {
  updateLiqLabel();
  suggestLiqUsd();
};
$("liq-amount-token").addEventListener("input", suggestLiqUsd);
$("liq-form").onsubmit = onSubmit(addLiquidity);

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
