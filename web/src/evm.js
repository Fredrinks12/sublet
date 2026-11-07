// Paying rent on another chain from a browser wallet. Written against the plain EIP-1193 interface,
// since the only contract call is an ERC-20 transfer.
export const CHAIN_IDS = { Base: 84532, Arbitrum: 421614, Polygon: 80002, Bnb: 97, Avalanche: 43113 };
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const word = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');

export const hasWallet = () => Boolean(window.ethereum);

export async function connectWallet(chain) {
  const [from] = await window.ethereum.request({ method: 'eth_requestAccounts' });
  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${CHAIN_IDS[chain].toString(16)}` }],
  });
  return from.toLowerCase();
}

export async function payToken({ from, token, to, amount }) {
  const data = `0xa9059cbb${word(to)}${word(BigInt(amount).toString(16))}`;
  const hash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from, to: token, data }],
  });
  for (let i = 0; i < 90; i += 1) {
    const receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [hash] });
    if (receipt) {
      if (receipt.status !== '0x1') throw new Error('The payment reverted.');
      return receipt;
    }
    await sleep(2000);
  }
  throw new Error('The payment was not confirmed in time.');
}

/** The Transfer log paying `payTo`, in the exact shape the contract hashes. */
export function transferLog(receipt, token, payTo) {
  const topic = `0x${word(payTo)}`;
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === token.toLowerCase() && l.topics[0] === TRANSFER_TOPIC && l.topics[2]?.toLowerCase() === topic,
  );
  if (!log) throw new Error('No matching transfer in that transaction.');
  return {
    removed: Boolean(log.removed),
    log_index: parseInt(log.logIndex, 16),
    transaction_index: parseInt(log.transactionIndex, 16),
    transaction_hash: log.transactionHash.toLowerCase(),
    block_hash: log.blockHash.toLowerCase(),
    block_number: parseInt(log.blockNumber, 16),
    address: log.address.toLowerCase(),
    data: log.data.toLowerCase(),
    topics: log.topics.map((t) => t.toLowerCase()),
  };
}

export const signClaim = (from, message) =>
  window.ethereum.request({
    method: 'personal_sign',
    params: [`0x${Array.from(new TextEncoder().encode(message), (b) => b.toString(16).padStart(2, '0')).join('')}`, from],
  });
