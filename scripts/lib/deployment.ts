import { readFile } from "node:fs/promises";
import { formatUnits } from "ethers";
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

// In số token (BigInt, 18 số lẻ) theo kiểu Việt Nam: 15.210.535,17
export function fmt(amount: bigint, digits = 2): string {
  return Number(formatUnits(amount, 18)).toLocaleString("vi-VN", { maximumFractionDigits: digits });
}
