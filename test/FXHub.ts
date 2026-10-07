import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture, time } = networkHelpers;

// Đổi số "người đọc" (ví dụ "100000") sang đơn vị nhỏ nhất (×10^18), kiểu BigInt
const units = (n: string) => ethers.parseUnits(n, 18);

// Công thức AMM giống hệt contract, viết lại bằng BigInt để tính kết quả mong đợi
// (BigInt = số nguyên lớn không giới hạn của JavaScript, ký hiệu bằng hậu tố n: 997n)
const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint) =>
  (amountIn * 997n * reserveOut) / (reserveIn * 1000n + amountIn * 997n);

// Thanh khoản ban đầu, đúng ví dụ số trong CLAUDE.md
const JPY_POOL = { token: units("1500000"), usd: units("10000") };
const VND_POOL = { token: units("260000000"), usd: units("10000") };

describe("FXHub", function () {
  // Fixture: dựng sẵn bối cảnh 1 lần, các test sau quay lại đúng trạng thái này (nhanh hơn deploy lại)
  async function deployFixture() {
    const [owner, alice, bob, mallory] = await ethers.getSigners();
    // owner: quản trị; alice: người gửi; bob: người nhận; mallory: kẻ không có quyền

    const supply = units("1000000000"); // 1 tỷ token mỗi loại cho owner
    const faucetAmount = units("1000");
    const usd = await ethers.deployContract("StableToken", ["Virtual USD", "vUSD", supply, faucetAmount]);
    const vnd = await ethers.deployContract("StableToken", ["Virtual VND", "vVND", supply, faucetAmount]);
    const jpy = await ethers.deployContract("StableToken", ["Virtual JPY", "vJPY", supply, faucetAmount]);
    const hub = await ethers.deployContract("FXHub", [await usd.getAddress()]);
    const hubAddr = await hub.getAddress();

    // Mở 2 quỹ và nạp thanh khoản (phải approve trước để FXHub được rút tiền của owner)
    await hub.listToken(await vnd.getAddress());
    await hub.listToken(await jpy.getAddress());
    await usd.approve(hubAddr, ethers.MaxUint256);
    await vnd.approve(hubAddr, ethers.MaxUint256);
    await jpy.approve(hubAddr, ethers.MaxUint256);
    await hub.addLiquidity(await jpy.getAddress(), JPY_POOL.token, JPY_POOL.usd);
    await hub.addLiquidity(await vnd.getAddress(), VND_POOL.token, VND_POOL.usd);

    // Cấp tiền cho alice và cho FXHub quyền rút tiền của alice
    for (const t of [usd, vnd, jpy]) {
      await t.transfer(alice.address, units("1000000"));
      await t.connect(alice).approve(hubAddr, ethers.MaxUint256);
    }

    return { owner, alice, bob, mallory, usd, vnd, jpy, hub };
  }

  // ───────────── 1. Faucet ─────────────
  describe("StableToken.faucet", function () {
    it("xin lần 2 trong 24h bị từ chối; tua 24h thì xin được", async function () {
      const { usd, mallory } = await loadFixture(deployFixture);

      await usd.connect(mallory).faucet();
      expect(await usd.balanceOf(mallory.address)).to.equal(units("1000"));

      await expect(usd.connect(mallory).faucet()).to.be.revertedWithCustomError(usd, "FaucetCooldown");

      await time.increase(24 * 60 * 60); // tua thời gian blockchain thêm 24 giờ
      await usd.connect(mallory).faucet();
      expect(await usd.balanceOf(mallory.address)).to.equal(units("2000"));
    });
  });

  // ───────────── 2. Phân quyền ─────────────
  describe("Phân quyền", function () {
    it("người không phải owner không gọi được các hàm quản trị", async function () {
      const { hub, jpy, mallory } = await loadFixture(deployFixture);
      const h = hub.connect(mallory);
      const jpyAddr = await jpy.getAddress();
      const err = "OwnableUnauthorizedAccount";

      await expect(h.listToken(mallory.address)).to.be.revertedWithCustomError(hub, err).withArgs(mallory.address);
      await expect(h.addLiquidity(jpyAddr, 1n, 1n)).to.be.revertedWithCustomError(hub, err);
      await expect(h.removeLiquidity(jpyAddr, 1n, 1n)).to.be.revertedWithCustomError(hub, err);
      await expect(h.pause()).to.be.revertedWithCustomError(hub, err);
      await expect(h.unpause()).to.be.revertedWithCustomError(hub, err);
    });
  });

  // ───────────── 3 & 4. Báo giá và chuyển tiền ─────────────
  describe("sendCrossBorder", function () {
    // Gửi, rồi so: quote trước khi gửi == số bob thực nhận == số alice bị trừ
    async function sendAndCheck(fromName: "usd" | "vnd" | "jpy", toName: "usd" | "vnd" | "jpy", amount: string) {
      const ctx = await loadFixture(deployFixture);
      const { hub, alice, bob } = ctx;
      const from = ctx[fromName];
      const to = ctx[toName];
      const fromAddr = await from.getAddress();
      const toAddr = await to.getAddress();
      const amountIn = units(amount);

      const quoted = await hub.quote(fromAddr, toAddr, amountIn);
      const aliceBefore = await from.balanceOf(alice.address);
      const bobBefore = await to.balanceOf(bob.address);

      await hub.connect(alice).sendCrossBorder(fromAddr, toAddr, amountIn, quoted, bob.address);

      expect(await from.balanceOf(alice.address)).to.equal(aliceBefore - amountIn); // alice bị trừ đúng
      expect(await to.balanceOf(bob.address)).to.equal(bobBefore + quoted); // bob nhận đúng bằng báo giá
      expect(quoted).to.be.greaterThan(0n);

      // Sổ sách khớp tiền thật: số token FXHub đang giữ = tổng các quỹ
      const hubAddr = await hub.getAddress();
      const pJpy = await hub.pools(await ctx.jpy.getAddress());
      const pVnd = await hub.pools(await ctx.vnd.getAddress());
      expect(await ctx.usd.balanceOf(hubAddr)).to.equal(pJpy.reserveUsd + pVnd.reserveUsd);
      expect(await ctx.jpy.balanceOf(hubAddr)).to.equal(pJpy.reserveToken);
      expect(await ctx.vnd.balanceOf(hubAddr)).to.equal(pVnd.reserveToken);

      return { ...ctx, quoted, amountIn };
    }

    it("USD → VND (1 chặng): quote khớp số nhận thực tế", async function () {
      const { quoted, amountIn } = await sendAndCheck("usd", "vnd", "100");
      expect(quoted).to.equal(amountOut(amountIn, VND_POOL.usd, VND_POOL.token));
    });

    it("VND → USD (1 chặng): quote khớp số nhận thực tế", async function () {
      const { quoted, amountIn } = await sendAndCheck("vnd", "usd", "260000");
      expect(quoted).to.equal(amountOut(amountIn, VND_POOL.token, VND_POOL.usd));
    });

    it("JPY → VND (2 chặng): quote khớp số nhận thực tế", async function () {
      const { quoted, amountIn } = await sendAndCheck("jpy", "vnd", "15000");
      const usdMid = amountOut(amountIn, JPY_POOL.token, JPY_POOL.usd);
      expect(quoted).to.equal(amountOut(usdMid, VND_POOL.usd, VND_POOL.token));
    });

    // ───────────── 5. Ví dụ số ─────────────
    it("ví dụ: gửi 100.000 vJPY → người nhận ≈ 15.210.535 vVND", async function () {
      const { quoted, vnd, bob } = await sendAndCheck("jpy", "vnd", "100000");
      expect(await vnd.balanceOf(bob.address)).to.equal(quoted);
      // Sai lệch dưới 1 vVND so với con số tính tay 15.210.535
      expect(quoted).to.be.closeTo(units("15210535"), units("1"));
    });
  });

  // ───────────── 6 & 7. Các trường hợp bị từ chối ─────────────
  describe("Từ chối giao dịch không hợp lệ", function () {
    it("minOut cao hơn báo giá → revert, số dư không đổi", async function () {
      const { hub, jpy, vnd, alice, bob } = await loadFixture(deployFixture);
      const jpyAddr = await jpy.getAddress();
      const vndAddr = await vnd.getAddress();
      const amountIn = units("100000");
      const quoted = await hub.quote(jpyAddr, vndAddr, amountIn);
      const aliceBefore = await jpy.balanceOf(alice.address);
      const bobBefore = await vnd.balanceOf(bob.address);
      const poolBefore = await hub.pools(vndAddr);

      await expect(hub.connect(alice).sendCrossBorder(jpyAddr, vndAddr, amountIn, quoted + 1n, bob.address))
        .to.be.revertedWithCustomError(hub, "SlippageExceeded")
        .withArgs(quoted, quoted + 1n);

      expect(await jpy.balanceOf(alice.address)).to.equal(aliceBefore);
      expect(await vnd.balanceOf(bob.address)).to.equal(bobBefore);
      expect((await hub.pools(vndAddr)).reserveToken).to.equal(poolBefore.reserveToken);
    });

    it("recipient = address(0) → revert", async function () {
      const { hub, usd, vnd, alice } = await loadFixture(deployFixture);
      await expect(
        hub.connect(alice).sendCrossBorder(await usd.getAddress(), await vnd.getAddress(), units("1"), 0n, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(hub, "ZeroAddress");
    });

    it("token chưa niêm yết → revert", async function () {
      const { hub, usd, alice, bob } = await loadFixture(deployFixture);
      const krw = await ethers.deployContract("StableToken", ["Virtual KRW", "vKRW", units("1000"), 0n]);
      const krwAddr = await krw.getAddress();

      await expect(hub.quote(await usd.getAddress(), krwAddr, units("1")))
        .to.be.revertedWithCustomError(hub, "NotListed")
        .withArgs(krwAddr);
      await expect(hub.connect(alice).sendCrossBorder(await usd.getAddress(), krwAddr, units("1"), 0n, bob.address))
        .to.be.revertedWithCustomError(hub, "NotListed")
        .withArgs(krwAddr);
    });
  });

  // ───────────── 8. Tạm dừng ─────────────
  describe("Pause / unpause", function () {
    it("khi pause thì sendCrossBorder bị chặn; unpause thì chạy lại", async function () {
      const { hub, usd, vnd, alice, bob } = await loadFixture(deployFixture);
      const usdAddr = await usd.getAddress();
      const vndAddr = await vnd.getAddress();

      await hub.pause();
      await expect(
        hub.connect(alice).sendCrossBorder(usdAddr, vndAddr, units("10"), 0n, bob.address),
      ).to.be.revertedWithCustomError(hub, "EnforcedPause");

      await hub.unpause();
      await hub.connect(alice).sendCrossBorder(usdAddr, vndAddr, units("10"), 0n, bob.address);
      expect(await vnd.balanceOf(bob.address)).to.be.greaterThan(0n);
    });
  });

  // ───────────── 9. Event ─────────────
  describe("Event Remittance", function () {
    it("phát đúng sender, recipient, fromToken, toToken, amountIn, amountOut", async function () {
      const { hub, jpy, vnd, alice, bob } = await loadFixture(deployFixture);
      const jpyAddr = await jpy.getAddress();
      const vndAddr = await vnd.getAddress();
      const amountIn = units("100000");
      const quoted = await hub.quote(jpyAddr, vndAddr, amountIn);

      await expect(hub.connect(alice).sendCrossBorder(jpyAddr, vndAddr, amountIn, 0n, bob.address))
        .to.emit(hub, "Remittance")
        .withArgs(alice.address, bob.address, jpyAddr, vndAddr, amountIn, quoted);
    });
  });

  // ───────────── 10. Rút thanh khoản ─────────────
  describe("removeLiquidity", function () {
    it("cập nhật đúng quỹ và trả tiền về ví owner", async function () {
      const { hub, jpy, usd, owner } = await loadFixture(deployFixture);
      const jpyAddr = await jpy.getAddress();
      const outJpy = units("500000");
      const outUsd = units("2000");
      const ownerJpyBefore = await jpy.balanceOf(owner.address);
      const ownerUsdBefore = await usd.balanceOf(owner.address);

      await expect(hub.removeLiquidity(jpyAddr, outJpy, outUsd))
        .to.emit(hub, "LiquidityRemoved")
        .withArgs(jpyAddr, outJpy, outUsd);

      const pool = await hub.pools(jpyAddr);
      expect(pool.reserveToken).to.equal(JPY_POOL.token - outJpy);
      expect(pool.reserveUsd).to.equal(JPY_POOL.usd - outUsd);
      expect(await jpy.balanceOf(owner.address)).to.equal(ownerJpyBefore + outJpy);
      expect(await usd.balanceOf(owner.address)).to.equal(ownerUsdBefore + outUsd);
    });

    it("rút quá số dư của quỹ → revert", async function () {
      const { hub, jpy } = await loadFixture(deployFixture);
      const jpyAddr = await jpy.getAddress();

      await expect(hub.removeLiquidity(jpyAddr, JPY_POOL.token + 1n, 0n)).to.be.revertedWithCustomError(
        hub,
        "InsufficientLiquidity",
      );
      await expect(hub.removeLiquidity(jpyAddr, 0n, JPY_POOL.usd + 1n)).to.be.revertedWithCustomError(
        hub,
        "InsufficientLiquidity",
      );
    });
  });
});
