// Kiểm tra ví deploy có đủ ETH trả phí gas cho deploy + seed + demo hay không.
// Chạy: npx hardhat run scripts/check-balance.ts --network sepolia   (hoặc --network localhost)
// Không đủ tiền thì báo thiếu bao nhiêu và thoát với mã lỗi 1.
import { network } from "hardhat";

const { ethers } = await network.create();
const [deployer] = await ethers.getSigners();
const { chainId } = await ethers.provider.getNetwork();

// Lượng gas từng việc, đo thực tế trên mạng local (làm tròn lên)
const PLAN = [
  { label: "Deploy 5 StableToken", gas: 5n * 750_000n },
  { label: "Deploy FXHub", gas: 1_050_000n },
  { label: "listToken × 4", gas: 4n * 92_000n },
  { label: "Seed: approve × 8", gas: 8n * 47_000n },
  { label: "Seed: addLiquidity × 4", gas: 4n * 143_000n },
  { label: "Demo: faucet + approve + gửi", gas: 75_000n + 47_000n + 104_000n },
];
const BUFFER_PERCENT = 130n; // cộng 30% dự phòng giá gas tăng

// Giá gas hiện tại: maxFeePerGas là mức trần ví sẵn sàng trả mỗi đơn vị gas
const fee = await ethers.provider.getFeeData();
const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
if (gasPrice === null) throw new Error("Không lấy được giá gas từ mạng");

const balance = await ethers.provider.getBalance(deployer.address);
const totalGas = PLAN.reduce((sum, p) => sum + p.gas, 0n);
const needed = (totalGas * gasPrice * BUFFER_PERCENT) / 100n;

const eth = (wei: bigint) => `${Number(ethers.formatEther(wei)).toLocaleString("vi-VN", { maximumFractionDigits: 6 })} ETH`;
const gwei = (wei: bigint) => `${Number(ethers.formatUnits(wei, "gwei")).toLocaleString("vi-VN", { maximumFractionDigits: 3 })} gwei`;

console.log(`Mạng:            chainId ${chainId}`);
console.log(`Ví deploy:       ${deployer.address}`);
console.log(`Số dư:           ${eth(balance)}`);
console.log(`Giá gas (trần):  ${gwei(gasPrice)}\n`);

console.log("Ước tính gas:");
for (const p of PLAN) {
  console.log(`  ${p.label.padEnd(30)} ${p.gas.toLocaleString("vi-VN").padStart(10)} gas ≈ ${eth(p.gas * gasPrice)}`);
}
console.log(`  ${"Tổng".padEnd(30)} ${totalGas.toLocaleString("vi-VN").padStart(10)} gas ≈ ${eth(totalGas * gasPrice)}`);
console.log(`  Cần (cộng 30% dự phòng):            ≈ ${eth(needed)}\n`);

if (balance >= needed) {
  console.log("✅ Đủ tiền. Có thể deploy.");
} else {
  console.log(`❌ Thiếu ${eth(needed - balance)}. Hãy xin thêm SepoliaETH từ faucet rồi chạy lại, ví dụ:`);
  console.log("   https://cloud.google.com/application/web3/faucet/ethereum/sepolia");
  console.log("   https://sepoliafaucet.com");
  process.exitCode = 1;
}
