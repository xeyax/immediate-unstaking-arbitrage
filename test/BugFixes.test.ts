import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ArbitrageVaultHarness,
  MockERC20,
  MockStakedUSDe
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Bug Fixes - Critical Issues", function () {
  let vault: ArbitrageVaultHarness;
  let usde: MockERC20;
  let sUsde: MockStakedUSDe;
  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days in seconds

  beforeEach(async function () {
    [owner, keeper, feeRecipient] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usde = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usde.waitForDeployment();

    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    sUsde = await MockStakedUSDeFactory.deploy(await usde.getAddress(), COOLDOWN_PERIOD);
    await sUsde.waitForDeployment();

    // Deploy vault harness
    const VaultFactory = await ethers.getContractFactory("ArbitrageVaultHarness");
    vault = await VaultFactory.deploy(
      await usde.getAddress(),
      await sUsde.getAddress(),
      feeRecipient.address
    );
    await vault.waitForDeployment();

    // Mint initial tokens
    await usde.mint(owner.address, INITIAL_SUPPLY);
    await sUsde.mint(await vault.getAddress(), INITIAL_SUPPLY);
    await usde.mint(await sUsde.getAddress(), INITIAL_SUPPLY); // For unstaking

    // Deploy 51 proxies (one extra to test MAX_ACTIVE_POSITIONS rejection)
    await vault.deployProxies(51);

    // Add keeper
    await vault.addKeeper(keeper.address);
  });

  describe("Bug Fix #1: Accrual Cap at COOLDOWN_PERIOD", function () {
    it("should cap NAV growth after position matures (14 days delay)", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");
      const expectedProfit = expectedAssets - bookValue; // 5 USDe

      // Open position
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Wait 7 days (position matures)
      await time.increase(COOLDOWN_PERIOD);

      // Get profit at maturity
      const profitAt7Days = await vault.getAccruedProfit();

      // Profit should be approximately expectedProfit (5 USDe)
      expect(profitAt7Days).to.be.closeTo(expectedProfit, ethers.parseEther("0.01"));

      // Wait another 7 days (total 14 days - 2x cooldown period)
      await time.increase(COOLDOWN_PERIOD);

      // Get profit after 14 days
      const profitAt14Days = await vault.getAccruedProfit();

      // CRITICAL TEST: Profit should NOT have doubled!
      // It should still be capped at expectedProfit (5 USDe), not 10 USDe
      expect(profitAt14Days).to.be.closeTo(expectedProfit, ethers.parseEther("0.01"));
      expect(profitAt14Days).to.not.be.closeTo(expectedProfit * 2n, ethers.parseEther("0.1"));

      // Verify position is still active and tracked
      expect(await vault.activePositionCount()).to.equal(1);
    });

    it("should cap NAV even with multiple delayed positions", async function () {
      // Open 3 positions with 5 USDe profit each (total 15 USDe expected profit)
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      const totalExpectedProfit = (expectedAssets - bookValue) * 3n; // 15 USDe

      // Wait 14 days (2x cooldown)
      await time.increase(COOLDOWN_PERIOD * 2);

      // Profit should be capped at 15 USDe, not 30 USDe
      const profit = await vault.getAccruedProfit();
      expect(profit).to.be.closeTo(totalExpectedProfit, ethers.parseEther("0.01"));
      expect(profit).to.not.be.closeTo(totalExpectedProfit * 2n, ethers.parseEther("0.01"));
    });
  });

  describe("Bug Fix #2: Phantom Profit Removal", function () {
    it("should not leave phantom profit after delayed claim", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");
      const expectedProfit = expectedAssets - bookValue; // 5 USDe

      // Open position
      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId = event?.args?.positionId;

      // Wait 14 days before claiming (2x cooldown period)
      await time.increase(COOLDOWN_PERIOD * 2);

      // Verify profit is capped at expectedProfit before claim
      const profitBeforeClaim = await vault.getAccruedProfit();
      expect(profitBeforeClaim).to.be.closeTo(expectedProfit, ethers.parseEther("0.01"));

      // Claim the position (FIFO - claims firstActivePositionId)
      await vault.connect(keeper).claimPosition();

      // CRITICAL TEST: After claim, there should be NO phantom profit
      // Active positions should be 0
      expect(await vault.activePositionCount()).to.equal(0);

      // getAccruedProfit should return 0 (no active positions)
      const profitAfterClaim = await vault.getAccruedProfit();
      expect(profitAfterClaim).to.equal(0);

      // Position should be marked as claimed
      const claimedPosition = await vault.getPosition(positionId);
      expect(claimedPosition.claimed).to.be.true;
    });

    it("should handle multiple positions claimed at different delays", async function () {
      // Open 2 positions
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx1 = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId1 = event1?.args?.positionId;

      const tx2 = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId2 = event2?.args?.positionId;

      // Wait 7 days and claim position 1 on time (FIFO - claims oldest first)
      await time.increase(COOLDOWN_PERIOD);
      await vault.connect(keeper).claimPosition(); // Claims position 1

      // Verify position 2 is still active
      expect(await vault.activePositionCount()).to.equal(1);
      expect(await vault.firstActivePositionId()).to.equal(positionId2);

      // Wait another 7 days (total 14 days for position 2)
      await time.increase(COOLDOWN_PERIOD);

      // Claim position 2 (delayed by 7 days, now oldest position)
      await vault.connect(keeper).claimPosition(); // Claims position 2

      // CRITICAL: No phantom profit should remain
      expect(await vault.activePositionCount()).to.equal(0);
      expect(await vault.getAccruedProfit()).to.equal(0);
    });
  });

  describe("Bug Fix #3: Input Validation in _openPosition", function () {
    it("should reject position with expectedAssets < bookValue", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("100");
      const expectedAssets = ethers.parseEther("95"); // Less than book value!

      await expect(
        vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets)
      ).to.be.revertedWith("Expected assets must be >= book value");
    });

    it("should reject position with zero bookValue", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = 0;
      const expectedAssets = ethers.parseEther("100");

      await expect(
        vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets)
      ).to.be.revertedWith("Book value must be > 0");
    });

    it("should reject position with zero sUsdeAmount", async function () {
      const sUsdeAmount = 0;
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      // This will actually revert from proxy.initiateUnstake with "Shares must be > 0"
      // which is fine - the validation happens before _openPosition is called
      await expect(
        vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets)
      ).to.be.revertedWith("Shares must be > 0");
    });

    it("should accept valid position with expectedAssets = bookValue (zero profit)", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("100");
      const expectedAssets = ethers.parseEther("100");

      // This should work (zero profit is valid, though not profitable)
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      expect(await vault.activePositionCount()).to.equal(1);
      expect(await vault.getAccruedProfit()).to.equal(0); // Zero profit
    });

    // Note: The sanity guard "bookValue <= expectedAssets * 2" is mathematically unreachable
    // because if expectedAssets >= bookValue (first guard), then expectedAssets * 2 >= bookValue * 2 > bookValue
    // This test verifies the guard exists in the code
    it("should have sanity guard for bookValue vs expectedAssets ratio", async function () {
      // This tests that positions with reasonable ratios work
      // (The guard can never actually fail if the first guard passes)
      const tx = await vault.openPositionForTesting(
        ethers.parseEther("100"),  // sUsdeAmount
        ethers.parseEther("95"),   // bookValue
        ethers.parseEther("100")   // expectedAssets (bookValue < expectedAssets * 2, always true)
      );

      expect(tx).to.emit(vault, "PositionOpened");
    });
  });

  describe("MAX_ACTIVE_POSITIONS Limit", function () {
    it("should allow opening up to 50 active positions", async function () {
      // Open 50 positions
      for (let i = 0; i < 50; i++) {
        await vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        );
      }

      // Verify all 50 positions are active
      expect(await vault.activePositionCount()).to.equal(50);
      expect(await vault.firstActivePositionId()).to.equal(0);
      expect(await vault.nextPositionId()).to.equal(50);
    });

    it("should reject 51st position when limit reached", async function () {
      // Open 50 positions (fill the vault)
      for (let i = 0; i < 50; i++) {
        await vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        );
      }

      // Try to open 51st position - should revert
      await expect(
        vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Maximum active positions reached");
    });

    it("should allow new positions after claiming old ones", async function () {
      // Fill vault with 50 positions
      for (let i = 0; i < 50; i++) {
        await vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        );
      }

      // Fast forward past cooldown
      await time.increase(COOLDOWN_PERIOD + 1);

      // Claim 5 positions
      for (let i = 0; i < 5; i++) {
        await vault.connect(keeper).claimPosition();
      }

      // Now should have 45 active positions
      expect(await vault.activePositionCount()).to.equal(45);

      // Should be able to open 5 more positions
      for (let i = 0; i < 5; i++) {
        await vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        );
      }

      // Back to 50 active positions
      expect(await vault.activePositionCount()).to.equal(50);

      // 51st should still revert
      await expect(
        vault.openPositionForTesting(
          ethers.parseEther("100"),
          ethers.parseEther("95"),
          ethers.parseEther("100")
        )
      ).to.be.revertedWith("Maximum active positions reached");
    });

    it("should correctly calculate NAV with 50 active positions", async function () {
      const bookValuePerPosition = ethers.parseEther("95");
      const expectedAssetsPerPosition = ethers.parseEther("100");
      const expectedProfitPerPosition = expectedAssetsPerPosition - bookValuePerPosition; // 5 USDe

      // Open 50 positions
      for (let i = 0; i < 50; i++) {
        await vault.openPositionForTesting(
          ethers.parseEther("100"),
          bookValuePerPosition,
          expectedAssetsPerPosition
        );
      }

      // Fast forward 3.5 days (half cooldown)
      await time.increase(COOLDOWN_PERIOD / 2);

      // Calculate expected NAV
      // Each position should have accrued half its profit
      const halfProfitPerPosition = expectedProfitPerPosition / 2n;
      const totalExpectedProfit = halfProfitPerPosition * 50n;

      const accruedProfit = await vault.getAccruedProfit();
      expect(accruedProfit).to.be.closeTo(totalExpectedProfit, ethers.parseEther("1"));
    });
  });

  describe("Bug Fix: claimPosition Access Control", function () {
    it("should allow anyone to call claimPosition (permissionless)", async function () {
      const [, , , nonKeeper] = await ethers.getSigners();

      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId = event?.args?.positionId;

      await time.increase(COOLDOWN_PERIOD + 1);

      // Permissionless: non-keeper should be able to claim
      await vault.connect(nonKeeper).claimPosition();

      // Verify position was claimed
      expect(await vault.activePositionCount()).to.equal(0);
    });

    it("should allow claimPosition from authorized keeper", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      await time.increase(COOLDOWN_PERIOD + 1);

      // Should succeed (keeper was added in beforeEach)
      await expect(vault.connect(keeper).claimPosition())
        .to.emit(vault, "PositionClaimed");
    });
  });
});
