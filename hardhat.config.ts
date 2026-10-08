import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.34",
      },
      production: {
        version: "0.8.34",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    // Lưu ý hardfork: mạng giả lập của Hardhat dùng "osaka" (giống Ethereum mainnet hiện nay).
    // Sepolia đã lên Glamsterdam ("amsterdam") từ 6/10/2026, giá gas ghi dữ liệu mới cao hơn,
    // nên cùng giao dịch sẽ tốn nhiều gas hơn trên Sepolia. Hardhat mới hỗ trợ "amsterdam"
    // ở mức thử nghiệm (số liệu chưa khớp Sepolia) nên giữ mặc định "osaka".
    // Node chạy bằng `npx hardhat node` trên máy mình (chainId 31337)
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    // Testnet Sepolia (chainId 11155111). Bí mật lấy từ keystore khi chạy,
    // chỉ hỏi mật khẩu khi lệnh thật sự dùng tới mạng này.
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("SEPOLIA_PRIVATE_KEY")],
    },
    // Sepolia CHỈ ĐỌC qua RPC công cộng, không có khoá → không hỏi mật khẩu keystore.
    // Dùng cho script chỉ đọc (collect-history, measure-slippage); không gửi được giao dịch.
    sepoliaPublic: {
      type: "http",
      chainType: "l1",
      url: "https://ethereum-sepolia-rpc.publicnode.com",
    },
  },
  // Xác minh mã nguồn trên sepolia.etherscan.io
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
