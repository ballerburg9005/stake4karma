import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdentity, createChallenge, signCredential, verifyCredential, signContent, verifyContentSignature,
  exportPrivateKey, importPrivateKey, readPosition, readLockRules, assertCompatibleWalletKey, depositNative,
  depositToken, approveToken, requestExit, withdraw, NATIVE_ASSET,
  SELECTORS
} from '../src/stake.js';

const contract = '0x' + 'ab'.repeat(20);
const wallet = '0x' + 'cd'.repeat(20);
const token = '0x' + 'ef'.repeat(20);
const amount = 42_000_000n;
const chainId = 8453;
const byteWord = value => BigInt(value).toString(16).padStart(64, '0');
function posResult(publicKey, coins = amount, active = true, withdrawal = 0, exit = 0) {
  return '0x' + publicKey.slice(2) + [coins, BigInt(active), BigInt(withdrawal), BigInt(exit)].map(byteWord).join('');
}
function providerFor(positionResponse, {chain = '0x2105'} = {}) {
  const calls = [];
  const provider = {
    async request({method, params}) {
      calls.push({method, params});
      if (method === 'eth_chainId') return chain;
      if (method === 'eth_call') return positionResponse;
      if (method === 'eth_sendTransaction') return '0x' + '12'.repeat(32);
      throw new Error('Unknown mocked RPC ' + method);
    }
  };
  return {provider, calls};
}

function consumedOnce() {
  const used = new Set();
  return async (audience, nonce) => {
    const id = audience + '/' + nonce;
    if (used.has(id)) return false;
    used.add(id);
    return true;
  };
}

test('Ed25519 credential verifies with exactly one read-only eth_call', async () => {
  const identity = await createIdentity();
  assert.equal(identity.publicKey.length, 66);
  const challenge = createChallenge('imageboard.example');
  const proof = await signCredential({chainId, contract, wallet, ...identity, challenge});
  const {provider, calls} = providerFor(posResult(identity.publicKey));
  const consumeNonce = consumedOnce();
  const verified = await verifyCredential({provider, chainId, contract, asset: token,
    minimumAmount: amount, expectedAudience: challenge.audience, challenge, proof, consumeNonce});
  assert.equal(verified.ok, true);
  assert.equal(verified.amount, amount);
  assert.deepEqual(calls.map(x => x.method), ['eth_chainId', 'eth_call']);
  assert.equal(calls[1].params[0].data.slice(0, 10), SELECTORS.positionOf);
  const replay = await verifyCredential({provider, chainId, contract, asset: token,
    minimumAmount: amount, expectedAudience: challenge.audience, challenge, proof, consumeNonce});
  assert.deepEqual({ok: replay.ok, reason: replay.reason}, {ok: false, reason: 'NONCE_ALREADY_USED'});
});

test('does not accept a mismatching public key, exited stake, or inadequate amount', async () => {
  const identity = await createIdentity();
  const otherIdentity = await createIdentity();
  const challenge = createChallenge('storage.peer');
  const proof = await signCredential({chainId, contract, wallet, ...identity, challenge});
  for (const [positionResponse, expected] of [
    [posResult(otherIdentity.publicKey), 'KEY_MISMATCH'],
    [posResult(identity.publicKey, 42_000_000n, false, 123, 111), 'NOT_ACTIVE'],
    [posResult(identity.publicKey, 1n), 'INSUFFICIENT_STAKE']
  ]) {
    const {provider} = providerFor(positionResponse);
    const result = await verifyCredential({provider, chainId, contract, asset: token,
      minimumAmount: amount, expectedAudience: challenge.audience, challenge, proof, consumeNonce: consumedOnce()});
    assert.equal(result.reason, expected);
  }
});

test('rejects tampered context, wrong chain, future/expired challenge', async () => {
  const identity = await createIdentity();
  const challenge = createChallenge('p2p.example');
  const proof = await signCredential({chainId, contract, wallet, ...identity, challenge});
  const {provider} = providerFor(posResult(identity.publicKey));
  const tampered = {...proof, wallet: '0x' + 'ff'.repeat(20)};
  assert.equal((await verifyCredential({provider, chainId, contract, expectedAudience: challenge.audience, challenge,
    proof: tampered, consumeNonce: consumedOnce()})).reason, 'INVALID_SIGNATURE');
  assert.equal((await verifyCredential({provider, chainId: 1, contract, expectedAudience: challenge.audience, challenge,
    proof, consumeNonce: consumedOnce()})).reason, 'INVALID_SIGNATURE');
  assert.equal((await verifyCredential({provider, chainId, contract, expectedAudience: 'a.different.app',
    challenge, proof, consumeNonce: consumedOnce()})).reason, 'AUDIENCE_MISMATCH');
  await assert.rejects(() => verifyCredential({provider, chainId, contract, challenge,
    proof, consumeNonce: consumedOnce()}), /Invalid audience/);
  const {provider: wrongChain} = providerFor(posResult(identity.publicKey), {chain: '0x1'});
  await assert.rejects(() => verifyCredential({provider: wrongChain, chainId, contract, expectedAudience: challenge.audience,
    challenge, proof, consumeNonce: consumedOnce()}), /Wrong chain/);
  await assert.rejects(() => verifyCredential({provider, chainId, contract, expectedAudience: challenge.audience,
    challenge: {...challenge, expiresAt: challenge.issuedAt - 1}, proof, consumeNonce: consumedOnce()}),
    /Invalid challenge lifetime/);
  await assert.rejects(() => verifyCredential({provider, chainId, contract, expectedAudience: challenge.audience,
    challenge, proof}), /consumeNonce callback required/);
});

test('private-key optional encrypted-backup workflow', async () => {
  const identity = await createIdentity({extractable: true});
  const backup = await exportPrivateKey(identity.privateKey);
  const restored = await importPrivateKey(backup);
  const challenge = createChallenge('backup.example');
  const proof = await signCredential({chainId, contract, wallet, publicKey: identity.publicKey,
    privateKey: restored, challenge});
  assert.equal((await verifyCredential({provider: providerFor(posResult(identity.publicKey)).provider,
    chainId, contract, expectedAudience: challenge.audience, challenge, proof, consumeNonce: consumedOnce()})).ok, true);
});

test('ABI encoding sends expected selectors and wallet-approved transactions', async () => {
  const identity = await createIdentity();
  const {provider, calls} = providerFor(posResult(identity.publicKey));
  await depositNative({provider, chainId, contract, from: wallet, publicKey: identity.publicKey, amount: 1_000n});
  await approveToken({provider, chainId, token, from: wallet, spender: contract, amount});
  await depositToken({provider, chainId, contract, from: wallet, token, publicKey: identity.publicKey, amount});
  await requestExit({provider, chainId, contract, from: wallet, asset: token});
  await withdraw({provider, chainId, contract, from: wallet, asset: token});
  const txs = calls.filter(x => x.method === 'eth_sendTransaction').map(x => x.params[0]);
  assert.equal(txs.length, 5);
  assert.deepEqual(txs.map(x => x.data.slice(0, 10)), [
    SELECTORS.depositNative, SELECTORS.approve, SELECTORS.depositToken,
    SELECTORS.requestExit, SELECTORS.withdraw
  ]);
  assert.equal(txs[0].value, '0x3e8');
  assert.equal(txs[2].value, '0x0');
  assert.equal(txs[2].data.length, 10 + 64 * 3);
  const read = await readPosition({provider, contract, wallet, asset: NATIVE_ASSET});
  assert.equal(read.amount, amount);
  assert.equal(read.publicKey, identity.publicKey);
});

test('rejects bad RPC result instead of treating it as empty/unlocked', async () => {
  const {provider} = providerFor('0x');
  await assert.rejects(() => readPosition({provider, contract, wallet}), /Invalid positionOf response/);
});

test('portable content signatures bind exact bytes and application audience', async () => {
  const {publicKey, privateKey} = await createIdentity();
  const content = new TextEncoder().encode('my post bytes');
  const signature = await signContent({privateKey, audience: 'imageboard.example', content});
  assert.equal(await verifyContentSignature({publicKey, audience: 'imageboard.example', content, signature}), true);
  assert.equal(await verifyContentSignature({publicKey, audience: 'other.example', content, signature}), false);
  assert.equal(await verifyContentSignature({publicKey, audience: 'imageboard.example',
    content: 'my post bytes!', signature}), false);
});


test('reads immutable contract lock delays and rejects invalid responses', async () => {
  const calls=[];
  const provider={async request({method,params}) {
    assert.equal(method, 'eth_call');
    calls.push(params[0].data);
    if(params[0].data === SELECTORS.minHold) return '0x' + byteWord(86400n);
    if(params[0].data === SELECTORS.exitDelay) return '0x' + byteWord(604800n);
    throw new Error('Unexpected selector');
  }};
  assert.deepEqual(await readLockRules({provider, contract}),
    {minHoldSeconds:86400n, exitDelaySeconds:604800n});
  assert.deepEqual(calls,[SELECTORS.minHold, SELECTORS.exitDelay]);
  await assert.rejects(() => readLockRules({provider:{request:async()=> '0x'},contract}),
    /Invalid MIN_HOLD response/);
  await assert.rejects(() => readLockRules({provider:{request:async()=> '0x'+byteWord(0)},contract}),
    /Invalid MIN_HOLD duration/);
});


test('identity preflight prevents mismatched keys and deposits during pending exit', () => {
  const own='0x'+'c3'.repeat(32), different='0x'+'d4'.repeat(32);
  const empty={publicKey:'0x'+'00'.repeat(32),exitRequestedAt:0};
  const matching={publicKey:own,exitRequestedAt:0};
  assert.equal(assertCompatibleWalletKey(empty,own),empty);
  assert.equal(assertCompatibleWalletKey(matching,own),matching);
  assert.throws(()=>assertCompatibleWalletKey(matching,different),/different public key/);
  assert.throws(()=>assertCompatibleWalletKey({...matching,exitRequestedAt:1},own),/pending exit/);
});
