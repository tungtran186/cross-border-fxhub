// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title StableToken – stablecoin giả lập (vUSD, vVND, vJPY...) chỉ dùng trên testnet
/// @notice ERC-20 chuẩn, 18 số lẻ. Chủ (owner) được in thêm; ai cũng xin được faucet 1 lần/24h.
/// @dev Mọi số lượng đều tính theo đơn vị nhỏ nhất: 1 token = 10^18 đơn vị.
contract StableToken is ERC20, Ownable {
    /// Thời gian chờ giữa 2 lần xin faucet của cùng một ví
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    /// Số token phát cho mỗi lần xin faucet
    uint256 public immutable faucetAmount;

    /// Thời điểm (giây) lần cuối mỗi ví xin faucet; 0 = chưa xin lần nào
    mapping(address => uint256) public lastFaucetAt;

    error FaucetCooldown(uint256 nextAvailableAt);

    event FaucetClaimed(address indexed user, uint256 amount);

    /// @param name_ Tên đầy đủ, ví dụ "Virtual Vietnam Dong"
    /// @param symbol_ Ký hiệu, ví dụ "vVND"
    /// @param initialSupply Số token in sẵn cho người deploy (đơn vị nhỏ nhất)
    /// @param faucetAmount_ Số token phát mỗi lần faucet (đơn vị nhỏ nhất)
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        uint256 faucetAmount_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        faucetAmount = faucetAmount_;
        _mint(msg.sender, initialSupply);
    }

    /// Chỉ owner được in thêm token (ví dụ để nạp thanh khoản cho FXHub)
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// Ai cũng gọi được: nhận faucetAmount token, mỗi ví tối đa 1 lần mỗi 24 giờ
    function faucet() external {
        uint256 last = lastFaucetAt[msg.sender];
        // Lần đầu (last = 0) luôn được; các lần sau phải đợi đủ 24h
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) {
            revert FaucetCooldown(last + FAUCET_COOLDOWN);
        }
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        emit FaucetClaimed(msg.sender, faucetAmount);
    }
}
