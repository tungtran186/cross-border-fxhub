// Dịch lỗi từ MetaMask / contract sang câu tiếng Việt dễ hiểu
import { Interface } from "ethers";
import { fmtAmount, fmtTime } from "./format.js";

let errorInterface = null;

// Gộp các "custom error" của FXHub và StableToken để giải mã dữ liệu lỗi trả về
export function initErrors(abi) {
  const seen = new Set();
  const fragments = [...abi.FXHub, ...abi.StableToken].filter((f) => {
    if (f.type !== "error" || seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });
  errorInterface = new Interface(fragments);
}

// Tìm chuỗi dữ liệu lỗi (0x...) nằm sâu trong object lỗi của ethers/MetaMask
function findRevertData(err, depth = 0) {
  if (!err || typeof err !== "object" || depth > 5) return null;
  if (typeof err.data === "string" && err.data.startsWith("0x") && err.data.length >= 10) return err.data;
  for (const key of ["data", "error", "info", "cause"]) {
    const found = findRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function decodeRevert(err) {
  if (err?.revert?.name) return err.revert;
  const data = findRevertData(err);
  if (!data || !errorInterface) return null;
  try {
    return errorInterface.parseError(data);
  } catch {
    return null;
  }
}

const REVERT_MESSAGES = {
  SlippageExceeded: (a) =>
    `Giá vừa biến động: chỉ nhận được ${fmtAmount(a[0])}, thấp hơn mức tối thiểu ${fmtAmount(a[1])}. ` +
    `Hãy thử lại hoặc tăng ô "Trượt giá chấp nhận".`,
  EnforcedPause: () => "Hệ thống đang tạm dừng để bảo trì. Vui lòng thử lại sau.",
  ExpectedPause: () => "Hệ thống đang hoạt động bình thường (không ở trạng thái tạm dừng).",
  ERC20InsufficientBalance: (a) => `Không đủ số dư: ví chỉ có ${fmtAmount(a[1])}, cần ${fmtAmount(a[2])}.`,
  ERC20InsufficientAllowance: () => "Chưa cấp đủ hạn mức (approve) cho FXHub. Hãy bấm Gửi lại.",
  FaucetCooldown: (a) => `Ví này đã nhận coin thử nghiệm trong 24 giờ qua. Xin lại lúc ${fmtTime(a[0])}.`,
  NotListed: () => "Đồng tiền này chưa có quỹ trên FXHub (chưa được niêm yết).",
  AlreadyListed: () => "Đồng tiền này đã được niêm yết rồi.",
  SameToken: () => "Đồng gửi và đồng nhận phải khác nhau.",
  ZeroAddress: () => "Địa chỉ người nhận không hợp lệ.",
  ZeroAmount: () => "Số tiền phải lớn hơn 0.",
  InsufficientLiquidity: () => "Quỹ không đủ thanh khoản cho giao dịch này. Hãy thử số tiền nhỏ hơn.",
  OwnableUnauthorizedAccount: () => "Chỉ quản trị viên (owner) mới làm được việc này.",
};

// Lỗi do chính trang tạo ra, câu chữ đã là tiếng Việt → hiện nguyên văn
export class UserError extends Error {}

// Gom mọi đoạn chữ trong object lỗi để dò từ khoá (nonce, network changed...)
function allText(err) {
  const parts = [err?.message, err?.shortMessage, err?.info?.error?.message, err?.error?.message];
  return parts.filter(Boolean).join(" ").toLowerCase();
}

export function friendlyError(err) {
  if (err instanceof UserError) return err.message;

  const code = err?.code;
  const text = allText(err);

  // Người dùng bấm "Từ chối" trong MetaMask
  if (code === "ACTION_REJECTED" || code === 4001 || err?.info?.error?.code === 4001) {
    return "Bạn đã từ chối yêu cầu trong MetaMask.";
  }
  if (code === -32002) return "MetaMask đang có một yêu cầu chờ xử lý. Hãy mở MetaMask để xem.";
  if (code === "INSUFFICIENT_FUNDS" || text.includes("insufficient funds")) {
    return "Ví không đủ ETH để trả phí gas. Trên Sepolia, hãy xin SepoliaETH miễn phí ở faucet (xem phần Hướng dẫn).";
  }
  if (text.includes("network changed")) return "Ví vừa đổi mạng. Hãy chọn đúng mạng rồi thử lại.";
  if (text.includes("nonce")) {
    return "Lịch sử giao dịch trong MetaMask bị lệch (nonce). Vào MetaMask → Settings → Advanced → Clear activity tab data rồi thử lại.";
  }

  // Contract từ chối và có trả lý do (custom error)
  const revert = decodeRevert(err);
  if (revert && REVERT_MESSAGES[revert.name]) return REVERT_MESSAGES[revert.name](revert.args);
  if (revert) return `Contract từ chối giao dịch (${revert.name}).`;

  if (code === "CALL_EXCEPTION") {
    return "Contract từ chối giao dịch mà không nêu lý do. Hãy kiểm tra lại mạng đang chọn và số liệu đã nhập.";
  }
  if (code === "BAD_DATA") {
    return "Không đọc được dữ liệu từ contract. Có thể MetaMask đang ở sai mạng hoặc contract chưa được deploy trên mạng này.";
  }
  if (["NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "UNKNOWN_ERROR"].includes(code) || code === -32603) {
    return "Không kết nối được tới mạng blockchain (hoặc mạng đang chậm). Kiểm tra Internet rồi thử lại sau ít phút.";
  }

  // Lỗi chưa có trong danh sách: vẫn báo tiếng Việt, kèm chi tiết kỹ thuật ngắn để báo lại cho nhóm
  const detail = (err?.shortMessage || err?.message || String(err)).slice(0, 160);
  return `Đã xảy ra lỗi không mong muốn. Hãy tải lại trang và thử lại. (Chi tiết kỹ thuật: ${detail})`;
}
