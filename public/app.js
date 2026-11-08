import {
  createIdentity, exportPrivateKey, importPrivateKey, signCredential,
  depositNative, requestExit, withdraw, readPosition, waitForReceipt, NATIVE_ASSET
} from './stake.js';

const $ = id => document.getElementById(id);
const state = {config: null, wallet: null, privateKey: null, publicKey: null, backedUp: false, registered: false, busy: false};
const text = new TextEncoder();
const decoder = new TextDecoder();
const ZERO = '0x' + '00'.repeat(20);

function notice(message, kind = '') {
  const element = $('notice');
  element.textContent = message;
  element.className = 'notice ' + kind;
  element.hidden = false;
}
function friendly(error) {
  const message = error?.message || String(error);
  if (error?.code === 4001) return 'Request rejected in your wallet.';
  return message.length > 280 ? message.slice(0, 280) + '…' : message;
}
function short(address) {return address ? `${address.slice(0, 7)}…${address.slice(-5)}` : '—';}
function formatEth(raw, places = 6) {
  const n = BigInt(raw);
  const whole = n / (10n ** 18n);
  const fraction = (n % (10n ** 18n)).toString().padStart(18, '0').slice(0, places).replace(/0+$/, '');
  return whole.toString() + (fraction ? '.' + fraction : '');
}
function parseEth(value) {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('Use a positive decimal amount with up to 18 places.');
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 10n ** 18n + BigInt((fraction + '0'.repeat(18)).slice(0, 18));
  if (n <= 0n) throw new Error('Amount must exceed zero.');
  return n;
}
function toB64(bytes) {return btoa(String.fromCharCode(...bytes));}
function fromB64(s) {return Uint8Array.from(atob(s), ch => ch.charCodeAt(0));}
async function deriveBackupKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', text.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256'},
    base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
async function encryptBackup(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, text.encode(JSON.stringify(payload))));
  return {format: 'stake4karma-encrypted-ed25519-v1', kdf: 'PBKDF2-SHA256', iterations: 250000,
    salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(ciphertext)};
}
async function decryptBackup(backup, password) {
  if (backup?.format !== 'stake4karma-encrypted-ed25519-v1' || backup.iterations !== 250000) {
    throw new Error('Unrecognized encrypted backup');
  }
  const salt = fromB64(backup.salt), iv = fromB64(backup.iv);
  if (salt.length !== 16 || iv.length !== 12) throw new Error('Invalid backup encryption parameters');
  const key = await deriveBackupKey(password, salt);
  const raw = await crypto.subtle.decrypt({name:'AES-GCM', iv}, key, fromB64(backup.ciphertext));
  return JSON.parse(decoder.decode(raw));
}
async function checkAndInstallIdentity(data) {
  if (data?.format !== 'stake4karma-ed25519-v1' ||
      !/^0x[0-9a-fA-F]{64}$/.test(data.publicKey) ||
      typeof data.privateKeyPkcs8 !== 'string') throw new Error('Invalid identity file');
  const privateKey = await importPrivateKey(data.privateKeyPkcs8);
  const publicKey = await crypto.subtle.importKey('raw', fromHex(data.publicKey), {name:'Ed25519'}, false, ['verify']);
  const message = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign('Ed25519', privateKey, message);
  if (!await crypto.subtle.verify('Ed25519', publicKey, signature, message)) {
    throw new Error('Private key does not match the advertised public key');
  }
  state.privateKey = privateKey;
  state.publicKey = data.publicKey.toLowerCase();
  state.backedUp = true;
  state.registered = false;
  $('identityPublic').textContent = state.publicKey;
  $('backupStatus').textContent = 'Imported identity verified. Keep the encrypted backup and its password safe.';
  syncUi();
}
function fromHex(hex) {return Uint8Array.from((hex.slice(2).match(/../g) || []), n => parseInt(n, 16));}
async function api(path, input) {
  const opts = input === undefined ? {} : {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(input)};
  const response = await fetch(path, opts);
  let json;
  try { json = await response.json(); } catch { throw new Error(`Unexpected response from ${path}`); }
  if (!response.ok) throw new Error(json.error || `HTTP ${response.status}`);
  return json;
}
async function withAction(action, message) {
  if (state.busy) return;
  state.busy = true;
  syncUi();
  try {await action(); if (message) notice(message, 'success');}
  catch (err) {notice(friendly(err), 'error'); console.error(err);}
  finally {state.busy = false; syncUi();}
}
function syncUi() {
  const identity = !!state.privateKey;
  $('walletStatus').textContent = state.wallet ? `Connected: ${state.wallet}` : 'Not connected';
  $('connectBtn').textContent = state.wallet ? short(state.wallet) : 'Connect wallet';
  $('createBtn').disabled = state.busy;
  $('backupBtn').disabled = state.busy || !identity;
  $('registerBtn').disabled = state.busy || !state.wallet || !identity;
  $('stakeBtn').disabled = state.busy || !state.wallet || !identity || !state.backedUp || !state.config?.contract;
  $('exitBtn').disabled = state.busy || !state.wallet || !state.config?.contract;
  $('withdrawBtn').disabled = state.busy || !state.wallet || !state.config?.contract;
  $('refreshBtn').disabled = state.busy;
  if (!identity) $('identityPublic').textContent = 'No identity loaded';
  $('configWarning').hidden = !!state.config?.contract;
}
function provider() {
  if (!window.ethereum?.request) throw new Error('No injected browser wallet found. Install MetaMask or another EIP-1193 wallet extension.');
  return window.ethereum;
}
async function switchChain() {
  const wallet = provider();
  const current = Number(BigInt(await wallet.request({method:'eth_chainId'})));
  if (current === state.config.chainId) return;
  const chainId = '0x' + state.config.chainId.toString(16);
  try {await wallet.request({method:'wallet_switchEthereumChain',params:[{chainId}]});}
  catch (error) {
    if (error.code !== 4902 && error.data?.originalError?.code !== 4902) throw error;
    if (state.config.chainId !== 84532) throw new Error('Unknown chain. Add it manually in your wallet.');
    await wallet.request({method:'wallet_addEthereumChain',params:[{
      chainId, chainName:'Base Sepolia', nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},
      rpcUrls:[state.config.rpcUrl],blockExplorerUrls:['https://sepolia.basescan.org']
    }]});
  }
}
async function connect() {
  await switchChain();
  const accounts = await provider().request({method:'eth_requestAccounts'});
  if (!accounts?.[0]) throw new Error('Wallet did not provide an account');
  const old = state.wallet;
  state.wallet = accounts[0].toLowerCase();
  if (old !== state.wallet) state.registered = false;
  syncUi();
  await readWalletBalance();
  await checkPosition();
  notice(`Connected wallet ${short(state.wallet)} on Base Sepolia.`, 'success');
}
async function readWalletBalance() {
  if (!state.wallet) return;
  const hex = await provider().request({method:'eth_getBalance',params:[state.wallet,'latest']});
  $('balance').textContent = `Wallet balance: ${formatEth(BigInt(hex), 8)} test ETH`;
}
async function checkPosition() {
  if (!state.wallet || !state.config?.contract) {
    $('positionText').textContent = 'Not configured';
    $('positionMeta').textContent = '';
    return;
  }
  const p = await readPosition({provider: provider(), contract: state.config.contract,
    wallet: state.wallet, asset: NATIVE_ASSET});
  $('positionText').textContent = `${formatEth(p.amount, 8)} test ETH`;
  const match = !!state.publicKey && p.publicKey.toLowerCase() === state.publicKey.toLowerCase();
  if (p.active) $('positionMeta').textContent = match ? 'Active · bound to your loaded key' : 'Active · bound to a different credential key';
  else if (p.exitRequestedAt) $('positionMeta').textContent = `Exit requested · withdraw after ${new Date(p.withdrawalAvailableAt * 1000).toLocaleString()}`;
  else $('positionMeta').textContent = 'No active position in this wallet';
}
async function generate() {
  if (state.privateKey && !confirm('Replace the loaded identity? Do not proceed without a backup, especially if it is already bound to a stake.')) return;
  const pair = await createIdentity({extractable: true});
  state.privateKey = pair.privateKey;
  state.publicKey = pair.publicKey;
  state.backedUp = false;
  state.registered = false;
  $('identityPublic').textContent = state.publicKey;
  $('backupStatus').textContent = 'New key generated locally. DOWNLOAD AN ENCRYPTED BACKUP before staking.';
  notice('New Ed25519 identity generated inside your browser. Back it up before staking.', 'success');
}
async function downloadBackup() {
  const password = $('backupPassword').value;
  if (password.length < 10) throw new Error('Choose a backup password at least 10 characters long.');
  const raw = {format:'stake4karma-ed25519-v1', publicKey: state.publicKey,
    privateKeyPkcs8: await exportPrivateKey(state.privateKey)};
  const encrypted = await encryptBackup(raw, password);
  const blob = new Blob([JSON.stringify(encrypted,null,2)+'\n'],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = `stake4karma-key-${state.publicKey.slice(2,10)}.json`;
  document.body.append(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
  $('backupPassword').value = '';
  state.backedUp = true;
  $('backupStatus').textContent = 'Backup generated. Confirm it was actually saved and retain your password. Never publish this file.';
}
async function importBackup(file) {
  if (!file) return;
  if (file.size > 20000) throw new Error('Credential file is too large');
  const data = JSON.parse(await file.text());
  if (data.format === 'stake4karma-encrypted-ed25519-v1') {
    const password = $('importPassword').value;
    if (!password) throw new Error('Enter the backup password to import this encrypted file');
    await checkAndInstallIdentity(await decryptBackup(data, password));
  } else if (data.format === 'stake4karma-ed25519-v1') {
    if (!confirm('This is an UNENCRYPTED private key file. Do not use or upload it elsewhere. Import for this session?')) return;
    await checkAndInstallIdentity(data);
  } else throw new Error('This version supports Ed25519 keys, not arbitrary PGP key files');
  $('importPassword').value = '';
}
async function register() {
  if (!state.wallet || !state.privateKey) throw new Error('Connect a wallet and load a credential first.');
  const handle = $('handle').value.trim();
  const {challenge, chainId, contract} = await api('/api/challenge', {wallet: state.wallet, publicKey: state.publicKey});
  const proof = await signCredential({chainId,contract,wallet:state.wallet,publicKey:state.publicKey,
    privateKey:state.privateKey,challenge});
  await api('/api/register', {handle, nonce:challenge.nonce, proof});
  state.registered = true;
  $('registeredStatus').textContent = 'Registered. Your ranking only activates when the server verifies an on-chain deposit bound to this same key.';
  await refreshLeaderboard();
}
async function sendDeposit() {
  if (!state.backedUp) throw new Error('Download an encrypted key backup before locking coins.');
  if (!state.registered) throw new Error('Register your identity first so your stake appears on the board.');
  const amount = parseEth($('stakeAmount').value.trim());
  await switchChain();
  const hash = await depositNative({provider:provider(),chainId:state.config.chainId,contract:state.config.contract,
    from:state.wallet,publicKey:state.publicKey,amount});
  showTx(hash);
  notice('Deposit submitted. Confirming the blockchain transaction…');
  await waitForReceipt(provider(),hash);
  await Promise.all([checkPosition(), readWalletBalance(), refreshLeaderboard()]);
}
function showTx(hash) {
  const element = $('txLink');
  element.href = `https://sepolia.basescan.org/tx/${hash}`;
  element.hidden = false;
}
async function exitPosition() {
  if (!confirm('Request exit? After the transaction confirms your stake will immediately stop counting on the high-score board, but the coins remain locked until the withdrawal date.')) return;
  await switchChain();
  const hash = await requestExit({provider:provider(),chainId:state.config.chainId,contract:state.config.contract,
    from:state.wallet,asset:NATIVE_ASSET});
  showTx(hash);
  await waitForReceipt(provider(),hash);
  await checkPosition();
  await refreshLeaderboard();
}
async function withdrawPosition() {
  await switchChain();
  const hash = await withdraw({provider:provider(),chainId:state.config.chainId,contract:state.config.contract,
    from:state.wallet,asset:NATIVE_ASSET});
  showTx(hash);
  await waitForReceipt(provider(),hash);
  await Promise.all([checkPosition(), readWalletBalance(), refreshLeaderboard()]);
}
async function refreshLeaderboard() {
  const data = await api('/api/leaderboard');
  $('entryCount').textContent = data.rows.length;
  const sum = data.rows.reduce((n,r) => n + BigInt(r.amountWei), 0n);
  $('totalLocked').textContent = formatEth(sum, 5);
  $('boardTime').textContent = data.checkedAt ? `Verified ${new Date(data.checkedAt).toLocaleTimeString()}` : 'Contract not configured';
  const root = $('leaderboardBody');
  root.replaceChildren();
  if (!data.rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = data.configured
      ? 'No verified stakers yet. Connect a wallet, register a key, and lock some test ETH to claim the first rank.'
      : 'Waiting for the Base Sepolia contract to be deployed. Registration can be tested already.';
    root.append(p); return;
  }
  for (const r of data.rows) {
    const row = document.createElement('div'); row.className = 'board-row';
    const rank = document.createElement('span'); rank.className='rank'; rank.textContent = `#${r.rank}`;
    const owner = document.createElement('div');
    const nick = document.createElement('div'); nick.className='board-name'; nick.textContent=r.handle;
    const address = document.createElement('div'); address.className='board-address'; address.textContent=short(r.wallet);
    owner.append(nick,address);
    const score = document.createElement('div'); score.className='board-value';
    score.textContent=formatEth(r.amountWei,7);
    const units = document.createElement('small'); units.textContent='TEST ETH LOCKED'; score.append(units);
    row.append(rank,owner,score); root.append(row);
  }
}
function hook(id, fn) {$(id).addEventListener('click', () => withAction(fn));}

async function init() {
  state.config = await api('/api/config');
  $('networkPill').textContent = state.config.chainId === 84532 ? 'Base Sepolia · testnet' : `Chain ${state.config.chainId} · developer mode`;
  syncUi();
  hook('connectBtn', connect);
  hook('createBtn', generate);
  hook('backupBtn', downloadBackup);
  hook('registerBtn', register);
  hook('stakeBtn', async() => {await sendDeposit();notice('Deposit confirmed. The public board refreshes from verified chain state (up to 15s cache).','success');});
  hook('exitBtn', async() => {await exitPosition();notice('Exit transaction confirmed. Stake no longer counts after the board cache refreshes.','success');});
  hook('withdrawBtn', async() => {await withdrawPosition();notice('Withdrawal transaction confirmed. Coins have returned to your wallet.','success');});
  hook('refreshBtn', refreshLeaderboard);
  $('importFile').addEventListener('change', event => withAction(async() => {await importBackup(event.target.files[0]);event.target.value='';notice('Identity imported and verified.','success');}));
  window.ethereum?.on?.('accountsChanged', accounts => {
    state.wallet = accounts?.[0]?.toLowerCase() || null; state.registered = false; syncUi();
    if (state.wallet) {readWalletBalance().catch(console.error);checkPosition().catch(console.error);}
  });
  window.ethereum?.on?.('chainChanged', () => {state.registered = false;syncUi();});
  await refreshLeaderboard();
}
init().catch(error => {notice(`Setup error: ${friendly(error)}`, 'error');console.error(error);});