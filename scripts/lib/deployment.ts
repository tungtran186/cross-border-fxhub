import { readFile } from "node:fs/promises";
import { formatUnits, type ContractTransactionReceipt, type ContractTransactionResponse } from "ethers";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";

// Đọc địa chỉ contract từ file Ignition tự sinh, không gõ tay:
// ignition/deployments/chain-<chainId>/deployed_addresses.json
export async function loadDeployment(ethers: HardhatEthers) {
  const { chainId } = await ethers.provider.getNetwork();
  const file = `ignition/deployments/chain-${chainId}/deployed_addresses.json`;

  let addresses: Record<string, string>;
  try {
    addresses = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`Không đọc được ${file}. Hãy chạy Ignition deploy trước.`);
  }

  // Khoá trong file có dạng "CrossBorderModule#vUSD"
  const addr = (id: string) => {
    const a = addresses[`CrossBorderModule#${id}`];
    if (!a) throw new Error(`Thiếu CrossBorderModule#${id} trong ${file}`);
    return a;
  };
  const token = (id: string) => ethers.getContractAt("StableToken", addr(id));

  return {
    chainId,
    usd: await token("vUSD"),
    tokens: {
      vVND: await token("vVND"),
      vJPY: await token("vJPY"),
      vKRW: await token("vKRW"),
      vTWD: await token("vTWD"),
    },
    hub: await ethers.getContractAt("FXHub", addr("FXHub")),
  };
}

// Link xem giao dịch: trên Sepolia trỏ Etherscan, trên mạng local chỉ in mã giao dịch
export function txUrl(chainId: bigint, hash: string): string {
  return chainId === 11155111n ? `https://sepolia.etherscan.io/tx/${hash}` : hash;
}

// Gửi 1 giao dịch và in tiến độ: ⏳ đang chờ → ✅ đã xác nhận (block, gas)
export async function sendTx(
  chainId: bigint,
  label: string,
  send: () => Promise<ContractTransactionResponse>,
): Promise<ContractTransactionReceipt> {
  const tx = await send();
  console.log(`  ⏳ ${label}: ${txUrl(chainId, tx.hash)}`);
  const receipt = await tx.wait();
  if (!receipt) throw new Error(`${label}: không nhận được biên nhận giao dịch`);
  console.log(`  ✅ ${label}: block ${receipt.blockNumber}, gas ${receipt.gasUsed.toLocaleString("vi-VN")}`);
  return receipt;
}

// In số token (BigInt, 18 số lẻ) theo kiểu Việt Nam: 15.210.535,17
export function fmt(amount: bigint, digits = 2): string {
  return Number(formatUnits(amount, 18)).toLocaleString("vi-VN", { maximumFractionDigits: digits });
}
