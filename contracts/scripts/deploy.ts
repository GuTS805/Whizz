// Deploys Whizz to the network passed with --network and saves the address
// for the web app.  Usage:  npm run deploy:testnet
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { network } from "hardhat";

const { viem, networkName } = await network.create();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();

const balance = await publicClient.getBalance({ address: deployer.account.address });
console.log(`Network:  ${networkName}`);
console.log(`Deployer: ${deployer.account.address}`);
console.log(`Balance:  ${Number(balance) / 1e18} MON`);
if (balance === 0n) throw new Error("Deployer has no MON — fund it from the Monad testnet faucet first.");

const whizz = await viem.deployContract("Whizz");
const deployBlock = await publicClient.getBlockNumber();
const chainId = await publicClient.getChainId();
console.log(`Whizz deployed at ${whizz.address} (block ${deployBlock})`);

const outPath = path.join(import.meta.dirname, "../../web/src/lib/deployment.json");
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(
  outPath,
  JSON.stringify({ address: whizz.address, chainId, deployBlock: Number(deployBlock) }, null, 2) + "\n",
);
console.log(`Saved to web/src/lib/deployment.json`);
