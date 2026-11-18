#!/usr/bin/env node
// chain-mcp: read-only blockchain tools for Claude, over MCP (stdio).
// No API keys and no web3 library: plain JSON-RPC against public nodes.
// Override a node with RPC_URL_<CHAIN>, e.g. RPC_URL_ETHEREUM=https://...
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const CHAINS = {
  ethereum: { rpc: 'https://ethereum-rpc.publicnode.com', coin: 'ETH' },
  base: { rpc: 'https://base-rpc.publicnode.com', coin: 'ETH' },
  polygon: { rpc: 'https://polygon-bor-rpc.publicnode.com', coin: 'POL' },
  bsc: { rpc: 'https://bsc-rpc.publicnode.com', coin: 'BNB' },
};
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpc(chain, method, params = []) {
  const url = process.env[`RPC_URL_${chain.toUpperCase()}`] || CHAINS[chain].rpc;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${chain} node returned HTTP ${res.status}`);
  const { result, error } = await res.json();
  if (error) throw new Error(`${chain} node: ${error.message}`);
  return result;
}

// Exact decimal formatting with BigInt; floats would lose precision on 18-decimal balances.
function units(value, decimals) {
  const v = BigInt(value), base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${v / base}${frac ? '.' + frac : ''}`;
}
const pad = addr => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
const unpad = topic => '0x' + topic.slice(26);

// ERC-20 symbol() returns an ABI string on most tokens and a bytes32 on a few old ones (e.g. MKR).
function decodeString(hex) {
  const h = hex.slice(2);
  const bytes = h.length === 64 ? h : h.slice(128, 128 + parseInt(h.slice(64, 128), 16) * 2);
  return Buffer.from(bytes, 'hex').toString('utf8').replace(/\0+$/, '');
}

async function tokenInfo(chain, token) {
  const call = data => rpc(chain, 'eth_call', [{ to: token, data }, 'latest']);
  const [dec, sym] = await Promise.all([call('0x313ce567'), call('0x95d89b41')]);
  if (!dec || dec === '0x') throw new Error(`${token} is not an ERC-20 token on ${chain}`);
  return { decimals: Number(BigInt(dec)), symbol: decodeString(sym) };
}

const chain = z.enum(Object.keys(CHAINS)).default('ethereum').describe('Which chain to query');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address (40 hex chars)');
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x transaction hash (64 hex chars)');

const server = new McpServer({ name: 'chain-mcp', version: '1.0.0' });
const tool = (name, description, inputSchema, fn) =>
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: true } },
    async args => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    });

tool('get_balance', 'Native coin balance (ETH, BNB, POL) of a wallet or contract.', { chain, address },
  async ({ chain, address }) => {
    const wei = await rpc(chain, 'eth_getBalance', [address, 'latest']);
    return { chain, address, balance: units(wei, 18), coin: CHAINS[chain].coin };
  });

tool('get_token_balance', 'ERC-20 token balance of a wallet, with the token symbol and decimals applied.',
  { chain, token: address.describe('Token contract address'), address: address.describe('Wallet address') },
  async ({ chain, token, address }) => {
    const [info, raw] = await Promise.all([
      tokenInfo(chain, token),
      rpc(chain, 'eth_call', [{ to: token, data: '0x70a08231' + pad(address).slice(2) }, 'latest']),
    ]);
    return { chain, token, address, balance: units(raw, info.decimals), symbol: info.symbol };
  });

tool('get_transaction', 'Details of a transaction: sender, recipient, value, status, fee paid and block.', { chain, hash: txHash },
  async ({ chain, hash }) => {
    const [tx, receipt] = await Promise.all([
      rpc(chain, 'eth_getTransactionByHash', [hash]),
      rpc(chain, 'eth_getTransactionReceipt', [hash]),
    ]);
    if (!tx) throw new Error(`No transaction ${hash} on ${chain}`);
    const coin = CHAINS[chain].coin;
    return {
      chain, hash, from: tx.from, to: tx.to ?? '(contract creation)',
      value: `${units(tx.value, 18)} ${coin}`,
      status: !receipt ? 'pending' : receipt.status === '0x1' ? 'success' : 'failed',
      block: receipt ? Number(BigInt(receipt.blockNumber)) : null,
      fee: receipt ? `${units(BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice), 18)} ${coin}` : null,
      tokenTransfersInTx: receipt ? receipt.logs.filter(l => l.topics[0] === TRANSFER && l.topics.length === 3).length : null,
    };
  });

tool('get_token_transfers',
  'Recent ERC-20 transfers of one token over the last N blocks, optionally only those sent or received by one wallet. Returns the newest 25.',
  {
    chain, token: address.describe('Token contract address'),
    address: address.optional().describe('Only transfers to or from this wallet'),
    blocks: z.number().int().min(1).max(500).default(50).describe('How many recent blocks to scan (public nodes limit this)'),
  },
  async ({ chain, token, address, blocks }) => {
    const [info, latest] = await Promise.all([tokenInfo(chain, token), rpc(chain, 'eth_blockNumber')]);
    const range = { address: token, fromBlock: '0x' + (BigInt(latest) - BigInt(blocks) + 1n).toString(16), toBlock: latest };
    // A wallet filter needs two queries: indexed topic 1 is the sender, topic 2 the recipient.
    const filters = address ? [[TRANSFER, pad(address)], [TRANSFER, null, pad(address)]] : [[TRANSFER]];
    const logs = (await Promise.all(filters.map(topics => rpc(chain, 'eth_getLogs', [{ ...range, topics }])))).flat()
      .filter(l => l.topics.length === 3) // ERC-721 uses the same event with 4 topics
      .sort((a, b) => Number(BigInt(b.blockNumber) - BigInt(a.blockNumber)) || Number(BigInt(b.logIndex) - BigInt(a.logIndex)));
    return {
      chain, token, symbol: info.symbol, blocksScanned: blocks, totalFound: logs.length,
      transfers: logs.slice(0, 25).map(l => ({
        block: Number(BigInt(l.blockNumber)), from: unpad(l.topics[1]), to: unpad(l.topics[2]),
        amount: units(l.data === '0x' ? 0 : l.data, info.decimals), tx: l.transactionHash,
      })),
    };
  });

tool('get_gas_price', 'Current gas price in gwei and the latest block number.', { chain },
  async ({ chain }) => {
    const [gas, block] = await Promise.all([rpc(chain, 'eth_gasPrice'), rpc(chain, 'eth_blockNumber')]);
    return { chain, gasPriceGwei: units(gas, 9), latestBlock: Number(BigInt(block)) };
  });

await server.connect(new StdioServerTransport());
