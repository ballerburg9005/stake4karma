/**
 * PortableStake v0.1 - zero-runtime-dependency ES module.
 * Uses WebCrypto Ed25519 and an EIP-1193 JSON-RPC provider.
 * Every user action is wallet-approved; no private wallet keys enter this SDK.
 */
export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';
export const BASE_CHAIN_ID = 8453;
export const SELECTORS = Object.freeze({
  depositNative: '0x42ef5fbb',
  depositToken: '0x84abac95',
  requestExit: '0x28cb1e38',
  withdraw: '0x51cff8d9',
  positionOf: '0x892f928e',
  approve: '0x095ea7b3',
});
const textEncoder = new TextEncoder();
const ZERO_KEY = '0x' + '00'.repeat(32);

function requireHex(value, bytes, name) {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} must be a ${bytes}-byte 0x hex string`);
  }
  return value.toLowerCase();
}
export const assertAddress = (v) => requireHex(v, 20, 'address');
export const assertPublicKey = (v) => requireHex(v, 32, 'public key');
function hexBytes(hex) {
  return Uint8Array.from(hex.slice(2).match(/../g) ?? [], b => parseInt(b, 16));
}
function toHex(bytes) {
  return '0x' + Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
}
function word(value, kind) {
  if (kind === 'address') return assertAddress(value).slice(2).padStart(64, '0');
  if (kind === 'key') return assertPublicKey(value).slice(2);
  if (kind === 'uint') {
    const n = BigInt(value);
    if (n < 0n || n >= (1n << 256n)) throw new Error('uint256 out of range');
    return n.toString(16).padStart(64, '0');
  }
  throw new Error('Unknown ABI kind');
}
function calldata(selector, values = [], types = []) {
  return selector + values.map((value, i) => word(value, types[i])).join('');
}
function decodePosition(data) {
  if (typeof data !== 'string' || !/^0x[0-9a-fA-F]{320}$/.test(data)) {
    throw new Error('Invalid positionOf response (wrong contract or untrusted RPC)');
  }
  const fields = Array.from({length: 5}, (_, i) => data.slice(2 + 64 * i, 2 + 64 * (i + 1)));
  const activeWord = BigInt('0x' + fields[2]);
  if (activeWord > 1n) throw new Error('Invalid contract bool response');
  return {
    publicKey: ('0x' + fields[0]).toLowerCase(),
    amount: BigInt('0x' + fields[1]),
    active: activeWord === 1n,
    withdrawalAvailableAt: Number(BigInt('0x' + fields[3])),
    exitRequestedAt: Number(BigInt('0x' + fields[4])),
  };
}
async function rpc(provider, method, params = []) {
  if (!provider || typeof provider.request !== 'function') throw new Error('EIP-1193 provider required');
  return provider.request({method, params});
}
export async function assertChain(provider, chainId) {
  const actual = Number(BigInt(await rpc(provider, 'eth_chainId')));
  if (actual !== Number(chainId)) throw new Error(`Wrong chain: expected ${chainId}, got ${actual}`);
}

/** Wrap an HTTP JSON-RPC endpoint as an EIP-1193-compatible read provider. */
export function httpRpcProvider(url, fetchImpl = globalThis.fetch) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('HTTP(S) RPC URL required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
  let nextId = 1;
  return {
    async request({method, params = []}) {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({jsonrpc: '2.0', id: nextId++, method, params}),
      });
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      const body = await response.json();
      if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
      if (!('result' in body)) throw new Error('Malformed RPC result');
      return body.result;
    }
  };
}

/** Create an independent application signing identity. Keep the private key secure. */
export async function createIdentity({extractable = false} = {}) {
  const pair = await crypto.subtle.generateKey({name: 'Ed25519'}, extractable, ['sign', 'verify']);
  return {
    publicKey: toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    privateKey: pair.privateKey,
  };
}
/** Optional backup facility. Use encrypted storage; never post this value. */
export async function exportPrivateKey(privateKey) {
  return toHex(new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey)));
}
export async function importPrivateKey(pkcs8Hex) {
  if (typeof pkcs8Hex !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(pkcs8Hex)) {
    throw new Error('Invalid PKCS#8 hex');
  }
  const privateKey = await crypto.subtle.importKey('pkcs8', hexBytes(pkcs8Hex),
    {name: 'Ed25519'}, false, ['sign']);
  return privateKey;
}

/** Verifiers should issue challenges, keeping nonces unique per audience. */
export function createChallenge(audience, {ttlSeconds = 120, now = Math.floor(Date.now() / 1000)} = {}) {
  validAudience(audience);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300) {
    throw new Error('ttlSeconds must be 1..300');
  }
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return {audience, nonce: toHex(bytes), issuedAt: now, expiresAt: now + ttlSeconds};
}
function validAudience(audience) {
  if (typeof audience !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,127}$/.test(audience)) {
    throw new Error('Invalid audience');
  }
}
function validateChallenge(challenge, now, maxTtl = 300) {
  if (!challenge || typeof challenge !== 'object') throw new Error('Missing challenge');
  validAudience(challenge.audience);
  if (typeof challenge.nonce !== 'string' || !/^0x[0-9a-fA-F]{32,128}$/.test(challenge.nonce)) {
    throw new Error('Invalid challenge nonce');
  }
  if (!Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) ||
      challenge.expiresAt <= challenge.issuedAt || challenge.expiresAt - challenge.issuedAt > maxTtl) {
    throw new Error('Invalid challenge lifetime');
  }
  if (now < challenge.issuedAt - 30 || now >= challenge.expiresAt) throw new Error('Expired or future challenge');
}
export function authenticationMessage({chainId, contract, wallet, publicKey, challenge}) {
  const c = challenge;
  validAudience(c.audience);
  if (typeof c.nonce !== 'string' || !/^0x[0-9a-fA-F]{32,128}$/.test(c.nonce) ||
      !Number.isSafeInteger(c.issuedAt) || !Number.isSafeInteger(c.expiresAt)) {
    throw new Error('Invalid challenge');
  }
  if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) < 1) throw new Error('Invalid chain');
  return textEncoder.encode([
    'PortableStake-Ed25519-auth-v1',
    `chainId=${chainId}`,
    `contract=${assertAddress(contract)}`,
    `wallet=${assertAddress(wallet)}`,
    `publicKey=${assertPublicKey(publicKey)}`,
    `audience=${c.audience}`,
    `nonce=${c.nonce.toLowerCase()}`,
    `issuedAt=${c.issuedAt}`,
    `expiresAt=${c.expiresAt}`,
  ].join('\n'));
}
export async function signCredential({chainId, contract, wallet, publicKey, privateKey, challenge}) {
  const message = authenticationMessage({chainId, contract, wallet, publicKey, challenge});
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  return {wallet: assertAddress(wallet), publicKey: assertPublicKey(publicKey),
    signature: toHex(new Uint8Array(signature))};
}

/**
 * Sign the exact bytes of an application-defined, canonical content payload.
 * The audience is domain separation; choose a stable app/protocol identifier.
 */
function contentMessage(audience, content) {
  validAudience(audience);
  const body = typeof content === 'string' ? textEncoder.encode(content) : content;
  if (!(body instanceof Uint8Array)) throw new Error('content must be a string or Uint8Array');
  const prefix = textEncoder.encode(`PortableStake-Ed25519-content-v1\naudience=${audience}\nlength=${body.length}\n`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix);
  message.set(body, prefix.length);
  return message;
}
export async function signContent({privateKey, audience, content}) {
  return toHex(new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey,
    contentMessage(audience, content))));
}
export async function verifyContentSignature({publicKey, audience, content, signature}) {
  const key = await crypto.subtle.importKey('raw', hexBytes(assertPublicKey(publicKey)),
    {name: 'Ed25519'}, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, hexBytes(requireHex(signature, 64, 'signature')),
    contentMessage(audience, content));
}

/** Single read-only RPC check; no gas, no on-chain signing, no indexer required. */
export async function readPosition({provider, contract, wallet, asset = NATIVE_ASSET, blockTag = 'latest'}) {
  const data = calldata(SELECTORS.positionOf, [wallet, asset], ['address', 'address']);
  const raw = await rpc(provider, 'eth_call', [{to: assertAddress(contract), data}, blockTag]);
  return decodePosition(raw);
}

/**
 * Verify a trusted, verifier-issued challenge against an active on-chain position.
 * IMPORTANT: use an independently operated node/RPC, not the claimant's RPC.
 * IMPORTANT: applications must implement consumeNonce to prevent replay.
 */
export async function verifyCredential({provider, chainId, contract, asset = NATIVE_ASSET,
  minimumAmount = 1n, challenge, proof, consumeNonce, now = Math.floor(Date.now() / 1000),
  checkChain = true, blockTag = 'latest'} = {}) {
  validateChallenge(challenge, now);
  if (!proof || typeof proof !== 'object') throw new Error('Missing proof');
  const wallet = assertAddress(proof.wallet);
  const publicKey = assertPublicKey(proof.publicKey);
  const signature = requireHex(proof.signature, 64, 'signature');
  if (typeof consumeNonce !== 'function') throw new Error('consumeNonce callback required (anti-replay)');
  if (BigInt(minimumAmount) < 1n) throw new Error('minimumAmount must be positive');

  const msg = authenticationMessage({chainId, contract, wallet, publicKey, challenge});
  const publicCryptoKey = await crypto.subtle.importKey('raw', hexBytes(publicKey),
    {name: 'Ed25519'}, false, ['verify']);
  const authentic = await crypto.subtle.verify('Ed25519', publicCryptoKey, hexBytes(signature), msg);
  if (!authentic) return {ok: false, reason: 'INVALID_SIGNATURE'};
  if (checkChain) await assertChain(provider, chainId);

  const pos = await readPosition({provider, contract, wallet, asset, blockTag});
  if (pos.publicKey !== publicKey) return {ok: false, reason: 'KEY_MISMATCH', position: pos};
  if (!pos.active) return {ok: false, reason: 'NOT_ACTIVE', position: pos};
  if (pos.amount < BigInt(minimumAmount)) return {ok: false, reason: 'INSUFFICIENT_STAKE', position: pos};

  // Caller must atomically mark this nonce as used. Only after all other checks pass.
  const consumed = await consumeNonce(challenge.audience, challenge.nonce);
  if (consumed !== true) return {ok: false, reason: 'NONCE_ALREADY_USED'};
  return {ok: true, wallet, publicKey, amount: pos.amount, asset: assertAddress(asset),
    checkedAt: now, blockTag};
}

async function send({provider, from, to, data, value = 0n}) {
  return rpc(provider, 'eth_sendTransaction', [{from: assertAddress(from), to: assertAddress(to),
    data, value: '0x' + BigInt(value).toString(16)}]);
}
export async function depositNative({provider, chainId, contract, from, publicKey, amount}) {
  await assertChain(provider, chainId);
  if (BigInt(amount) <= 0n) throw new Error('amount must be positive');
  return send({provider, from, to: contract, value: amount,
    data: calldata(SELECTORS.depositNative, [publicKey], ['key'])});
}
export async function approveToken({provider, chainId, token, from, spender, amount}) {
  await assertChain(provider, chainId);
  return send({provider, from, to: token,
    data: calldata(SELECTORS.approve, [spender, amount], ['address', 'uint'])});
}
export async function depositToken({provider, chainId, contract, from, token, publicKey, amount}) {
  await assertChain(provider, chainId);
  if (BigInt(amount) <= 0n) throw new Error('amount must be positive');
  return send({provider, from, to: contract,
    data: calldata(SELECTORS.depositToken, [token, amount, publicKey], ['address', 'uint', 'key'])});
}
export async function requestExit({provider, chainId, contract, from, asset = NATIVE_ASSET}) {
  await assertChain(provider, chainId);
  return send({provider, from, to: contract,
    data: calldata(SELECTORS.requestExit, [asset], ['address'])});
}
export async function withdraw({provider, chainId, contract, from, asset = NATIVE_ASSET}) {
  await assertChain(provider, chainId);
  return send({provider, from, to: contract,
    data: calldata(SELECTORS.withdraw, [asset], ['address'])});
}

/** Poll a wallet transaction until included; L2 finality may require longer. */
export async function waitForReceipt(provider, hash, {attempts = 80, pollMs = 2000} = {}) {
  requireHex(hash, 32, 'transaction hash');
  for (let i = 0; i < attempts; i++) {
    const r = await rpc(provider, 'eth_getTransactionReceipt', [hash]);
    if (r) {
      if (r.status !== '0x1') throw new Error('Transaction reverted: ' + hash);
      return r;
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error('Receipt not found within polling limit: ' + hash);
}