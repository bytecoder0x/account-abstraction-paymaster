import { parseAbi } from "viem";

/** Mainnet addresses used by the fork tests. */
export const MAINNET = {
  uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
  uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  uniswapV3Quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
} as const;

/** The WETH/USDC tier with the deepest liquidity. */
export const WETH_USDC_POOL_FEE = 500;

export const WETH_ABI = parseAbi([
  "function deposit() payable",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
]);
