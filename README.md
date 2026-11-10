# Author note: I have not checked this yet made with ChatGPT Plus.

# Stake4Karma · serverless demo (v0.4)

**Lock coins, prove your commitment, spend no stake.** This project contains a zero-dependency JavaScript SDK, a non-upgradeable Solidity escrow, and an **entirely static browser demo** that can run on GitHub Pages, any other HTTPS host, or localhost. The demo stores registration, nicknames, wallet associations, and active stakes **in the smart contract**, not in an administrator's database.

> **TESTNET RESEARCH SOFTWARE.** The only configured chain in the static demo is **Base Sepolia** (84532). Testnet ETH is not valuable. The Solidity contract and browser app are **unaudited**. Do not deposit real coins or deploy the demo on mainnet.

## Quickest way to use the GitHub Pages website

1. In this repository open **Settings → Pages → Build and deployment → Source → GitHub Actions**. This one-time GitHub configuration must be performed by a repository admin. A workflow at `.github/workflows/pages.yml` publishes the static site after pushes to `main`. The repository's public site will typically be `https://ballerburg9005.github.io/stake4karma/` **after** deployment succeeds.
2. Someone (for now, you) must deploy the **new v0.3** contract from `contracts/Stake4Karma.sol` on **Base Sepolia**. See the instructions below. A website cannot deploy it without a wallet-approved transaction.
3. Open the hosted website, paste the **deployed contract address**, and select **Use contract**. The address is stored only in this browser's local storage. Copy **Share this board** for a URL carrying `?contract=0x…`. Later the maintainer can publish a default verified contract address in the app.
4. Connect MetaMask (Base Sepolia), generate an Ed25519 credential key or import a Stake4Karma backup, and **download a password-encrypted backup**.
5. Enter a nickname and click **Register**. This is a **wallet-approved on-chain transaction**, not a free server registration. The nickname is publicly visible, not unique, and stored permanently in chain history.
6. Click **Lock coins** to deposit some Base Sepolia test ETH. This is a second wallet-approved transaction. Once mined, it will be independently checked and ranked. **Refresh** shows all active positions in the contract's directory, up to the prototype's first 500 participant entries.
7. Request exit. The score becomes inactive on-chain immediately when confirmed, though the funds remain in escrow. After both delays, click Withdraw and MetaMask returns the ETH to your original wallet.

**Important:** Registering a key, locking coins, requesting exit, and withdrawing all cost **network gas**. Checking whether an identity has active coins locked uses a single `eth_call` and **does not cost on-chain gas**. ETH itself is not spent by staking: it is transferred into the escrow and returned on authorized withdrawal, subject to the contract's rules and risks.

## Deploy your own TESTNET contract

1. Obtain a small amount of **Base Sepolia test ETH** in a disposable browser wallet; configure Base Sepolia with RPC `https://sepolia.base.org`, chain ID **84532**, explorer `https://sepolia.basescan.org`.
2. Open [Remix Solidity IDE](https://remix.ethereum.org/). Copy **the current `contracts/Stake4Karma.sol`** into a new Solidity file. Compile using **Solidity 0.8.30** (or compatible 0.8.24+).
3. In **Deploy & Run**, select **Injected Provider – MetaMask**, verify the account is on Base Sepolia, and deploy `Stake4Karma` using constructor values `60, 60` (60-second minimum hold / 60-second exit delay). Never reuse the short demonstration delays to claim strong spam resistance.
4. Confirm the deployment transaction in MetaMask. Copy the **new contract address** from Remix or BaseScan. Paste it into the Pages app's contract field. The app checks that the chain is Base Sepolia, that code exists, that the directory works, and reads the immutable minimum-hold and exit-delay durations. **A contract can fake these responses; this is not a security audit or a bytecode authenticity check.** This does **not** prove that arbitrary bytecode is safe: inspect and verify the source before staking.
5. Share the URL containing `?contract=0x…` with other testers. They can register and stake from their own wallets without hosting an app server.

There is no shared deployed contract address in this repository at the time of writing. A *v0.2* deployment does **not** support the new `entryAt` and `participantCount` functions needed for serverless rankings. Deploy the current v0.3 source.

## When GitHub, the demo, or a central service goes away

**Your withdrawal is not authorized by a website. It is authorized by your original wallet and contract code.** You need the wallet that deposited, the contract address, the correct network, and sufficient gas for the exit and withdrawal transactions. You **do not** need an Ed25519 backup, a GitHub login, the original domain, or a server database to withdraw.

Recovery choices:

- Use the standalone static **`recover.html`** page bundled with this repository. It's on the GitHub Pages site at `recover.html`, but the same files can be hosted on any HTTPS domain or `http://localhost`.
- Build and self-host the entire static app: `npm run build:pages`; serve `dist/` with any static HTTP server (for example `python3 -m http.server 4173 --directory dist`), then visit `http://localhost:4173`. These commands require Node.js 22+ and Python only if you choose that example server. No database/backend/API tokens are needed.
- Interact directly with a block explorer's **Write Contract** interface if its contract source has been verified, or with wallet transaction tooling. Call `requestExit(asset)`, wait until the configured conditions pass, and then `withdraw(asset)` using the **depositing wallet**. For native ETH, `asset` is `0x0000000000000000000000000000000000000000`; for ERC-20, use the token contract address.

**The contract is independent of any website, but it is not independent of the blockchain.** A functioning Base Sepolia chain, access to a node/RPC, and wallet keys are still required. These guarantees also rely on the unaudited contract being correct. This demo does not guarantee recovery after chain failure, lost wallet keys, malicious/incorrect contract addresses, or contract bugs.

## Architecture

```text
 Any HTTPS / localhost static site (including GitHub Pages)
  ├─ WebCrypto Ed25519 key (generated and used locally)
  ├─ Connect EIP-1193 wallet, request wallet-approved transactions
  │    ├─ register(publicKey, nickname)           [transaction + gas]
  │    ├─ depositNative(publicKey)                [transaction + gas]
  │    ├─ requestExit(asset)                     [transaction + gas]
  │    └─ withdraw(asset)                        [transaction + gas]
  └─ Base Sepolia read-only RPC / wallet RPC
       ├─ participantCount() + entryAt(index)    [gasless board reads]
       └─ positionOf(wallet, asset)              [single-call portable proof]
                           │
             Non-upgradeable, adminless escrow contract
               - wallet-linked Ed25519 credential public key
               - wallet-linked display name (v0.3 on-chain directory)
               - locked balances, hold timer, requested exits
               - no custodian or central storage service
```

The **global leaderboard** is based on the contract's *public enumerable directory*. This is straightforward and serverless for a test group, but its on-chain indexing increases deposit/registration gas and is not optimized for millions of accounts. The demo only considers **native test ETH positions** and loads at most the first 500 registrations; it explicitly labels partial results. For production use, an untrusted event indexer plus on-chain re-verification or an off-chain portable signed directory would be more scalable.

The ERC-20 `depositToken`, `requestExit(asset)` and `withdraw(asset)` contract methods are present; the registration/leaderboard UI is ETH-only. **Do not treat ETH and stablecoins as equivalent dollar scores** without a well-specified token valuation policy. Fee-on-transfer/rebasing ERC-20 tokens are not supported.

## The SDK and credential keys

The reusable ESM module `src/stake.js` contains:

- WebCrypto Ed25519 key generation, import/export, and domain-separated application content signatures.
- Cryptographically checked, nonce-scoped authentication proofs that **require an independently configured `expectedAudience`** and are backed by the current `positionOf` state (exactly **one** read-only contract call, after signature and chain checks). Consumer apps must consume nonces atomically to reject replays.
- Browser wallet transaction builders for native and standard ERC-20 assets, exit, withdrawal and registration. No private wallet key is ever exported.
- `httpRpcProvider()`, `readParticipantCount()` and `readEntry()` for the test leaderboard; `readLockRules()` to display immutable contract timeouts before depositing.
- Pre-deposit on-chain key comparison in the static UI prevents accidentally registering or depositing with a new key in an already-bound wallet (without wasting a transaction).

**Breaking SDK change in v0.4:** `verifyCredential()` now requires `expectedAudience` set by each verifier (not supplied by the user). This prevents trusting an attacker-supplied challenge audience. The Solidity contract is unchanged from v0.3; existing v0.3 deployments remain compatible.

The *separate* Ed25519 private key is backed up in an AES-256-GCM-encrypted JSON file, with a password-derived key (PBKDF2-SHA256, 250,000 iterations). Never publish it. **PGP/OpenPGP importing is not yet implemented.** The contract currently binds one Ed25519 key to a wallet permanently; if lost, the wallet can still withdraw but cannot produce signatures for that bound identity. Use a disposable test wallet.

## Development commands

```bash
npm test                           # 11 tests; no npm dependencies
npm run build:pages                # create dist/ standalone site
python3 -m http.server 4173 --directory dist
# open http://localhost:4173
```

The old **v0.2 Node demo** is still available via `cp .env.example .env && npm start` (`http://localhost:3000`). It uses a local JSON registration database and is retained as a legacy experiment. **It is NOT the serverless GitHub Pages app**; use the `site/` source and `dist/` artifact instead. No Node process is needed on a machine merely visiting the hosted website.

GitHub Actions: `.github/workflows/ci.yml` tests the SDK and compiles Solidity, and `.github/workflows/pages.yml` builds and deploys the static website. GitHub Pages must be enabled using GitHub's **Settings → Pages → GitHub Actions** control.

## Security and limitations

- **Only testnet assets.** No audit, live-wallet end-to-end test or formal verification. Mistakes in contracts can trap funds. Do not use real value yet.
- **No backdoor.** The source has no protocol administrator, upgrade or slashing path; the wallet authorizes its own withdrawals subject to immutable exit rules.
- **No instant global observation.** Nodes observe chain state with varying latency; contract exit deactivates scoring after confirmation, but browsers refreshing at different times may display stale data.
- **Rate-limited RPC.** Base's free public HTTP RPC is not guaranteed to serve unlimited anonymous viewers and can fail due to CORS, rate limits or outages; the static demo lets users choose another compatible RPC. No API server is required, but some node access is.
- **Economic stake is not behavior reputation.** Locking funds increases the cost of operating many identities but doesn't make an account honest or stop all spam. Projects may combine stake with posting limits and moderation.
- **Wallet and key security.** Never share the wallet seed phrase, credential backup password, or Ed25519 private key. A malicious hosted copy of a dapp could trick users into approving harmful transactions or steal credential keys; prefer verified source and domain.

**License:** MIT.
