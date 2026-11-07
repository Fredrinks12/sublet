// Paying on another chain. Rent goes straight from the tenant to the owner's address there.
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { arbitrumSepolia, avalancheFuji, baseSepolia, bscTestnet, polygonAmoy } from 'viem/chains';

export const CHAINS = {
  Base: baseSepolia,
  Arbitrum: arbitrumSepolia,
  Polygon: polygonAmoy,
  Bnb: bscTestnet,
  Avalanche: avalancheFuji,
};

const ERC20 = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function chainOf(name) {
  const chain = CHAINS[name];
  if (!chain) throw new Error(`Unsupported chain ${name}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  return chain;
}

export function publicClient(name, rpcUrl) {
  return createPublicClient({ chain: chainOf(name), transport: http(rpcUrl) });
}

export function walletFor(privateKey) {
  return privateKeyToAccount(privateKey);
}

export async function tokenInfo(name, token, holder, rpcUrl) {
  const client = publicClient(name, rpcUrl);
  const [symbol, decimals, balance] = await Promise.all([
    client.readContract({ address: token, abi: ERC20, functionName: 'symbol' }),
    client.readContract({ address: token, abi: ERC20, functionName: 'decimals' }),
    holder ? client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [holder] }) : 0n,
  ]);
  return { symbol, decimals, balance };
}

/** Sends an ERC-20 transfer and waits for its receipt. */
export async function payToken({ chain, token, to, amount, account, rpcUrl }) {
  const wallet = createWalletClient({ account, chain: chainOf(chain), transport: http(rpcUrl) });
  const hash = await wallet.writeContract({
    address: token,
    abi: ERC20,
    functionName: 'transfer',
    args: [to, amount],
  });
  const receipt = await publicClient(chain, rpcUrl).waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`Payment ${hash} reverted`);
  return receipt;
}

/** The Transfer log in a receipt that pays `token` to `payTo`. */
export function findTransfer(receipt, token, payTo) {
  const pad = `0x${'0'.repeat(24)}${payTo.slice(2).toLowerCase()}`;
  return receipt.logs.find(
    (log) =>
      log.address.toLowerCase() === token.toLowerCase() &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics[2]?.toLowerCase() === pad,
  );
}

/** Converts a log to the exact shape the contract hashes. Values must match the RPC output. */
export function toContractLog(log) {
  return {
    removed: Boolean(log.removed),
    log_index: Number(log.logIndex),
    transaction_index: Number(log.transactionIndex),
    transaction_hash: log.transactionHash.toLowerCase(),
    block_hash: log.blockHash.toLowerCase(),
    block_number: Number(log.blockNumber),
    address: log.address.toLowerCase(),
    data: log.data.toLowerCase(),
    topics: log.topics.map((topic) => topic.toLowerCase()),
  };
}
