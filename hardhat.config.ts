import type { HardhatUserConfig } from "hardhat/config";
import { configVariable } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import "dotenv/config";

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
    // The canonical EntryPoint is not imported by any project source file, but the
    // tests and the local deployment scripts need its artifact.
    npmFilesToBuild: ["@account-abstraction/contracts/core/EntryPoint.sol"],
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 31337,
    },
    // Used only by test/fork, which is skipped unless MAINNET_RPC_URL is set.
    mainnetFork: {
      type: "edr-simulated",
      chainType: "l1",
      forking: {
        url: configVariable("MAINNET_RPC_URL"),
      },
    },
    // Target for the interaction scripts: `npx hardhat node` keeps state between script runs,
    // which the in-process `hardhat` network does not.
    localhost: {
      type: "http",
      chainType: "l1",
      url: "http://127.0.0.1:8545",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: configVariable("SEPOLIA_RPC_URL"),
      accounts: [configVariable("DEPLOYER_PRIVATE_KEY")],
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
};

export default config;
