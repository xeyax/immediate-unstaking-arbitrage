import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// Ethena Mainnet addresses
const USDE_MAINNET = "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3";
const SUSDE_MAINNET = "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497";

export default buildModule("ArbitrageVault", (m) => {
  const deployer = m.getAccount(0);

  const usde = m.getParameter("usde", USDE_MAINNET);
  const sUsde = m.getParameter("sUsde", SUSDE_MAINNET);
  const feeRecipient = m.getParameter("feeRecipient", deployer); // Default: deployer
  const proxyCount = m.getParameter("proxyCount", 5);

  const vault = m.contract("ArbitrageVault", [usde, sUsde, feeRecipient]);

  m.call(vault, "deployProxies", [proxyCount]);

  return { vault };
});
