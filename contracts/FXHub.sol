// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title FXHub – sàn hoán đổi ngoại tệ mô hình "trục USD"
/// @notice Mỗi đồng tiền (vVND, vJPY...) có 1 quỹ riêng ghép cặp với vUSD.
///         Đổi JPY → VND = 2 chặng: JPY → USD (quỹ JPY), rồi USD → VND (quỹ VND).
///         Giá theo công thức AMM x * y = k, phí 0,3% mỗi chặng (phí ở lại trong quỹ).
contract FXHub is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// Phí 0,3% = 3/1000 → người dùng thực sự "đổi" 997/1000 số tiền đưa vào
    uint256 public constant FEE_NUMERATOR = 997;
    uint256 public constant FEE_DENOMINATOR = 1000;

    /// Đồng tiền trục (vUSD), cố định khi deploy
    IERC20 public immutable usd;

    /// Một quỹ: số đồng tiền địa phương và số vUSD đang nằm trong quỹ
    struct Pool {
        bool listed;
        uint256 reserveToken;
        uint256 reserveUsd;
    }

    /// Địa chỉ token địa phương => quỹ của nó
    mapping(address => Pool) public pools;

    /// Danh sách token đã niêm yết (để frontend đọc)
    address[] public listedTokens;

    error ZeroAddress();
    error ZeroAmount();
    error SameToken();
    error AlreadyListed(address token);
    error NotListed(address token);
    error InsufficientLiquidity();
    error SlippageExceeded(uint256 amountOut, uint256 minOut);

    event TokenListed(address indexed token);
    event LiquidityAdded(address indexed token, uint256 amountToken, uint256 amountUsd);
    event LiquidityRemoved(address indexed token, uint256 amountToken, uint256 amountUsd);
    event Remittance(
        address indexed sender,
        address indexed recipient,
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 amountOut
    );

    constructor(address usd_) Ownable(msg.sender) {
        if (usd_ == address(0)) revert ZeroAddress();
        usd = IERC20(usd_);
    }

    // ───────────────────────── Quản trị (chỉ owner) ─────────────────────────

    /// Mở quỹ mới cho một đồng tiền (ví dụ vVND). Quỹ ban đầu rỗng.
    function listToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (token == address(usd)) revert SameToken();
        if (pools[token].listed) revert AlreadyListed(token);
        pools[token].listed = true;
        listedTokens.push(token);
        emit TokenListed(token);
    }

    /// Owner nạp tiền vào quỹ. Tỷ lệ 2 bên nạp vào quyết định tỷ giá.
    /// Cần approve trước cho FXHub cả 2 token.
    function addLiquidity(address token, uint256 amountToken, uint256 amountUsd)
        external
        onlyOwner
        nonReentrant
    {
        Pool storage p = _pool(token);
        if (amountToken == 0 && amountUsd == 0) revert ZeroAmount();
        // Effects trước, interactions sau (checks-effects-interactions)
        p.reserveToken += amountToken;
        p.reserveUsd += amountUsd;
        if (amountToken > 0) IERC20(token).safeTransferFrom(msg.sender, address(this), amountToken);
        if (amountUsd > 0) usd.safeTransferFrom(msg.sender, address(this), amountUsd);
        emit LiquidityAdded(token, amountToken, amountUsd);
    }

    /// Owner rút tiền khỏi quỹ về ví owner.
    function removeLiquidity(address token, uint256 amountToken, uint256 amountUsd)
        external
        onlyOwner
        nonReentrant
    {
        Pool storage p = _pool(token);
        if (amountToken == 0 && amountUsd == 0) revert ZeroAmount();
        if (amountToken > p.reserveToken || amountUsd > p.reserveUsd) revert InsufficientLiquidity();
        p.reserveToken -= amountToken;
        p.reserveUsd -= amountUsd;
        if (amountToken > 0) IERC20(token).safeTransfer(msg.sender, amountToken);
        if (amountUsd > 0) usd.safeTransfer(msg.sender, amountUsd);
        emit LiquidityRemoved(token, amountToken, amountUsd);
    }

    /// Tạm dừng khẩn cấp: chặn sendCrossBorder
    function pause() external onlyOwner {
        _pause();
    }

    /// Mở lại sau khi tạm dừng
    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────── Người dùng ─────────────────────────

    /// Báo giá: đưa amountIn fromToken thì nhận được bao nhiêu toToken (chưa gửi gì cả)
    function quote(address fromToken, address toToken, uint256 amountIn)
        public
        view
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (fromToken == toToken) revert SameToken();

        if (fromToken == address(usd)) {
            // Trường hợp 1: USD → token (1 chặng)
            Pool storage pOut = _pool(toToken);
            return getAmountOut(amountIn, pOut.reserveUsd, pOut.reserveToken);
        }
        if (toToken == address(usd)) {
            // Trường hợp 2: token → USD (1 chặng)
            Pool storage pIn = _pool(fromToken);
            return getAmountOut(amountIn, pIn.reserveToken, pIn.reserveUsd);
        }
        // Trường hợp 3: token A → USD → token B (2 chặng)
        Pool storage a = _pool(fromToken);
        Pool storage b = _pool(toToken);
        uint256 usdMid = getAmountOut(amountIn, a.reserveToken, a.reserveUsd);
        return getAmountOut(usdMid, b.reserveUsd, b.reserveToken);
    }

    /// Gửi tiền xuyên biên giới trong 1 giao dịch:
    /// người gửi đưa amountIn fromToken, recipient nhận toToken.
    /// minOut: số tối thiểu chấp nhận nhận được (chống trượt giá); ít hơn thì huỷ cả giao dịch.
    /// Cần approve fromToken cho FXHub trước.
    function sendCrossBorder(
        address fromToken,
        address toToken,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external nonReentrant whenNotPaused returns (uint256 amountOut) {
        // ── Checks ──
        if (recipient == address(0)) revert ZeroAddress();
        amountOut = quote(fromToken, toToken, amountIn);
        if (amountOut == 0) revert InsufficientLiquidity();
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);

        // ── Effects: cập nhật số dư các quỹ ──
        if (fromToken == address(usd)) {
            Pool storage p = pools[toToken];
            p.reserveUsd += amountIn;
            p.reserveToken -= amountOut;
        } else if (toToken == address(usd)) {
            Pool storage p = pools[fromToken];
            p.reserveToken += amountIn;
            p.reserveUsd -= amountOut;
        } else {
            Pool storage a = pools[fromToken];
            Pool storage b = pools[toToken];
            uint256 usdMid = getAmountOut(amountIn, a.reserveToken, a.reserveUsd);
            // Chặng 1: quỹ A nhận token A, trả ra usdMid
            a.reserveToken += amountIn;
            a.reserveUsd -= usdMid;
            // Chặng 2: usdMid chuyển nội bộ sang quỹ B, quỹ B trả token B
            b.reserveUsd += usdMid;
            b.reserveToken -= amountOut;
        }

        // ── Interactions: chuyển token thật ──
        IERC20(fromToken).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(toToken).safeTransfer(recipient, amountOut);

        emit Remittance(msg.sender, recipient, fromToken, toToken, amountIn, amountOut);
    }

    // ───────────────────────── Tiện ích ─────────────────────────

    /// Công thức AMM x*y=k có phí 0,3%:
    /// out = (in * 997) * reserveOut / (reserveIn * 1000 + in * 997)
    function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        public
        pure
        returns (uint256)
    {
        if (reserveIn == 0 || reserveOut == 0) revert InsufficientLiquidity();
        uint256 amountInWithFee = amountIn * FEE_NUMERATOR;
        return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
    }

    /// Số lượng token đã niêm yết
    function listedTokensCount() external view returns (uint256) {
        return listedTokens.length;
    }

    /// Lấy quỹ, báo lỗi nếu token chưa niêm yết
    function _pool(address token) private view returns (Pool storage p) {
        p = pools[token];
        if (!p.listed) revert NotListed(token);
    }
}
