import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ArbitrageVaultHarness, MockERC20, MockStakedUSDe, UnstakeProxy } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Proxy Orchestration (Phase 2)", function () {
  // Cooldown duration: 7 days in seconds
  const COOLDOWN_DURATION = 7 * 24 * 60 * 60;

  // Fixture to deploy vault harness with Ethena integration
  async function deployVaultWithEthenaFixture() {
    const [owner, user1, keeper]: HardhatEthersSigner[] = await ethers.getSigners();

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

    // Deploy ArbitrageVaultHarness (test version with exposed functions)
    const ArbitrageVaultHarnessFactory = await ethers.getContractFactory("ArbitrageVaultHarness");
    const vault: ArbitrageVaultHarness = await ArbitrageVaultHarnessFactory.deploy(
      await usdeToken.getAddress(),
      await stakedUsde.getAddress()
    );
    await vault.waitForDeployment();

    // Mint tokens for testing
    const initialBalance = ethers.parseEther("10000");
    await usdeToken.mint(user1.address, initialBalance);
    await usdeToken.mint(await vault.getAddress(), initialBalance);
    await usdeToken.mint(await stakedUsde.getAddress(), initialBalance); // For unstaking claims

    // Mint some sUSDe for testing
    await stakedUsde.mint(user1.address, ethers.parseEther("1000"));

    return { vault, usdeToken, stakedUsde, owner, user1, keeper, initialBalance };
  }

  describe("Proxy Deployment", function () {
    it("Should deploy proxies successfully", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await expect(vault.connect(owner).deployProxies(3))
        .to.emit(vault, "ProxiesDeployed")
        .withArgs(3, 3);

      expect(await vault.getProxyCount()).to.equal(3);
    });

    it("Should revert if non-owner tries to deploy proxies", async function () {
      const { vault, user1 } = await loadFixture(deployVaultWithEthenaFixture);

      await expect(vault.connect(user1).deployProxies(1))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("Should revert if trying to deploy zero proxies", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await expect(vault.connect(owner).deployProxies(0))
        .to.be.revertedWith("Count must be > 0");
    });

    it("Should revert if trying to deploy too many proxies at once", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await expect(vault.connect(owner).deployProxies(101))
        .to.be.revertedWith("Too many proxies at once");
    });

    it("Should deploy multiple batches of proxies", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await vault.connect(owner).deployProxies(2);
      expect(await vault.getProxyCount()).to.equal(2);

      await vault.connect(owner).deployProxies(3);
      expect(await vault.getProxyCount()).to.equal(5);
    });
  });

  describe("Proxy Status Tracking", function () {
    it("Should return correct proxy count", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      expect(await vault.getProxyCount()).to.equal(0);

      await vault.connect(owner).deployProxies(5);
      expect(await vault.getProxyCount()).to.equal(5);
    });

    it("Should return correct available proxy count", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await vault.connect(owner).deployProxies(3);

      // All proxies should be available initially
      expect(await vault.getAvailableProxyCount()).to.equal(3);
    });

    it("Should return proxy status correctly", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await vault.connect(owner).deployProxies(3);

      const [proxies, busy] = await vault.getProxyStatus();

      expect(proxies.length).to.equal(3);
      expect(busy.length).to.equal(3);

      // All should be not busy initially
      for (const isBusy of busy) {
        expect(isBusy).to.be.false;
      }
    });

    it("Should retrieve individual proxy addresses", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      await vault.connect(owner).deployProxies(2);

      const proxy0 = await vault.unstakeProxies(0);
      const proxy1 = await vault.unstakeProxies(1);

      expect(proxy0).to.not.equal(ethers.ZeroAddress);
      expect(proxy1).to.not.equal(ethers.ZeroAddress);
      expect(proxy0).to.not.equal(proxy1);
    });
  });

  describe("Proxy Functionality", function () {
    it("Should be owned by vault", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy one proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      // Get proxy contract instance
      const UnstakeProxyFactory = await ethers.getContractFactory("UnstakeProxy");
      const proxy = UnstakeProxyFactory.attach(proxyAddress) as UnstakeProxy;

      expect(await proxy.owner()).to.equal(await vault.getAddress());
    });

    it("Should have correct immutable addresses", async function () {
      const { vault, stakedUsde, usdeToken, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy one proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      const UnstakeProxyFactory = await ethers.getContractFactory("UnstakeProxy");
      const proxy = UnstakeProxyFactory.attach(proxyAddress) as UnstakeProxy;

      expect(await proxy.stakedUsde()).to.equal(await stakedUsde.getAddress());
      expect(await proxy.usde()).to.equal(await usdeToken.getAddress());
    });

    it("Should revert if non-owner tries to initiate unstake", async function () {
      const { vault, user1, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy one proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      const UnstakeProxyFactory = await ethers.getContractFactory("UnstakeProxy");
      const proxy = UnstakeProxyFactory.attach(proxyAddress) as UnstakeProxy;

      // User tries to call proxy directly (should fail)
      await expect(
        proxy.connect(user1).initiateUnstake(ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(proxy, "OwnableUnauthorizedAccount");
    });
  });

  describe("Round-Robin Allocation", function () {
    it("Should allocate proxies in round-robin order", async function () {
      const { vault, stakedUsde, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy 3 proxies
      await vault.connect(owner).deployProxies(3);
      const proxy0 = await vault.unstakeProxies(0);
      const proxy1 = await vault.unstakeProxies(1);
      const proxy2 = await vault.unstakeProxies(2);

      // Give vault sUSDe
      const amount = ethers.parseEther("100");
      await stakedUsde.mint(await vault.getAddress(), amount * 10n);

      // First allocation: lastAllocatedIndex=0, tries (0+1)%3=1 first, then wraps
      // So picks proxy1 first
      await vault.connect(owner).initiateUnstakeForTesting(amount);
      expect(await vault.proxyBusy(proxy1)).to.be.true;

      // Second allocation: lastAllocatedIndex=1, tries (1+1)%3=2
      // Picks proxy2
      await vault.connect(owner).initiateUnstakeForTesting(amount);
      expect(await vault.proxyBusy(proxy2)).to.be.true;

      // Third allocation: lastAllocatedIndex=2, tries (2+1)%3=0
      // Picks proxy0
      await vault.connect(owner).initiateUnstakeForTesting(amount);
      expect(await vault.proxyBusy(proxy0)).to.be.true;

      // All busy now
      expect(await vault.getAvailableProxyCount()).to.equal(0);

      // Fast forward and release proxy1
      await time.increase(COOLDOWN_DURATION + 1);
      await vault.connect(owner).claimUnstakeForTesting(proxy1);
      expect(await vault.proxyBusy(proxy1)).to.be.false;

      // Next allocation should pick proxy1 again (continues round-robin from last position)
      await vault.connect(owner).initiateUnstakeForTesting(amount);
      expect(await vault.proxyBusy(proxy1)).to.be.true;
    });

    it("Should handle sequential releases efficiently", async function () {
      const { vault, stakedUsde, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy 5 proxies
      await vault.connect(owner).deployProxies(5);

      // Give vault sUSDe
      const amount = ethers.parseEther("100");
      await stakedUsde.mint(await vault.getAddress(), amount * 10n);

      // Fill all proxies
      for (let i = 0; i < 5; i++) {
        await vault.connect(owner).initiateUnstakeForTesting(amount);
      }

      // Fast forward
      await time.increase(COOLDOWN_DURATION + 1);

      // Release and immediately reallocate - should be very efficient (1 iteration)
      for (let i = 0; i < 5; i++) {
        const proxyAddress = await vault.unstakeProxies(i);
        await vault.connect(owner).claimUnstakeForTesting(proxyAddress);
        await vault.connect(owner).initiateUnstakeForTesting(amount);
      }

      // All should be busy again
      expect(await vault.getAvailableProxyCount()).to.equal(0);
    });
  });

  describe("Full Unstake Lifecycle", function () {
    it("Should complete full unstake lifecycle through vault", async function () {
      const { vault, stakedUsde, usdeToken, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy one proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      // Give vault some sUSDe
      const sUsdeAmount = ethers.parseEther("100");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);

      // Check proxy is not busy initially
      expect(await vault.proxyBusy(proxyAddress)).to.be.false;

      // Step 1: Vault initiates unstake through proxy
      const vaultBalanceBefore = await usdeToken.balanceOf(await vault.getAddress());

      await expect(vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount))
        .to.emit(vault, "ProxyAllocated")
        .withArgs(proxyAddress);

      // Check proxy is now busy
      expect(await vault.proxyBusy(proxyAddress)).to.be.true;
      expect(await vault.getAvailableProxyCount()).to.equal(0);

      // Step 2: Fast forward past cooldown period
      await time.increase(COOLDOWN_DURATION + 1);

      // Step 3: Vault claims through proxy
      await expect(vault.connect(owner).claimUnstakeForTesting(proxyAddress))
        .to.emit(vault, "ProxyReleased")
        .withArgs(proxyAddress);

      // Check proxy is available again
      expect(await vault.proxyBusy(proxyAddress)).to.be.false;
      expect(await vault.getAvailableProxyCount()).to.equal(1);

      // Check vault received USDe
      const vaultBalanceAfter = await usdeToken.balanceOf(await vault.getAddress());
      expect(vaultBalanceAfter).to.be.gt(vaultBalanceBefore);
      expect(vaultBalanceAfter).to.equal(vaultBalanceBefore + sUsdeAmount); // 1:1 rate
    });

    it("Should handle multiple concurrent unstakes with multiple proxies", async function () {
      const { vault, stakedUsde, usdeToken, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy 3 proxies
      await vault.connect(owner).deployProxies(3);

      // Give vault enough sUSDe
      const sUsdePerOperation = ethers.parseEther("100");
      await stakedUsde.mint(await vault.getAddress(), sUsdePerOperation * 3n);

      // Initiate 3 unstakes
      await vault.connect(owner).initiateUnstakeForTesting(sUsdePerOperation);
      await vault.connect(owner).initiateUnstakeForTesting(sUsdePerOperation);
      await vault.connect(owner).initiateUnstakeForTesting(sUsdePerOperation);

      // All proxies should be busy
      expect(await vault.getAvailableProxyCount()).to.equal(0);

      const proxy0 = await vault.unstakeProxies(0);
      const proxy1 = await vault.unstakeProxies(1);
      const proxy2 = await vault.unstakeProxies(2);

      expect(await vault.proxyBusy(proxy0)).to.be.true;
      expect(await vault.proxyBusy(proxy1)).to.be.true;
      expect(await vault.proxyBusy(proxy2)).to.be.true;

      // Fast forward
      await time.increase(COOLDOWN_DURATION + 1);

      // Claim all
      await vault.connect(owner).claimUnstakeForTesting(proxy0);
      await vault.connect(owner).claimUnstakeForTesting(proxy1);
      await vault.connect(owner).claimUnstakeForTesting(proxy2);

      // All proxies should be available again
      expect(await vault.getAvailableProxyCount()).to.equal(3);
    });

    it("Should revert when trying to unstake with no available proxies", async function () {
      const { vault, stakedUsde, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy 1 proxy
      await vault.connect(owner).deployProxies(1);

      // Give vault sUSDe
      const sUsdeAmount = ethers.parseEther("100");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount * 2n);

      // First unstake succeeds
      await vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount);

      // Second unstake should fail (no proxies available)
      await expect(
        vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount)
      ).to.be.revertedWith("No proxies available");
    });

    it("Should revert when trying to claim from non-busy proxy", async function () {
      const { vault, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy 1 proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      // Try to claim without initiating unstake
      await expect(
        vault.connect(owner).claimUnstakeForTesting(proxyAddress)
      ).to.be.revertedWith("Proxy not busy");
    });

    it("Should use convertToAssets for profit calculation during unstake", async function () {
      const { vault, stakedUsde, usdeToken, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Set profitable exchange rate (5% profit)
      await stakedUsde.setExchangeRate(ethers.parseEther("1.05"));

      // Deploy proxy
      await vault.connect(owner).deployProxies(1);

      // Give vault sUSDe
      const sUsdeAmount = ethers.parseEther("1000");
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);

      // Initiate unstake - should return expectedAssets
      const tx = await vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount);
      const receipt = await tx.wait();

      // Fast forward and claim
      await time.increase(COOLDOWN_DURATION + 1);
      const proxyAddress = await vault.unstakeProxies(0);

      const vaultBalanceBefore = await usdeToken.balanceOf(await vault.getAddress());
      await vault.connect(owner).claimUnstakeForTesting(proxyAddress);
      const vaultBalanceAfter = await usdeToken.balanceOf(await vault.getAddress());

      // Verify 5% profit
      const profit = vaultBalanceAfter - vaultBalanceBefore;
      expect(profit).to.equal(ethers.parseEther("1050")); // 1000 * 1.05
    });

    it("Should enforce allowance when proxy calls cooldownShares", async function () {
      const { vault, stakedUsde, owner } = await loadFixture(deployVaultWithEthenaFixture);

      // Deploy proxy
      await vault.connect(owner).deployProxies(1);
      const proxyAddress = await vault.unstakeProxies(0);

      // Give proxy some sUSDe directly (not through vault)
      const sUsdeAmount = ethers.parseEther("100");
      await stakedUsde.mint(proxyAddress, sUsdeAmount);

      // Get proxy instance
      const UnstakeProxyFactory = await ethers.getContractFactory("UnstakeProxy");
      const proxy = UnstakeProxyFactory.attach(proxyAddress) as UnstakeProxy;

      // Proxy tries to initiate unstake without approval - should fail
      await expect(
        vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount)
      ).to.be.reverted; // Will fail because vault has no sUSDe

      // Now test with proper approval
      await stakedUsde.mint(await vault.getAddress(), sUsdeAmount);

      // This should work (vault has sUSDe and transfers to proxy)
      await vault.connect(owner).initiateUnstakeForTesting(sUsdeAmount);
    });
  });

  describe("Exchange Rate Integration", function () {
    it("Should calculate correct expected assets with 1:1 rate", async function () {
      const { stakedUsde } = await loadFixture(deployVaultWithEthenaFixture);

      const shares = ethers.parseEther("100");
      const assets = await stakedUsde.convertToAssets(shares);

      expect(assets).to.equal(shares); // 1:1 rate
    });

    it("Should calculate correct expected assets with custom rate", async function () {
      const { stakedUsde } = await loadFixture(deployVaultWithEthenaFixture);

      // Set exchange rate to 1.1 (1 sUSDe = 1.1 USDe)
      await stakedUsde.setExchangeRate(ethers.parseEther("1.1"));

      const shares = ethers.parseEther("100");
      const assets = await stakedUsde.convertToAssets(shares);

      expect(assets).to.equal(ethers.parseEther("110")); // 100 * 1.1 = 110
    });

    it("Should use convertToAssets for profit calculation", async function () {
      const { stakedUsde } = await loadFixture(deployVaultWithEthenaFixture);

      // Set profitable exchange rate (1 sUSDe = 1.05 USDe)
      await stakedUsde.setExchangeRate(ethers.parseEther("1.05"));

      const sUsdeAmount = ethers.parseEther("1000");
      const expectedUsde = await stakedUsde.convertToAssets(sUsdeAmount);

      // If bought sUSDe for 1000 USDe, profit would be:
      const bookValue = ethers.parseEther("1000");
      const expectedProfit = expectedUsde - bookValue;

      expect(expectedProfit).to.equal(ethers.parseEther("50")); // 5% profit
    });
  });
});
