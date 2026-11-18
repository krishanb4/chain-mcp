// End-to-end check: starts the server the way Claude does (MCP over stdio) and calls every tool on live chains.
// Run: node test.mjs
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const client = new Client({ name: 'test', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [fileURLToPath(new URL('server.mjs', import.meta.url))] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
};

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const BINANCE = '0xF977814e90dA44bFA03b6295A0616a897441aceC';

assert.equal((await client.listTools()).tools.length, 5);

const bal = await call('get_balance', { address: VITALIK });
assert.match(bal.data.balance, /^\d+(\.\d+)?$/);
assert.equal(bal.data.coin, 'ETH');

const tok = await call('get_token_balance', { token: USDC, address: BINANCE });
assert.equal(tok.data.symbol, 'USDC');
assert.match(tok.data.balance, /^\d+(\.\d{1,6})?$/); // USDC has 6 decimals

const xfers = await call('get_token_transfers', { token: USDC, blocks: 5 });
assert.ok(xfers.data.transfers.length > 0, 'USDC should move in any 5 blocks');
assert.match(xfers.data.transfers[0].from, /^0x[0-9a-f]{40}$/);

const tx = await call('get_transaction', { hash: xfers.data.transfers[0].tx });
assert.equal(tx.data.status, 'success');
assert.ok(tx.data.tokenTransfersInTx >= 1);

for (const chain of ['base', 'polygon', 'bsc']) {
  const gas = await call('get_gas_price', { chain });
  assert.ok(gas.data.latestBlock > 0, chain);
}

// Bad input is rejected before any network call; a non-token address gives a readable error.
assert.ok((await call('get_balance', { address: '0x123' })).error);
const notToken = await call('get_token_balance', { token: VITALIK, address: VITALIK });
assert.match(notToken.data, /not an ERC-20 token/);

console.log('all checks passed');
console.log({ vitalikEth: bal.data.balance, binanceUsdc: tok.data.balance, sampleTransfer: xfers.data.transfers[0], tx: tx.data });
await client.close();
