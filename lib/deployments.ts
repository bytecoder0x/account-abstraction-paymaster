import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Address } from "viem";

export interface Deployment {
  chainId: number;
  entryPoint: Address;
  factory: Address;
  paymaster: Address;
  counter: Address;
  /** Local-only mock used to demo the ERC-20 settlement mode. */
  feeToken?: Address;
  swapper?: Address;
}

const deploymentPath = (chainId: number) => join(process.cwd(), "deployments", `${chainId}.json`);

export async function saveDeployment(deployment: Deployment): Promise<string> {
  const path = deploymentPath(deployment.chainId);

  await mkdir(join(process.cwd(), "deployments"), { recursive: true });
  await writeFile(path, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

  return path;
}

export async function loadDeployment(chainId: number): Promise<Deployment> {
  try {
    return JSON.parse(await readFile(deploymentPath(chainId), "utf8")) as Deployment;
  } catch {
    throw new Error(
      `No deployment for chain ${chainId}. Run "hardhat run scripts/deploy.ts --network <network>" first.`,
    );
  }
}
