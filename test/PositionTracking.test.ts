import { expect } from "chai";
import { ethers } from "hardhat";
import {
  ArbitrageVaultHarness,
  MockERC20,
  MockStakedUSDe
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("ArbitrageVault - Phase 4: Position Tracking & NAV Calculation", function () {
  let vault: ArbitrageVaultHarness;
  let usde: MockERC20;
  let sUsde: MockStakedUSDe;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let feeRecipient: SignerWithAddress;

  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const COOLDOWN_PERIOD = 7 * 24 * 60 * 60; // 7 days in seconds
  const BASIS_POINTS = 10000n;

  beforeEach(async function () {
    [owner, user1, user2, feeRecipient] = await ethers.getSigners();

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
    await usde.mint(user1.address, INITIAL_SUPPLY);
    await usde.mint(user2.address, INITIAL_SUPPLY);
    await sUsde.mint(await vault.getAddress(), INITIAL_SUPPLY);

    // Deploy proxies
    await vault.deployProxies(3);

    // Note: owner is automatically added as keeper in constructor
  });

  describe("Position Opening", function () {
    it("should open a position with correct state", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();

      // Get position ID from event
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;
      const positionId = event?.args?.positionId;

      // Check position data
      const position = await vault.getPosition(positionId);
      expect(position.sUsdeAmount).to.equal(sUsdeAmount);
      expect(position.bookValue).to.equal(bookValue);
      expect(position.expectedAssets).to.equal(expectedAssets);
      expect(position.claimed).to.be.false;
      expect(position.proxyContract).to.not.equal(ethers.ZeroAddress);

      // Check state variables
      expect(await vault.activePositionCount()).to.equal(1);
      expect(await vault.nextPositionId()).to.equal(1);
    });

    it("should emit PositionOpened event", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();

      // Check that PositionOpened event was emitted with correct values
      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;

      expect(event).to.not.be.undefined;
      expect(event?.args?.positionId).to.equal(0);
      expect(event?.args?.sUsdeAmount).to.equal(sUsdeAmount);
      expect(event?.args?.expectedAssets).to.equal(expectedAssets);
      expect(event?.args?.bookValue).to.equal(bookValue);
      // Just check proxy is not zero address
      expect(event?.args?.proxy).to.not.equal(ethers.ZeroAddress);
    });

    it("should increment active position count", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const countBefore = await vault.activePositionCount();
      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      const countAfter = await vault.activePositionCount();
      expect(countAfter).to.equal(countBefore + 1n);
    });

    it("should allocate and mark proxy as busy", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;
      const proxyAddress = event?.args?.proxy;

      expect(await vault.proxyBusy(proxyAddress)).to.be.true;
    });

    it("should handle multiple concurrent positions", async function () {
      // Open 3 positions
      await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      await vault.openPositionForTesting(
        ethers.parseEther("200"),
        ethers.parseEther("190"),
        ethers.parseEther("200")
      );
      await vault.openPositionForTesting(
        ethers.parseEther("150"),
        ethers.parseEther("145"),
        ethers.parseEther("150")
      );

      expect(await vault.activePositionCount()).to.equal(3);
      expect(await vault.nextPositionId()).to.equal(3);
    });
  });

  describe("Time-Weighted NAV Calculation", function () {
    beforeEach(async function () {
      // User1 deposits 1000 USDe
      await usde.connect(user1).approve(await vault.getAddress(), ethers.parseEther("1000"));
      await vault.connect(user1).deposit(ethers.parseEther("1000"), user1.address);
    });

    it("should calculate NAV correctly with no positions", async function () {
      const nav = await vault.totalAssets();
      expect(nav).to.equal(ethers.parseEther("1000"));
    });

    it("should calculate NAV correctly immediately after opening position", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Simulate spending bookValue by transferring USDe out of vault
      const vaultAddress = await vault.getAddress();
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]); // Give vault some ETH
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, bookValue);
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      // NAV should be: (1000 - 95) idle + 95 book value + minimal accrued ≈ 1000
      const nav = await vault.totalAssets();
      // Use closeTo to account for small time elapsed during test execution
      expect(nav).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("0.001"));
    });

    it("should accrue profit linearly over time", async function () {
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

      // Fast forward 1 day (1/7 of cooldown period)
      await time.increase(24 * 60 * 60);

      const nav = await vault.totalAssets();
      const accruedProfit = await vault.getAccruedProfit();

      // Should have accrued ~1/7 of the profit (5/7 ≈ 0.714 USDe)
      const expectedAccrual = expectedProfit / 7n;
      expect(accruedProfit).to.be.closeTo(expectedAccrual, ethers.parseEther("0.001"));

      // NAV = (1000 - 95) idle + 95 book value + ~0.714 accrued = 1000 + 0.714
      expect(nav).to.be.closeTo(
        ethers.parseEther("1000") + expectedAccrual,
        ethers.parseEther("0.001")
      );
    });

    it("should accrue full profit after cooldown period", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");
      const expectedProfit = expectedAssets - bookValue; // 5 USDe

      await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);

      // Fast forward full cooldown period
      await time.increase(COOLDOWN_PERIOD);

      const accruedProfit = await vault.getAccruedProfit();
      expect(accruedProfit).to.be.closeTo(expectedProfit, ethers.parseEther("0.001"));
    });

    it("should handle multiple positions with different accrual rates", async function () {
      // Position 1: 5 USDe profit
      await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );

      // Fast forward 1 day
      await time.increase(24 * 60 * 60);

      // Position 2: 10 USDe profit
      await vault.openPositionForTesting(
        ethers.parseEther("200"),
        ethers.parseEther("190"),
        ethers.parseEther("200")
      );

      // Fast forward another day
      await time.increase(24 * 60 * 60);

      const accruedProfit = await vault.getAccruedProfit();

      // Position 1 accrued for 2 days: 5 * (2/7) ≈ 1.43 USDe
      // Position 2 accrued for 1 day: 10 * (1/7) ≈ 1.43 USDe
      // Total: ~2.86 USDe
      expect(accruedProfit).to.be.closeTo(
        ethers.parseEther("2.857"),
        ethers.parseEther("0.01")
      );
    });
  });

  describe("Position Claiming", function () {
    let positionId: bigint;

    beforeEach(async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;
      positionId = event?.args?.positionId;
    });

    it("should reject claiming before cooldown period", async function () {
      await expect(vault.claimPosition())
        .to.be.revertedWith("Cooldown period not elapsed");
    });

    it("should reject claiming when no active positions", async function () {
      // First claim the position after cooldown
      await time.increase(COOLDOWN_PERIOD + 1);
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      // Now try to claim again with no positions
      await expect(vault.claimPosition())
        .to.be.revertedWith("No active positions");
    });

    it("should claim position successfully after cooldown", async function () {
      // Fast forward past cooldown
      await time.increase(COOLDOWN_PERIOD + 1);

      const position = await vault.getPosition(positionId);
      const proxyAddress = position.proxyContract;

      // Transfer expected USDe to MockStakedUSDe (it needs funds to pay out)
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));

      await expect(vault.claimPosition())
        .to.emit(vault, "PositionClaimed");

      // Check position is marked as claimed
      const updatedPosition = await vault.getPosition(positionId);
      expect(updatedPosition.claimed).to.be.true;

      // Check proxy is released
      expect(await vault.proxyBusy(proxyAddress)).to.be.false;

      // Check active position count decreased
      expect(await vault.activePositionCount()).to.equal(0);
    });

    it("should reject claiming already claimed position", async function () {
      await time.increase(COOLDOWN_PERIOD + 1);

      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      // Try to claim again - should fail with "No active positions"
      await expect(vault.claimPosition())
        .to.be.revertedWith("No active positions");
    });

    it("should remove position from active tracking when claiming", async function () {
      await time.increase(COOLDOWN_PERIOD + 1);

      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));

      const countBefore = await vault.activePositionCount();
      expect(countBefore).to.equal(1);

      await vault.claimPosition();

      const countAfter = await vault.activePositionCount();
      expect(countAfter).to.equal(0);

      // getAccruedProfit should return 0 (no active positions)
      const profit = await vault.getAccruedProfit();
      expect(profit).to.equal(0);
    });

    it("should decrease active position count when claiming", async function () {
      await time.increase(COOLDOWN_PERIOD + 1);

      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));

      const countBefore = await vault.activePositionCount();
      await vault.claimPosition();
      const countAfter = await vault.activePositionCount();

      expect(countBefore - countAfter).to.equal(1);
    });

    it("should calculate realized profit correctly", async function () {
      await time.increase(COOLDOWN_PERIOD + 1);

      const position = await vault.getPosition(positionId);

      // Note: MockStakedUSDe unstake() transfers cooldown.underlyingAmount (which equals position.expectedAssets)
      // not the full balance, so minting extra doesn't change what's received
      await usde.mint(await sUsde.getAddress(), position.expectedAssets);

      const tx = await vault.claimPosition();
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionClaimed"
      ) as any;

      // Realized profit = expectedAssets - bookValue = 100 - 95 = 5
      const expectedProfit = position.expectedAssets - position.bookValue;
      expect(event?.args?.profit).to.equal(expectedProfit);
      expect(event?.args?.usdeReceived).to.equal(position.expectedAssets);
    });
  });

  describe("View Functions", function () {
    it("should return position details via getPosition", async function () {
      const sUsdeAmount = ethers.parseEther("100");
      const bookValue = ethers.parseEther("95");
      const expectedAssets = ethers.parseEther("100");

      const tx = await vault.openPositionForTesting(sUsdeAmount, bookValue, expectedAssets);
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;
      const positionId = event?.args?.positionId;

      const position = await vault.getPosition(positionId);
      expect(position.sUsdeAmount).to.equal(sUsdeAmount);
      expect(position.bookValue).to.equal(bookValue);
      expect(position.expectedAssets).to.equal(expectedAssets);
    });

    it("should return current NAV via totalAssets", async function () {
      await usde.connect(user1).approve(await vault.getAddress(), ethers.parseEther("1000"));
      await vault.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const nav = await vault.totalAssets();
      expect(nav).to.equal(ethers.parseEther("1000"));
    });

    it("should check position claimability via isPositionClaimable", async function () {
      const tx = await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      const receipt = await tx.wait();

      const event = receipt?.logs.find(
        (log: any) => log.eventName === "PositionOpened"
      ) as any;
      const positionId = event?.args?.positionId;

      // Should not be claimable before cooldown
      expect(await vault.isPositionClaimable(positionId)).to.be.false;

      // Fast forward past cooldown
      await time.increase(COOLDOWN_PERIOD + 1);

      // Should be claimable now
      expect(await vault.isPositionClaimable(positionId)).to.be.true;

      // Claim position
      const position = await vault.getPosition(positionId);
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      // Should not be claimable after claiming
      expect(await vault.isPositionClaimable(positionId)).to.be.false;
    });

    it("should return accrued profit via getAccruedProfit", async function () {
      await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );

      const profitBefore = await vault.getAccruedProfit();
      expect(profitBefore).to.equal(0);

      await time.increase(COOLDOWN_PERIOD / 2); // Half the cooldown

      const profitAfter = await vault.getAccruedProfit();
      expect(profitAfter).to.be.closeTo(
        ethers.parseEther("2.5"), // Half of 5 USDe profit
        ethers.parseEther("0.01")
      );
    });
  });

  describe("Integration Tests", function () {
    it.skip("should handle full position lifecycle with deposits and withdrawals", async function () {
      // User1 deposits 1000 USDe
      await usde.connect(user1).approve(await vault.getAddress(), ethers.parseEther("1000"));
      await vault.connect(user1).deposit(ethers.parseEther("1000"), user1.address);

      const sharesBefore = await vault.balanceOf(user1.address);

      // Open position (95 USDe spent, 100 USDe expected)
      const tx = await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      const receipt = await tx.wait();
      const event = receipt?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId = event?.args?.positionId;

      // Simulate USDe being spent (transfer out of vault to simulate buying sUSDe)
      // We need to do this as a transfer FROM the vault's address
      // In production, this would be done via DEX swap in executeArbitrage
      const vaultAddress = await vault.getAddress();
      // Give vault some ETH for gas and impersonate it
      await ethers.provider.send("hardhat_setBalance", [vaultAddress, "0x56BC75E2D63100000"]);
      await ethers.provider.send("hardhat_impersonateAccount", [vaultAddress]);
      const vaultSigner = await ethers.getSigner(vaultAddress);
      await usde.connect(vaultSigner).transfer(owner.address, ethers.parseEther("95"));
      await ethers.provider.send("hardhat_stopImpersonatingAccount", [vaultAddress]);

      // Fast forward 3.5 days (half cooldown)
      await time.increase(COOLDOWN_PERIOD / 2);

      // NAV should have increased due to accrual
      const navMidway = await vault.totalAssets();
      expect(navMidway).to.be.gt(ethers.parseEther("1000"));
      expect(navMidway).to.be.closeTo(ethers.parseEther("1002.5"), ethers.parseEther("0.01"));

      // User2 deposits 500 USDe (at higher NAV)
      await usde.connect(user2).approve(await vault.getAddress(), ethers.parseEther("500"));
      await vault.connect(user2).deposit(ethers.parseEther("500"), user2.address);

      const shares2 = await vault.balanceOf(user2.address);
      expect(shares2).to.be.lt(ethers.parseEther("500")); // Gets fewer shares due to higher NAV

      // Fast forward remaining cooldown
      await time.increase(COOLDOWN_PERIOD / 2 + 1);

      // Claim position
      const position = await vault.getPosition(positionId);
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      // Final NAV should reflect full profit
      const navFinal = await vault.totalAssets();
      expect(navFinal).to.be.closeTo(
        ethers.parseEther("1000") - ethers.parseEther("95") + // Initial - spent
        ethers.parseEther("500") + // User2 deposit
        ethers.parseEther("100"), // Claimed USDe
        ethers.parseEther("0.01")
      );

      // User1 should be able to withdraw more than deposited (due to profit share)
      const maxWithdraw = await vault.maxWithdraw(user1.address);
      expect(maxWithdraw).to.be.gt(ethers.parseEther("1000"));
    });

    it("should handle multiple positions maturing at different times (FIFO)", async function () {
      // Open 3 positions with 1 day gaps
      const tx1 = await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      const receipt1 = await tx1.wait();
      const event1 = receipt1?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId1 = event1?.args?.positionId;

      await time.increase(24 * 60 * 60); // 1 day

      const tx2 = await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      const receipt2 = await tx2.wait();
      const event2 = receipt2?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId2 = event2?.args?.positionId;

      await time.increase(24 * 60 * 60); // 1 day

      const tx3 = await vault.openPositionForTesting(
        ethers.parseEther("100"),
        ethers.parseEther("95"),
        ethers.parseEther("100")
      );
      const receipt3 = await tx3.wait();
      const event3 = receipt3?.logs.find((log: any) => log.eventName === "PositionOpened") as any;
      const positionId3 = event3?.args?.positionId;

      // Fast forward to when first position can be claimed
      await time.increase(COOLDOWN_PERIOD - 2 * 24 * 60 * 60 + 1);

      // Position 1 should be claimable
      expect(await vault.isPositionClaimable(positionId1)).to.be.true;
      expect(await vault.isPositionClaimable(positionId2)).to.be.false;
      expect(await vault.isPositionClaimable(positionId3)).to.be.false;

      // Check first active position is position 1
      expect(await vault.firstActivePositionId()).to.equal(positionId1);

      // Claim position 1 (FIFO - must claim oldest first)
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      expect(await vault.activePositionCount()).to.equal(2);

      // firstActivePositionId should now be position 2
      expect(await vault.firstActivePositionId()).to.equal(positionId2);

      // Fast forward 1 more day
      await time.increase(24 * 60 * 60);

      // Position 2 should now be claimable
      expect(await vault.isPositionClaimable(positionId2)).to.be.true;
      expect(await vault.isPositionClaimable(positionId3)).to.be.false;

      // Claim position 2
      await usde.mint(await sUsde.getAddress(), ethers.parseEther("100"));
      await vault.claimPosition();

      expect(await vault.activePositionCount()).to.equal(1);
      expect(await vault.firstActivePositionId()).to.equal(positionId3);
    });
  });
});
