import { defineConfig } from "vite";

// GitHub Pages phục vụ trang ở https://<tên-tài-khoản>.github.io/<tên-repo>/
// nên mọi đường dẫn file phải bắt đầu bằng /<tên-repo>/.
// Workflow (.github/workflows/deploy-pages.yml) tự đặt VITE_BASE theo tên repo;
// chạy trên máy (npm run dev / build) thì mặc định "/".
export default defineConfig({
  base: process.env.VITE_BASE || "/",
});
