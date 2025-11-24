import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ArbitrageVault,
  ArbitrageVaultHarness,
  MockERC20,
  MockStakedUSDe,
  MockDEX
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ArbitrageVault - Phase 7: Fee Collection Mechanism", function () {
  let vault: ArbitrageVaultHarness;
  let usde: MockERC20;
  let sUsde: MockStakedUSDe;
  let dex: MockDEX;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let user1: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days

  beforeEach(async function () {
    [owner, keeper, user1, feeRecipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usde = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usde.waitForDeployment();

    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    sUsde = await MockStakedUSDeFactory.deploy(await usde.getAddress(), COOLDOWN_PERIOD);
    await sUsde.waitForDeployment();

    // Deploy vault (test harness)
    const VaultFactory = await ethers.getContractFactory("ArbitrageVaultHarness");
    vault = await VaultFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      feeRecipient.address
    );
    await vault.waitForDeployment();

    // Setup: mint tokens and approve
    await usde.mint(user1.address, INITIAL_SUPPLY);
    await usde.connect(user1).approve(await vault.getAddress(), INITIAL_SUPPLY);

    // Setup: mint sUSDe to vault for testing
    await sUsde.mint(await vault.getAddress(), INITIAL_SUPPLY);

    // Setup: mint USDe to sUsde contract (for paying out unstakes)
    await usde.mint(await sUsde.getAddress(), INITIAL_SUPPLY);

    // Setup: deploy proxies
    await vault.deployProxies(3);

    // Setup: add keeper
    await vault.connect(owner).addKeeper(keeper.address);

    // Setup: user1 deposits
    await vault.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
  });

  describe("Net-of-Fee NAV Calculation", function () {
    it("should apply fee discount to unrealized profit in NAV", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");
      const expectedProfit = expectedAssets - bookValue; // 5 USDe

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      // Fast forward to full accrual (7 days)
      await time.increase(COOLDOWN_PERIOD);

      const nav = await vault.totalAssets();
      const grossProfit = await vault.getAccruedProfit();
      const performanceFee = await vault.performanceFee(); // 10% = 1000 basis points

      // Verify gross profit
      expect(grossProfit).to.be.closeTo(expectedProfit, ethers.parseEther("0.001"));

      // Verify net-of-fee NAV
      // NAV = idle + bookValue + netProfit
      // netProfit = grossProfit × (1 - 10%) = 5 × 0.9 = 4.5 USDe
      const netProfit = (expectedProfit * (10000n - performanceFee)) / 10000n;
      const expectedNav = ethers.parseEther("905") + bookValue + netProfit; // 905 idle + 95 book + 4.5 net

      expect(nav).to.be.closeTo(expectedNav, ethers.parseEther("0.001"));
      console.log("✅ NAV reflects net-of-fee profit");
    });

    it("should return gross profit from getAccruedProfit()", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");
      const expectedProfit = expectedAssets - bookValue; // 5 USDe

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD);

      const accruedProfit = await vault.getAccruedProfit();

      // getAccruedProfit() returns GROSS profit (before fee)
      expect(accruedProfit).to.be.closeTo(expectedProfit, ethers.parseEther("0.001"));
      console.log("✅ getAccruedProfit() returns gross profit (not net)");
    });
  });

  describe("Fee Transfer on Position Claim", function () {
    it("should transfer fee to feeRecipient when position claimed", async function () {
      // Setup position
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD + 1);

      const feeRecipientBalanceBefore = await usde.balanceOf(feeRecipient.address);

      // Claim via internal function (test harness)
      await vault.claimPositionForTesting(0);

      const feeRecipientBalanceAfter = await usde.balanceOf(feeRecipient.address);

      // Calculate expected fee: 10% of 5 USDe profit = 0.5 USDe
      const realizedProfit = expectedAssets - bookValue;
      const expectedFee = (realizedProfit * 1000n) / 10000n; // 10% fee

      // Verify fee transferred to recipient
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(expectedFee);

      console.log("✅ Fee transferred to feeRecipient:", ethers.formatEther(expectedFee), "USDe");
    });

    it("should emit FeeCollected event", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD + 1);

      const realizedProfit = expectedAssets - bookValue;
      const expectedFee = (realizedProfit * 1000n) / 10000n;

      await expect(vault.claimPositionForTesting(0))
        .to.emit(vault, "FeeCollected")
        .withArgs(0, expectedFee, realizedProfit);

      console.log("✅ FeeCollected event emitted with correct values");
    });

    it("should update totalFeesCollected", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD + 1);

      const totalFeesCollectedBefore = await vault.totalFeesCollected();
      expect(totalFeesCollectedBefore).to.equal(0);

      await vault.claimPositionForTesting(0);

      const totalFeesCollectedAfter = await vault.totalFeesCollected();
      const realizedProfit = expectedAssets - bookValue;
      const expectedFee = (realizedProfit * 1000n) / 10000n;

      expect(totalFeesCollectedAfter).to.equal(expectedFee);
      console.log("✅ totalFeesCollected updated:", ethers.formatEther(expectedFee), "USDe");
    });
  });

  describe("NAV Invariant Verification", function () {
    it("should maintain NAV invariant: vault_balance_after_claim == NAV_before_claim", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD);

      // Capture NAV BEFORE claim
      const navBeforeClaim = await vault.totalAssets();
      console.log("NAV before claim:", ethers.formatEther(navBeforeClaim), "USDe");

      // Claim position (sUsde.unstake() will transfer expectedAssets to vault)
      await vault.claimPositionForTesting(0);

      // Verify vault balance AFTER claim matches NAV prediction
      const vaultBalanceAfterClaim = await usde.balanceOf(vaultAddress);
      console.log("Vault balance after claim:", ethers.formatEther(vaultBalanceAfterClaim), "USDe");

      // INVARIANT: vault balance after claim should equal NAV before claim
      // (because NAV included net-of-fee profit, and actual fee was transferred)
      expect(vaultBalanceAfterClaim).to.be.closeTo(navBeforeClaim, ethers.parseEther("0.001"));
      console.log("✅ NAV INVARIANT MAINTAINED");
    });
  });

  describe("Edge Cases", function () {
    it("should not collect fee when performanceFee is 0", async function () {
      // Set fee to 0
      await vault.connect(owner).setPerformanceFee(0);

      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD + 1);

      const feeRecipientBalanceBefore = await usde.balanceOf(feeRecipient.address);

      await vault.claimPositionForTesting(0);

      const feeRecipientBalanceAfter = await usde.balanceOf(feeRecipient.address);

      // No fee collected
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore);
      console.log("✅ No fee collected when performanceFee = 0");
    });

    it("should not collect fee when position has no profit", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("100");
      const expectedAssets = ethers.parseEther("100"); // No profit

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      await time.increase(COOLDOWN_PERIOD + 1);

      const feeRecipientBalanceBefore = await usde.balanceOf(feeRecipient.address);

      await vault.claimPositionForTesting(0);

      const feeRecipientBalanceAfter = await usde.balanceOf(feeRecipient.address);

      // No fee collected (no profit)
      expect(feeRecipientBalanceAfter).to.equal(feeRecipientBalanceBefore);
      console.log("✅ No fee collected when realizedProfit = 0");
    });
  });
});
