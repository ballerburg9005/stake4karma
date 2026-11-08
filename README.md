# Stake4Karma

**Lock testnet ETH. Prove you locked it. Use the same cryptographic identity across applications.**

A dependency-free JavaScript SDK, ownerless Solidity escrow, and browser-based testing app with a public high-score board. This is experimental software, built for **Base Sepolia TESTNET**. It is **not audited and is not safe for real money**.

![Status](https://img.shields.io/badge/status-testnet%20prototype-orange) ![Runtime](https://img.shields.io/badge/Node-22%2B-green)

## What you can test

1. Open the app on `http://localhost:3000` with MetaMask or an injected EVM wallet.
2. Connect to Base Sepolia, create a portable Ed25519 identity (or import one from a previously saved backup).
3. Download a password-encrypted private-key backup **before you deposit**. The private key never leaves your browser.
4. Register a nickname: the browser signs a short challenge, and the Node test server stores only your *public* credential, wallet address, and nickname in `data/registrations.json`.
5. Lock test ETH with a MetaMask-confirmed transaction. The escrow contract ties the wallet to the public credential and holds the deposited ETH.
6. Watch the leaderboard show only **on-chain verified active deposits**, sorted by locked ETH. Refresh the board, or request exit and see the entry disappear after its brief 15-second cache expires.
7. Once your test contract's withdrawal period passes, withdraw the test ETH through the wallet.

**A user cannot submit an invented number to the leaderboard.** The server uses its own Ethereum RPC endpoint to call `positionOf(wallet, nativeAsset)` and compares the public key recorded by the contract to the registration. Registration *alone* never gives a score. This is a simple trustful centralized *index of names*, not a centralized staking authority. Other dapps can ignore this server and use the SDK to verify the same wallet/key/contract independently.

## Quick start

Install **Node.js 22+**. The project has **no npm dependencies** for the web app, server, and unit tests.

```bash
npm test                 # 8 automated JavaScript tests, mocked blockchain RPC
cp .env.example .env     # Unix/macOS; on Windows copy the file manually
npm start                # http://localhost:3000
```

It starts with no contract deployed. You can connect a wallet, generate/import a key, back it up and register a name, but **on-chain staking stays disabled** until you deploy a contract and set its address.

## Deploy your own TESTNET contract

An on-chain contract cannot be installed by a website or GitHub automatically on behalf of the user. Deployment is a real wallet-approved transaction, requiring testnet ETH for gas. No common or verified deployment is bundled in this project.

1. Switch MetaMask to **Base Sepolia** (chain ID **84532**, RPC `https://sepolia.base.org`). Get **free, valueless test ETH** from a Base Sepolia faucet. [Base network docs](https://docs.base.org/chain/network-information) and [Base Sepolia explorer](https://sepolia.basescan.org/) are useful references.
2. Visit [Remix Solidity IDE](https://remix.ethereum.org/). Create a file named `Stake4Karma.sol`, paste the source of `contracts/Stake4Karma.sol` from this repository, and compile it with Solidity `0.8.24` or later in the `0.8.x` range.
3. In Remix's **Deploy & Run Transactions**, choose **Injected Provider – MetaMask**, and confirm you are on **Base Sepolia**. Deploy `Stake4Karma` with constructor arguments:

   - `minHoldSeconds = 60`
   - `exitDelaySeconds = 60`

   These short periods are **only recommended for disposable testnet demonstrations**. A 30-day minimum hold and seven-day exit delay would be `2592000, 604800`. The values are fixed forever at contract deployment; there is no administrator to edit them.
4. After the wallet confirms deployment, copy the **contract's deployed address** (not the deployer's wallet address) into `.env`:

   ```env
   STAKE_CONTRACT=0xREPLACE_WITH_40_HEX_CHARACTER_ADDRESS
   CHAIN_ID=84532
   RPC_URL=https://sepolia.base.org
   PORT=3000
   ```
5. Restart `npm start` and open `http://localhost:3000`. With a wallet containing test ETH, go through **Connect → Generate → Download encrypted backup → Register → Lock coins**.

You should see a MetaMask transaction confirmation, a BaseScan transaction link, a verified local position, and your nickname/locked value on the board. If a transaction or RPC check fails, the application reports an error rather than claiming the funds were locked.

**Important:** 60 seconds is a lower bound, not an exact withdrawal time. Withdrawal requires both the minimum hold since the last deposit and the delay since requesting exit. A request for exit makes the stake inactive immediately after confirmation. A further deposit resets the minimum holding period for the full position.

## Identity and recovery

The default credential is a separate **Ed25519 public/private keypair** generated with WebCrypto, not your MetaMask seed phrase. MetaMask signs transactions to the staking contract; the independent Ed25519 private key signs public registration challenges and can later sign data for other applications.

- **Generate locally:** You receive a public key and a password-encrypted backup JSON (`stake4karma-key-….json`). Passwords are not sent to the backend. The backup is encrypted with PBKDF2-SHA256 (250,000 iterations) and AES-256-GCM; protect both the JSON and its password. After refreshing the tab, import the backup to recover the identity.
- **Import your own credential:** You can import a previously exported encrypted Stake4Karma key file, or a plaintext JSON of shape `{"format":"stake4karma-ed25519-v1", "publicKey":"0x...", "privateKeyPkcs8":"0x..."}` containing a *matching Ed25519 pair*. Plaintext private-key files are a significant risk; only use them for throwaway testing. The app cryptographically verifies imported keypair ownership before accepting it.
- **PGP/OpenPGP:** Not yet supported. A PGP key cannot simply be pasted as an Ed25519 key; secure support requires PGP signature verification and an interoperable fingerprint-to-`bytes32` binding convention. This can be added as a separate credential adapter in a later version.

**Do not lose the identity backup.** The current contract binds one credential to a wallet forever. You can still withdraw with your wallet after satisfying the lock periods even if the identity is lost, but you cannot use a new credential to build a score with that wallet. Test first using a disposable wallet and testnet funds.

## Architecture

```text
                           Base Sepolia (public chain)
  Browser wallet ── depositNative(bytes32 publicKey) ──► Stake4Karma.sol
       │                                          │
       │                 positionOf(wallet, ETH)  │
       │                                          ▼
  Browser UI ───── register signed identity ──► Node server ─► read-only RPC
       │                                          │
       │                                      JSON file
       └─────────── view current leaderboard ◄───┘
```

- `contracts/Stake4Karma.sol` — ownerless escrow, per-wallet permanently bound identity, active/inactive position, time-locked withdraw; also implements standard ERC-20 deposits, though the **demo UI currently only displays native ETH**.
- `src/stake.js` — reusable ESM WebCrypto identity/signature SDK, read-only `eth_call` verifier, ERC-20/native-wallet transaction helpers. No third-party dependencies.
- `public/index.html`, `public/styles.css`, `public/app.js` — static browser UI, no framework.
- `server.js` — static host, challenges, registration and leaderboard endpoints. Only public data is stored. The blockchain RPC URL is **chosen by the server operator**, not by users.
- `data/registrations.json` — created locally; `.gitignore` excludes it so people cannot accidentally commit user data. Back up the file if you want to preserve nicknames.

### API

- `GET /api/config` — chain and contract configuration.
- `POST /api/challenge` — issue a one-time credential challenge for wallet + Ed25519 public key.
- `POST /api/register` — verify a signed challenge, register/update a nickname. This does **not** claim wallet ownership or stake; on-chain matching is checked separately.
- `GET /api/leaderboard` — verified native-ETH positions ordered by raw amount; refreshed at most every 15 seconds.

Registration signatures are **not wallet ownership proofs**. Before a deposit, anyone may claim an arbitrary wallet address as a *provisional* entry, but cannot cause a positive public score without both the private Ed25519 key *and* a matching wallet-approved on-chain lock. Future versions can optionally include wallet challenge signing to reduce misleading provisional registrations.

## Hosting for multiple people

GitHub Pages alone is a static host; it **cannot write your users' registrations into a GitHub repository securely**. Do not put a GitHub personal-access token in a browser app. For a real shared high-score board, run this Node server on a publicly reachable machine with HTTPS and a persistent disk volume:

```bash
# For deployment behind your own HTTPS reverse proxy:
HOST=0.0.0.0 PORT=3000 npm start
```

This prototype binds to `127.0.0.1` by default and provides *minimal* IP rate-limiting only. For a public deployment, add an HTTPS proxy, durable DB, backups, abuse prevention, monitored RPC, web-app security testing, and appropriate observability. The in-memory challenges and JSON store are single-process only.

## Important limitations

1. **No mainnet deposits.** This contract has *not been compiled/deployment-tested or audited* in this environment. Solidity compilation and a real contract call via MetaMask must be independently tested after deployment. JavaScript tests mock blockchain calls.
2. **Escrow holds assets.** The contract, not the wallet's available balance, owns the ETH while it is locked. The depositor's wallet retains the only normal withdrawal right under code, but bugs could result in permanent loss. There is no admin, slashing, fee collector, or upgrade path.
3. **Verification is gasless, not network-free.** The leaderboard does read-only RPC calls, and node providers can rate-limit/charge. Cached views can be briefly stale; finality and reorganization handling are minimal.
4. **A larger stake earns a bigger score, not a guarantee of good behavior.** A person can still spam from one funded account; each application needs its own rate limits, anti-abuse policy, and definition of reputation. Cryptocurrency lock amounts should not be treated as identity verification or as equivalent to USD without price data.
5. **Multiple coins:** The contract and SDK support standard ERC-20 assets, but scores across different coins require per-asset allowlists and a price conversion policy. The demonstration board deliberately ranks only testnet ETH. Solana needs a different program and adapter.
6. **Server-side key data:** Only public keys, addresses, nicknames, and timestamps are persisted. Identity secret keys must stay on the client. Encrypted backup protects files at rest against casual disclosure but a malicious website or compromised browser can still steal keys at use time.

**License:** MIT.