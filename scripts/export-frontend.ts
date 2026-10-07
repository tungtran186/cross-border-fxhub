// Xuất ABI + địa chỉ contract cho frontend → frontend/src/contracts.json
// Đọc mọi bản deploy trong ignition/deployments/chain-<chainId>/ (không gõ tay địa chỉ).
// Chạy: npx hardhat run scripts/export-frontend.ts   (sau mỗi lần deploy)
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";

const MODULE = "CrossBorderModule";
const SYMBOLS = ["vUSD", "vVND", "vJPY", "vKRW", "vTWD"];
const OUT_FILE = "frontend/src/contracts.json";

// Thông tin mạng để frontend gọi wallet_addEthereumChain khi MetaMask chưa có mạng này
const CHAIN_INFO: Record<string, { name: string; rpcUrl: string; explorer: string | null }> = {
  "31337": { name: "Hardhat Local", rpcUrl: "http://127.0.0.1:8545", explorer: null },
  "11155111": { name: "Sepolia", rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
};

// ABI lấy từ artifacts do `npx hardhat build` sinh ra
const abiOf = async (name: string) =>
  JSON.parse(await readFile(`artifacts/contracts/${name}.sol/${name}.json`, "utf8")).abi;

// Block deploy FXHub (lấy trong journal của Ignition), để tab Lịch sử chỉ quét event từ block này
async function deployBlock(dir: string): Promise<number> {
  const lines = (await readFile(`${dir}/journal.jsonl`, "utf8")).split("\n");
  for (const line of lines) {
    if (!line.includes(`"${MODULE}#FXHub"`) || !line.includes('"receipt"')) continue;
    return JSON.parse(line).receipt.blockNumber;
  }
  return 0;
}

const chains: Record<string, unknown> = {};
for (const entry of await readdir("ignition/deployments")) {
  const chainId = entry.match(/^chain-(\d+)$/)?.[1];
  if (!chainId) continue;
  const dir = `ignition/deployments/${entry}`;
  const addresses: Record<string, string> = JSON.parse(await readFile(`${dir}/deployed_addresses.json`, "utf8"));

  const tokens = SYMBOLS.map((symbol) => {
    const address = addresses[`${MODULE}#${symbol}`];
    if (!address) throw new Error(`Thiếu ${MODULE}#${symbol} trong ${dir}`);
    return { symbol, address };
  });
  const hub = addresses[`${MODULE}#FXHub`];
  if (!hub) throw new Error(`Thiếu ${MODULE}#FXHub trong ${dir}`);

  const info = CHAIN_INFO[chainId] ?? { name: `Chain ${chainId}`, rpcUrl: "", explorer: null };
  chains[chainId] = { chainId: Number(chainId), ...info, hub, deployBlock: await deployBlock(dir), tokens };
  console.log(`chain ${chainId} (${info.name}): FXHub ${hub}, ${tokens.length} token`);
}

if (Object.keys(chains).length === 0) throw new Error("Chưa có bản deploy nào trong ignition/deployments");

await mkdir("frontend/src", { recursive: true });
await writeFile(
  OUT_FILE,
  JSON.stringify({ abi: { FXHub: await abiOf("FXHub"), StableToken: await abiOf("StableToken") }, chains }, null, 2),
);
console.log(`Đã ghi ${OUT_FILE}`);
