// Ô nhập số tiền kiểu Việt Nam, tự định dạng KHI ĐANG GÕ:
//   gõ 500000000 → hiện 500.000.000 ; dấu phẩy là phần thập phân: 1.234,5
// - Dấu chấm hàng nghìn do trang tự thêm; phím "." (bàn phím số, điện thoại) được hiểu là dấu phẩy thập phân
//   nếu ô chưa có dấu phẩy (đã có thì bỏ qua). Chỉ cho 1 dấu phẩy.
// - Giữ đúng vị trí con trỏ khi chèn/xoá dấu chấm.
// - Dán "1.234.567,89", "1234567.89" hay "1,234,567.89" đều hiểu đúng.
// Giá trị gửi lên contract vẫn đọc bằng parseAmount() (bỏ dấu chấm, đổi phẩy → chấm rồi parseUnits).

const MAX_DECIMALS = 18;

// Thêm dấu chấm mỗi 3 chữ số phần nguyên
const group = (intDigits) => intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

// Chuỗi chỉ gồm chữ số và (tối đa) 1 dấu phẩy → chuỗi đã định dạng.
// keep = số ký tự "có nghĩa" (chữ số / dấu phẩy) đứng trước con trỏ → trả về vị trí con trỏ mới.
function formatCore(clean, keep) {
  const comma = clean.indexOf(",");
  let int = comma >= 0 ? clean.slice(0, comma) : clean;
  const frac = comma >= 0 ? clean.slice(comma + 1, comma + 1 + MAX_DECIMALS) : null;

  // Bỏ số 0 thừa ở đầu (007 → 7), nhưng giữ "0" trước dấu phẩy (0,5)
  const stripped = int.replace(/^0+(?=\d)/, "");
  keep = Math.max(0, keep - (int.length - stripped.length));
  int = stripped;
  if (int === "" && frac !== null) {
    int = "0";
    keep += 1; // vừa chèn thêm "0" ở đầu
  }

  const text = group(int) + (frac !== null ? "," + frac : "");
  // Đi dọc chuỗi mới, đếm đủ `keep` ký tự có nghĩa thì đặt con trỏ ở đó
  let caret = 0;
  for (let seen = 0; caret < text.length && seen < keep; caret++) if (text[caret] !== ".") seen++;
  return { text, caret };
}

// Lọc ký tự: chỉ giữ chữ số và dấu phẩy đầu tiên. Trả về chuỗi sạch + số ký tự có nghĩa trước con trỏ.
function clean(value, caretPos) {
  let out = "";
  let keep = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    const ok = (ch >= "0" && ch <= "9") || (ch === "," && !out.includes(","));
    if (!ok) continue;
    out += ch;
    if (i < caretPos) keep++;
  }
  return { out, keep };
}

// Số dán vào (nhiều kiểu viết) → dạng Việt Nam chỉ gồm chữ số + dấu phẩy
export function normalizePasted(text) {
  let s = String(text).replace(/[^\d.,]/g, "");
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Có cả 2 loại: dấu đứng sau cùng là phần thập phân
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    s = s.split(thou).join("").replace(dec, ",");
  } else if (lastDot >= 0) {
    // Chỉ có dấu chấm: 1 dấu chấm mà phía sau KHÔNG đúng 3 chữ số → thập phân (1234.5, 0.25);
    // còn lại (1.234 / 1.234.567) → ngăn cách hàng nghìn
    const parts = s.split(".");
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join(",") : parts.join("");
  } else if (lastComma >= 0) {
    // Chỉ có dấu phẩy: từ 2 dấu phẩy trở lên (1,234,567) → kiểu Mỹ ngăn cách hàng nghìn;
    // 1 dấu phẩy → phần thập phân kiểu Việt Nam (1,5 hoặc 1,234)
    const parts = s.split(",");
    s = parts.length > 2 ? parts.join("") : s;
  }
  return s;
}

function reformat(input) {
  const caretPos = input.selectionStart ?? input.value.length;
  const { out, keep } = clean(input.value, caretPos);
  const { text, caret } = formatCore(out, keep);
  if (input.value !== text) input.value = text;
  if (document.activeElement === input) input.setSelectionRange(caret, caret);
}

// Gắn định dạng cho 1 ô; gọi TRƯỚC các listener "input" khác để chúng đọc giá trị đã định dạng
export function attachAmountInput(input) {
  input.addEventListener("beforeinput", (e) => {
    const { selectionStart: s, selectionEnd: end, value } = input;
    // Chặn ký tự không phải số (cho phép 1 dấu phẩy)
    if (e.inputType === "insertText" && e.data) {
      const hasComma = (value.slice(0, s) + value.slice(end)).includes(","); // phần còn lại sau khi thay vùng chọn
      // Phím "." → cho qua, listener "input" bên dưới đổi thành dấu phẩy; đã có dấu phẩy thì chặn
      if (e.data === ".") {
        if (hasComma) e.preventDefault();
        return;
      }
      const allowed = /^[\d,]+$/.test(e.data) && !(e.data.includes(",") && hasComma);
      if (!allowed) e.preventDefault();
      return;
    }
    // Xoá đúng vào dấu chấm → xoá luôn chữ số bên cạnh (nếu không, dấu chấm tự hiện lại và con trỏ "kẹt")
    if (s === end && (e.inputType === "deleteContentBackward" || e.inputType === "deleteContentForward")) {
      const back = e.inputType === "deleteContentBackward";
      const dotAt = back ? s - 1 : s;
      if (value[dotAt] !== ".") return;
      e.preventDefault();
      const digitAt = back ? dotAt - 1 : dotAt + 1;
      if (digitAt < 0 || digitAt >= value.length) return;
      input.value = value.slice(0, Math.min(dotAt, digitAt)) + value.slice(Math.max(dotAt, digitAt) + 1);
      const caret = back ? digitAt : dotAt;
      input.setSelectionRange(caret, caret);
      reformat(input);
      input.dispatchEvent(new Event("input", { bubbles: true })); // báo cho các listener khác (báo giá, tự điền)
    }
  });

  // Dán: hiểu nhiều kiểu viết số rồi chèn vào chỗ con trỏ
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text");
    if (text == null) return;
    e.preventDefault();
    input.setRangeText(normalizePasted(text), input.selectionStart, input.selectionEnd, "end");
    reformat(input);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // Gõ / xoá / tự động điền của trình duyệt → định dạng lại
  input.addEventListener("input", (e) => {
    // Phím "." (bàn phím số, bàn phím điện thoại) = dấu phẩy thập phân, chỉ khi ô chưa có dấu phẩy.
    // Xử lý ở đây (không chỉ ở beforeinput) vì bàn phím điện thoại có thể không báo beforeinput.
    if (e.data === ".") {
      const c = input.selectionStart ?? input.value.length;
      const v = input.value;
      if (c > 0 && v[c - 1] === ".") {
        const rest = v.slice(0, c - 1) + v.slice(c); // bỏ dấu "." vừa gõ
        if (rest.includes(",")) {
          input.value = rest; // đã có dấu phẩy → bỏ qua phím "."
          input.setSelectionRange(c - 1, c - 1);
        } else {
          input.value = v.slice(0, c - 1) + "," + v.slice(c);
          input.setSelectionRange(c, c);
        }
      }
    }
    reformat(input);
  });
}

// Dùng cho kiểm thử: định dạng 1 chuỗi bất kỳ (con trỏ ở cuối)
export const formatTyped = (value) => formatCore(clean(value, value.length).out, Infinity).text;
