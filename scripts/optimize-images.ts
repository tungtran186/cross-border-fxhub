// Tối ưu ảnh cho web: tách nền trắng → nền trong suốt, thu nhỏ, xuất WebP/PNG.
// Ảnh gốc (PNG nặng) để ở design/source/, ảnh xuất ra ở frontend/public/images/.
// Chạy: node scripts/optimize-images.ts
import { mkdir, stat } from "node:fs/promises";
import sharp, { type Sharp } from "sharp";

const SRC = "design/source";
const OUT = "frontend/public/images";
const MAX_BYTES = 300 * 1024; // mục tiêu mỗi file < 300 KB

// Tách nền trắng ("color to alpha"):
// - độ lệch so với trắng < lo  → trong suốt hẳn (xoá nền trắng/xám rất nhạt)
// - độ lệch >= full            → đục hoàn toàn (giữ nguyên vật thể)
// - ở giữa: bán trong suốt, màu được tính ngược để ghép lên nền nào cũng không bị quầng trắng
async function removeWhite(input: Buffer, lo: number, full: number): Promise<Sharp> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const aMin = Math.max(255 - r, 255 - g, 255 - b) / 255; // alpha nhỏ nhất để màu hợp lệ trên nền trắng
    const a = aMin <= lo ? 0 : Math.max(aMin, Math.min(1, (aMin - lo) / (full - lo)));
    if (a === 0) {
      data[i + 3] = 0;
      continue;
    }
    data[i] = Math.max(0, Math.round(255 - (255 - r) / a));
    data[i + 1] = Math.max(0, Math.round(255 - (255 - g) / a));
    data[i + 2] = Math.max(0, Math.round(255 - (255 - b) / a));
    data[i + 3] = Math.round(a * 255);
  }
  return sharp(data, { raw: info });
}

// Xuất WebP, giảm dần chất lượng nếu file vẫn > 300 KB
async function writeWebp(img: Sharp, file: string) {
  const buf = await img.png().toBuffer(); // chốt pixel trước khi thử nhiều mức chất lượng
  for (let quality = 80; quality >= 50; quality -= 5) {
    await sharp(buf).webp({ quality, alphaQuality: 90, effort: 6 }).toFile(file);
    if ((await stat(file)).size <= MAX_BYTES) return quality;
  }
  return 50;
}

const kb = (n: number) => `${(n / 1024).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} KB`;
const rows: string[][] = [];
const record = async (src: string, out: string, note = "") => {
  rows.push([out.split("/").pop()!, src ? kb((await stat(src)).size) : "—", kb((await stat(out)).size), note]);
};

await mkdir(OUT, { recursive: true });

// 1. Ảnh nền 2 bên: cao tối đa 1000px. Tách nền mạnh tay để hình kính mờ hoà vào nền mint.
for (const name of ["bg-left", "bg-right"]) {
  const src = `${SRC}/${name}.png`;
  const resized = await sharp(src).resize({ height: 1000, withoutEnlargement: true }).png().toBuffer();
  const q = await writeWebp(await removeWhite(resized, 0.02, 0.55), `${OUT}/${name}.webp`);
  await record(src, `${OUT}/${name}.webp`, `WebP q${q}`);
}

// 2. Hero: rộng tối đa 600px. Thu nhỏ TRƯỚC rồi mới tách nền để vùng bóng mờ mịn, không lấm tấm.
//    Sau khi tách nền thì cắt sát hình để hero không bị nhỏ vì viền trống.
{
  const src = `${SRC}/hero.png`;
  const resized = await sharp(src).resize({ width: 600, withoutEnlargement: true }).png().toBuffer();
  // full = 0.14: thân laptop/điện thoại đặc hơn (không bị nhạt); sau đó cắt bỏ viền trong suốt thừa
  const cut = await (await removeWhite(resized, 0.095, 0.14)).png().toBuffer();
  const trimmed = await sharp(cut).trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 1 }).png().toBuffer();
  const q = await writeWebp(sharp(trimmed), `${OUT}/hero.webp`);
  await record(src, `${OUT}/hero.webp`, `WebP q${q}`);
}

// 3. Logo: cắt sát vòng tròn (bỏ khoảng trắng thừa), tách nền, xuất PNG 256px
{
  const src = `${SRC}/logo.png`;
  const trimmed = await sharp(src).trim({ background: "#ffffff", threshold: 20 }).png().toBuffer();
  const resized = await sharp(trimmed).resize(256, 256, { fit: "contain", background: "#ffffff" }).png().toBuffer();
  await (await removeWhite(resized, 0.03, 0.25)).png({ compressionLevel: 9 }).toFile(`${OUT}/logo-256.png`);
  await record(src, `${OUT}/logo-256.png`, "PNG trong suốt");
}

// 4. Favicon 32×32: vẽ từ logo.svg (vẽ tay, nét sạch hơn khi thu nhỏ)
await sharp(`${OUT}/logo.svg`, { density: 300 }).resize(32, 32).png({ compressionLevel: 9 }).toFile(`${OUT}/favicon-32.png`);
await record("", `${OUT}/favicon-32.png`, "từ logo.svg");
await record("", `${OUT}/logo.svg`, "vẽ tay");

console.log("\nFile               Trước        Sau         Ghi chú");
for (const [file, before, after, note] of rows) {
  console.log(`${file.padEnd(18)} ${before.padStart(11)}  ${after.padStart(10)}   ${note}`);
}
