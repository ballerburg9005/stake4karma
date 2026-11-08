/** Stake4Karma test server: serves UI, stores public registrations, verifies stake on-chain.
 * No wallet private keys or credential private keys are accepted or stored.
 * Node >=22, no npm dependencies. This is a test server, not production hosting.
 */
import {createServer} from 'node:http';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {existsSync, readFileSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {randomBytes, webcrypto} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {readPosition, assertAddress, assertPublicKey, authenticationMessage, httpRpcProvider, assertChain, NATIVE_ASSET} from './src/stake.js';

const root = dirname(fileURLToPath(import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)\s*$/.exec(line);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const chainId = Number(process.env.CHAIN_ID || 84532);
if (!Number.isSafeInteger(chainId) || chainId < 1) throw new Error('Invalid CHAIN_ID');
const contract = process.env.STAKE_CONTRACT ? assertAddress(process.env.STAKE_CONTRACT) : null;
const rpcUrl = process.env.RPC_URL || 'https://sepolia.base.org';
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const dataPath = resolve(root, process.env.DATA_FILE || './data/registrations.json');
const audience = 'stake4karma.test';
const provider = httpRpcProvider(rpcUrl);
const challenges = new Map();
const rateLimits = new Map();
let records = [];
let leaderboardCache = null;
let writeQueue = Promise.resolve();

async function loadRecords() {
  try {
    const parsed = JSON.parse(await readFile(dataPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('Bad registration database');
    records = parsed.filter(r => r && typeof r === 'object');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function saveRecords() {
  // Serialize concurrent updates; writes are atomic on a single local filesystem.
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(dataPath), {recursive: true});
    const temp = `${dataPath}.${process.pid}.${randomBytes(5).toString('hex')}.tmp`;
    await writeFile(temp, JSON.stringify(records, null, 2) + '\n', {mode: 0o600});
    await rename(temp, dataPath);
  });
  return writeQueue;
}
function send(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra});
  res.end(data);
}
async function parseJson(req) {
  const parts = [];
  let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > 24000) throw Object.assign(new Error('Request too large'), {status: 413});
    parts.push(part);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), {status: 400}); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('JSON object required'), {status: 400});
  }
  return value;
}
function throttle(req) {
  const ip = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (rateLimits.size > 2000) for (const [id, v] of rateLimits) if (now > v.reset) rateLimits.delete(id);
  let r = rateLimits.get(ip);
  if (!r || now > r.reset) r = {reset: now + 60000, count: 0};
  r.count += 1;
  rateLimits.set(ip, r);
  if (r.count > 30) throw Object.assign(new Error('Too many requests'), {status: 429});
}
function hexBytes(hex) { return Uint8Array.from(hex.slice(2).match(/../g) || [], x => parseInt(x, 16)); }
function keyZero() { return '0x' + '00'.repeat(20); }

async function createChallenge(req, res) {
  const input = await parseJson(req);
  const wallet = assertAddress(input.wallet);
  const publicKey = assertPublicKey(input.publicKey);
  const now = Math.floor(Date.now() / 1000);
  for (const [nonce, item] of challenges) if (item.expiresAt <= now) challenges.delete(nonce);
  if (challenges.size > 3000) throw Object.assign(new Error('Busy; retry later'), {status: 429});
  const challenge = {audience, nonce: '0x' + randomBytes(24).toString('hex'), issuedAt: now, expiresAt: now + 120};
  challenges.set(challenge.nonce, {wallet, publicKey, ...challenge});
  send(res, 200, {challenge, chainId, contract: contract || keyZero()});
}
async function register(req, res) {
  const input = await parseJson(req);
  if (typeof input.handle !== 'string' || !/^[\p{L}\p{N}_ .-]{2,24}$/u.test(input.handle.trim())) {
    throw Object.assign(new Error('Name must be 2–24 letters, numbers, spaces, underscores, hyphens or dots'), {status: 400});
  }
  const handle = input.handle.trim();
  const proof = input.proof;
  if (!proof || typeof proof !== 'object' || typeof proof.signature !== 'string') {
    throw Object.assign(new Error('Missing credential signature'), {status: 400});
  }
  const wallet = assertAddress(proof.wallet);
  const publicKey = assertPublicKey(proof.publicKey);
  if (!/^0x[0-9a-fA-F]{128}$/.test(proof.signature)) {
    throw Object.assign(new Error('Invalid credential signature'), {status: 400});
  }
  const nonce = input.nonce;
  const issued = challenges.get(nonce);
  // Consume the challenge on the first attempted registration; prevents replay.
  challenges.delete(nonce);
  if (!issued || issued.expiresAt <= Math.floor(Date.now() / 1000) ||
      wallet !== issued.wallet || publicKey !== issued.publicKey) {
    throw Object.assign(new Error('Expired, incorrect or already used challenge'), {status: 401});
  }
  const challenge = {audience: issued.audience, nonce: issued.nonce, issuedAt: issued.issuedAt, expiresAt: issued.expiresAt};
  const message = authenticationMessage({chainId, contract: contract || keyZero(), wallet, publicKey, challenge});
  const pub = await webcrypto.subtle.importKey('raw', hexBytes(publicKey), {name: 'Ed25519'}, false, ['verify']);
  const valid = await webcrypto.subtle.verify('Ed25519', pub, hexBytes(proof.signature), message);
  if (!valid) throw Object.assign(new Error('Incorrect credential signature'), {status: 401});
  const existing = records.find(r => r.wallet === wallet && r.publicKey === publicKey);
  if (!existing && records.length >= 1000) throw Object.assign(new Error('Test registration limit reached'), {status: 429});
  if (existing) existing.handle = handle;
  else records.push({handle, wallet, publicKey, joinedAt: new Date().toISOString()});
  await saveRecords();
  leaderboardCache = null;
  send(res, 200, {ok: true, registered: {handle, wallet, publicKey}, note: 'Registration is not proof of stake; the leaderboard checks the blockchain separately.'});
}

async function leaderboard(req, res) {
  if (!contract) return send(res, 200, {configured: false, chainId, rows: [], pendingCount: records.length,
    note: 'A contract must be deployed and STAKE_CONTRACT configured before coins can be staked or verified.'});
  const now = Date.now();
  if (leaderboardCache && now < leaderboardCache.until) return send(res, 200, leaderboardCache.payload);
  // Trust the server-controlled RPC provider; never trust a claimant-supplied balance.
  await assertChain(provider, chainId);
  const all = [];
  const batchSize = 5;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = await Promise.all(records.slice(i, i + batchSize).map(async r => {
      const p = await readPosition({provider, contract, wallet: r.wallet, asset: NATIVE_ASSET});
      return p.active && p.publicKey === r.publicKey && p.amount > 0n
        ? {...r, amountWei: p.amount.toString()} : null;
    }));
    all.push(...batch.filter(Boolean));
  }
  all.sort((a, b) => {const d = BigInt(b.amountWei) - BigInt(a.amountWei); return d > 0n ? 1 : d < 0n ? -1 : a.joinedAt.localeCompare(b.joinedAt);});
  const rows = all.map((r, i) => ({rank: i + 1, ...r}));
  const payload = {configured: true, chainId, contract, rows, pendingCount: records.length - rows.length,
    checkedAt: new Date().toISOString(), asset: NATIVE_ASSET};
  leaderboardCache = {until: now + 15000, payload};
  send(res, 200, payload);
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/stake.js': ['../src/stake.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};
async function serveStatic(path, res) {
  const asset = assets[path];
  if (!asset) return send(res, 404, {error: 'Not found'});
  const bytes = await readFile(join(root, 'public', asset[0]));
  res.writeHead(200, {'content-type': asset[1], 'cache-control': 'no-cache',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' https://sepolia.base.org; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"});
  res.end(bytes);
}
await loadRecords();
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/config') return send(res, 200, {chainId, contract, rpcUrl, audience, asset: NATIVE_ASSET});
    if (req.method === 'GET' && url.pathname === '/api/leaderboard') return await leaderboard(req, res);
    if (req.method === 'POST' && ['/api/challenge', '/api/register'].includes(url.pathname)) {
      throttle(req);
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw Object.assign(new Error('Cross-origin registration blocked'), {status: 403});
      if (url.pathname === '/api/challenge') return await createChallenge(req, res);
      return await register(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res);
    send(res, 405, {error: 'Method not allowed'});
  } catch (error) {
    console.error(error);
    send(res, error.status || 503, {error: error.status ? error.message : 'Backend or RPC failed: ' + error.message});
  }
});
server.listen(port, host, () => console.log(`Stake4Karma test app: http://localhost:${port}\nContract: ${contract || 'not configured'}\nRPC: ${rpcUrl}\nDatabase: ${dataPath}`));