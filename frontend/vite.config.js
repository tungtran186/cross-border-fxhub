import { defineConfig } from "vite";

// Đường dẫn gốc (base) của trang, tuỳ nơi build:
// - Vercel: trang nằm ở gốc tên miền (https://<tên>.vercel.app/) → "/".
//   Vercel tự đặt biến VERCEL=1 khi build, nên luôn dùng "/" (kể cả lỡ nhập VITE_BASE trên Vercel).
// - GitHub Pages: trang nằm ở https://<tên-tài-khoản>.github.io/<tên-repo>/ → "/cross-border-fxhub/".
//   Workflow (.github/workflows/deploy-pages.yml) tự đặt VITE_BASE=/<tên-repo>/.
// - Chạy trên máy (npm run dev / build): mặc định "/".
// Ảnh trong index.html viết dạng "/images/..." – Vite tự thêm base khi build, không cần sửa.
function pickBase() {
  if (process.env.VERCEL) return "/";
  return process.env.VITE_BASE || "/";
}

export default defineConfig({
  base: pickBase(),
});
