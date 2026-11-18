# chain-mcp

An MCP server that lets Claude read live blockchain data. Ask a question in plain English ("how much USDC does this wallet hold?", "did this transaction succeed, and what did it cost?") and Claude calls the right tool and answers from on-chain data.

Read-only. No API keys. One file, no web3 library: plain JSON-RPC against public nodes.

## Tools

| Tool | What it returns |
|---|---|
| `get_balance` | Native coin balance (ETH, BNB, POL) of any address |
| `get_token_balance` | ERC-20 balance with the token's symbol and decimals applied |
| `get_transaction` | Sender, recipient, value, status, fee paid, block |
| `get_token_transfers` | Recent transfers of a token, optionally filtered to one wallet |
| `get_gas_price` | Current gas price in gwei and the latest block |

Every tool takes a `chain`: `ethereum` (default), `base`, `polygon` or `bsc`.

## Run it

Needs Node 20 or later.

```bash
npm install
node test.mjs
```

The test starts the server over stdio, the same way Claude does, and calls every tool against live chains.

## Connect it to Claude

Claude Code:

```bash
claude mcp add chain -- node /absolute/path/to/chain-mcp/server.mjs
```

Claude Desktop, in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "chain": { "command": "node", "args": ["/absolute/path/to/chain-mcp/server.mjs"] }
  }
}
```

To use your own node (Alchemy, Infura, a local one), set `RPC_URL_ETHEREUM`, `RPC_URL_BASE`, `RPC_URL_POLYGON` or `RPC_URL_BSC`.

## Design notes

- **Exact amounts.** Balances are formatted with BigInt, so an 18-decimal balance is never rounded by floating point.
- **Input is validated before any network call.** Addresses and hashes must match their hex format; a bad one returns a readable error to Claude.
- **Errors come back as tool errors**, not crashes, so Claude can explain what went wrong or try another chain.
- **Old tokens work.** `symbol()` is decoded whether the token returns a string or a bytes32.
- **Public-node limits are respected.** Transfer scans are capped at 500 blocks and 25 results.

## Limits

- Public nodes rate-limit and cap log queries; for heavy use, point it at your own node.
- EVM chains only.
- It reads; it cannot sign or send transactions, by design.
