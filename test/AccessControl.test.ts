import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ArbitrageVault, MockERC20, MockStakedUSDe } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Access Control & Parameter Management (Phase 3)", function () {
  const COOLDOWN_DURATION = 7 * 24 * 60 * 60; // 7 days

  // Fixture to deploy vault
  async function deployVaultFixture() {
    const [owner, user1, keeper1, keeper2, feeRecipient]: HardhatEthersSigner[] = await ethers.getSigners();

    // Deploy mock USDe token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const usdeToken: MockERC20 = await MockERC20Factory.deploy("USDe", "USDe", 18);
    await usdeToken.waitForDeployment();

    // Deploy mock sUSDe token
    const MockStakedUSDeFactory = await ethers.getContractFactory("MockStakedUSDe");
    const stakedUsde: MockStakedUSDe = await MockStakedUSDeFactory.deploy(
      await usdeToken.getAddress(),
      COOLDOWN_DURATION
    );
    await stakedUsde.waitForDeployment();

    // Deploy ArbitrageVault
    const ArbitrageVaultFactory = await ethers.getContractFactory("ArbitrageVault");
    const vault: ArbitrageVault = await ArbitrageVaultFactory.deploy(
      await usdeToken.getAddress(),
      await stakedUsde.getAddress(),
      feeRecipient.address
    );
    await vault.waitForDeployment();

    return { vault, usdeToken, stakedUsde, owner, user1, keeper1, keeper2, feeRecipient };
  }

  describe("Initialization", function () {
    it("Should initialize with correct default parameters", async function () {
      const { vault, feeRecipient } = await loadFixture(deployVaultFixture);

      expect(await vault.performanceFee()).to.equal(1000); // 10%
      expect(await vault.feeRecipient()).to.equal(feeRecipient.address);
      expect(await vault.minProfitThreshold()).to.equal(10); // 0.1%
    });

    it("Should have correct constants", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      expect(await vault.MAX_PERFORMANCE_FEE()).to.equal(5000); // 50%
      expect(await vault.BASIS_POINTS()).to.equal(10000); // 100%
    });
  });

  describe("Keeper Management", function () {
    it("Should allow owner to add keeper", async function () {
      const { vault, owner, keeper1 } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(owner).addKeeper(keeper1.address))
        .to.emit(vault, "KeeperAdded")
        .withArgs(keeper1.address);

      expect(await vault.isKeeper(keeper1.address)).to.be.true;
    });

    it("Should allow owner to remove keeper", async function () {
      const { vault, owner, keeper1 } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).addKeeper(keeper1.address);

      await expect(vault.connect(owner).removeKeeper(keeper1.address))
        .to.emit(vault, "KeeperRemoved")
        .withArgs(keeper1.address);

      expect(await vault.isKeeper(keeper1.address)).to.be.false;
    });

    it("Should revert if non-owner tries to add keeper", async function () {
      const { vault, user1, keeper1 } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(user1).addKeeper(keeper1.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if non-owner tries to remove keeper", async function () {
      const { vault, owner, user1, keeper1 } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).addKeeper(keeper1.address);

      await expect(
        vault.connect(user1).removeKeeper(keeper1.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if adding zero address as keeper", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).addKeeper(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid keeper address");
    });

    it("Should revert if adding already existing keeper", async function () {
      const { vault, owner, keeper1 } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).addKeeper(keeper1.address);

      await expect(
        vault.connect(owner).addKeeper(keeper1.address)
      ).to.be.revertedWith("Already a keeper");
    });

    it("Should revert if removing non-keeper", async function () {
      const { vault, owner, keeper1 } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).removeKeeper(keeper1.address)
      ).to.be.revertedWith("Not a keeper");
    });

    it("Should allow multiple keepers", async function () {
      const { vault, owner, keeper1, keeper2 } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).addKeeper(keeper1.address);
      await vault.connect(owner).addKeeper(keeper2.address);

      expect(await vault.isKeeper(keeper1.address)).to.be.true;
      expect(await vault.isKeeper(keeper2.address)).to.be.true;
    });
  });

  describe("Performance Fee Management", function () {
    it("Should allow owner to update performance fee", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      const newFee = 2000; // 20%
      await expect(vault.connect(owner).setPerformanceFee(newFee))
        .to.emit(vault, "PerformanceFeeUpdated")
        .withArgs(1000, newFee);

      expect(await vault.performanceFee()).to.equal(newFee);
    });

    it("Should revert if non-owner tries to update fee", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(user1).setPerformanceFee(2000)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if fee exceeds maximum (50%)", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).setPerformanceFee(5001)
      ).to.be.revertedWith("Fee exceeds maximum");
    });

    it("Should allow setting fee to 0%", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).setPerformanceFee(0);
      expect(await vault.performanceFee()).to.equal(0);
    });

    it("Should allow setting fee to maximum (50%)", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).setPerformanceFee(5000);
      expect(await vault.performanceFee()).to.equal(5000);
    });
  });

  describe("Fee Recipient Management", function () {
    it("Should allow owner to update fee recipient", async function () {
      const { vault, owner, user1, feeRecipient } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(owner).setFeeRecipient(user1.address))
        .to.emit(vault, "FeeRecipientUpdated")
        .withArgs(feeRecipient.address, user1.address);

      expect(await vault.feeRecipient()).to.equal(user1.address);
    });

    it("Should revert if non-owner tries to update recipient", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(user1).setFeeRecipient(user1.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if setting recipient to zero address", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid recipient address");
    });
  });

  describe("Minimum Profit Threshold Management", function () {
    it("Should allow owner to update min profit threshold", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      const newThreshold = 50; // 0.5%
      await expect(vault.connect(owner).setMinProfitThreshold(newThreshold))
        .to.emit(vault, "MinProfitThresholdUpdated")
        .withArgs(10, newThreshold);

      expect(await vault.minProfitThreshold()).to.equal(newThreshold);
    });

    it("Should revert if non-owner tries to update threshold", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(user1).setMinProfitThreshold(50)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if threshold exceeds 100%", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await expect(
        vault.connect(owner).setMinProfitThreshold(10001)
      ).to.be.revertedWith("Threshold exceeds 100%");
    });

    it("Should allow setting threshold to 0", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).setMinProfitThreshold(0);
      expect(await vault.minProfitThreshold()).to.equal(0);
    });

    it("Should allow setting threshold to 100%", async function () {
      const { vault, owner } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).setMinProfitThreshold(10000);
      expect(await vault.minProfitThreshold()).to.equal(10000);
    });
  });
});
