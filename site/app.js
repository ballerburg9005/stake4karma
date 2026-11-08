import {
  createIdentity, exportPrivateKey, importPrivateKey, registerOnChain,
  depositNative, requestExit, withdraw, readPosition, readParticipantCount, readEntry,
  waitForReceipt, httpRpcProvider, assertChain, NATIVE_ASSET, assertAddress
} from './stake.js';

const $ = id => document.getElementById(id);
const state = {config: {chainId:84532, contract:null, rpcUrl:'https://sepolia.base.org'}, wallet:null, privateKey:null, publicKey:null, backedUp:false, registered:false, busy:false};
const text = new TextEncoder();
const decoder = new TextDecoder();


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

function noticeError(err) {notice(friendly(err),'error');console.error(err);}
function rpcReader() {return httpRpcProvider(state.config.rpcUrl);}
async function reader() {
  const http = rpcReader();
  try {await assertChain(http,84532);return http;}
  catch (err) {
    // Wallet RPC can serve as an alternative when public HTTP RPC has CORS or rate limits.
    if (window.ethereum?.request) {
      const w = window.ethereum;
      await assertChain(w,84532);
      return w;
    }
    throw err;
  }
}
async function withAction(fn) {
  if (state.busy) return;
  state.busy=true;syncUi();
  try {await fn();}
  catch(err) {noticeError(err);}
  finally {state.busy=false;syncUi();}
}
function syncUi() {
  $('walletStatus').textContent=state.wallet?`Connected: ${state.wallet}`:'Not connected';
  $('connectBtn').textContent=state.wallet?short(state.wallet):'Connect wallet';
  $('createBtn').disabled=state.busy;
  $('backupBtn').disabled=state.busy||!state.privateKey;
  $('registerBtn').disabled=state.busy||!state.wallet||!state.privateKey||!state.backedUp||!state.config.contract;
  $('stakeBtn').disabled=state.busy||!state.wallet||!state.privateKey||!state.backedUp||!state.config.contract;
  $('exitBtn').disabled=state.busy||!state.wallet||!state.config.contract;
  $('withdrawBtn').disabled=state.busy||!state.wallet||!state.config.contract;
  $('refreshBtn').disabled=state.busy;
  $('saveContractBtn').disabled=state.busy;
  $('saveRpcBtn').disabled=state.busy;
  $('configWarning').hidden=!!state.config.contract;
  if(!state.privateKey) $('identityPublic').textContent='No identity loaded';
}
function provider() {
  if (!window.ethereum?.request) throw new Error('Install a compatible browser wallet such as MetaMask.');
  return window.ethereum;
}
async function switchChain() {
  const p=provider();
  const chain=Number(BigInt(await p.request({method:'eth_chainId'})));
  if(chain===84532)return;
  try {await p.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]});}
  catch(error){
    if(error.code!==4902 && error.data?.originalError?.code!==4902)throw error;
    await p.request({method:'wallet_addEthereumChain',params:[{chainId:'0x14a34',chainName:'Base Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:[state.config.rpcUrl],blockExplorerUrls:['https://sepolia.basescan.org']}]});
  }
}
async function connect() {
  await switchChain();
  const accounts=await provider().request({method:'eth_requestAccounts'});
  if(!accounts?.[0])throw new Error('Wallet did not return an account');
  state.wallet=assertAddress(accounts[0]);state.registered=false;
  await Promise.all([readWalletBalance(),checkPosition()]);
  notice(`Connected ${short(state.wallet)} on Base Sepolia.`,'success');
}
async function readWalletBalance() {
  if(!state.wallet)return;
  const amount=await provider().request({method:'eth_getBalance',params:[state.wallet,'latest']});
  $('balance').textContent=`Wallet balance: ${formatEth(BigInt(amount),8)} test ETH`;
}
async function checkPosition() {
  if(!state.wallet||!state.config.contract) {
    $('positionText').textContent='Select a contract and connect';
    $('positionMeta').textContent='';return;
  }
  const p=await readPosition({provider:await reader(),contract:state.config.contract,wallet:state.wallet});
  $('positionText').textContent=`${formatEth(p.amount,8)} test ETH`;
  const keyMatch=state.publicKey&&p.publicKey===state.publicKey.toLowerCase();
  if(p.active) $('positionMeta').textContent=keyMatch?'Active · matches loaded credential':'Active · withdrawal needs only the connected wallet';
  else if(p.exitRequestedAt) $('positionMeta').textContent=`Exit pending · withdraw after ${new Date(p.withdrawalAvailableAt*1000).toLocaleString()}`;
  else if(p.publicKey!=='0x'+'00'.repeat(32)) $('positionMeta').textContent='Registered on-chain; no active stake';
  else $('positionMeta').textContent='No stake or registration yet';
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

function showTx(hash) {
  const a=$('txLink');a.href=`https://sepolia.basescan.org/tx/${hash}`;a.hidden=false;
}
async function performTransaction(sendFn, success) {
  await switchChain();
  const hash=await sendFn();showTx(hash);
  notice(`Transaction submitted: ${short(hash)}. Awaiting confirmation…`);
  await waitForReceipt(provider(),hash);
  await Promise.all([checkPosition(),readWalletBalance(),refreshLeaderboard()]);
  notice(success,'success');
}
async function register() {
  if(!state.wallet||!state.privateKey||!state.backedUp)throw new Error('Connect wallet and back up an identity before registering.');
  await performTransaction(()=>registerOnChain({provider:provider(),chainId:84532,contract:state.config.contract,
    from:state.wallet,publicKey:state.publicKey,handle:$('handle').value}),
    'Public name and credential key registered on-chain.');
  state.registered=true;
  $('registeredStatus').textContent='Registered on Base Sepolia; the contract is your directory, with no sign-up server.';
}
async function stake() {
  if(!state.backedUp||!state.privateKey)throw new Error('Create or import an identity and save its encrypted backup first.');
  const amount=parseEth($('stakeAmount').value.trim());
  await performTransaction(()=>depositNative({provider:provider(),chainId:84532,contract:state.config.contract,
    from:state.wallet,publicKey:state.publicKey,amount}),
    'Coins locked. Your wallet alone retains the right to request exit and withdraw.');
}
async function exitPosition() {
  if(!confirm('Request exit? Your stake stops earning a score immediately after confirmation, but funds stay locked until both contract delays expire.'))return;
  await performTransaction(()=>requestExit({provider:provider(),chainId:84532,contract:state.config.contract,
    from:state.wallet,asset:NATIVE_ASSET}), 'Exit requested. The withdrawal button works after the delay.');
}
async function withdrawPosition() {
  await performTransaction(()=>withdraw({provider:provider(),chainId:84532,contract:state.config.contract,
    from:state.wallet,asset:NATIVE_ASSET}), 'Funds returned to your wallet. No identity key was required.');
}
function drawLeaderboard(entries,total,partial) {
  const verified=entries.filter(x=>x.active && x.amount>0n);
  verified.sort((a,b)=>a.amount>b.amount?-1:a.amount<b.amount?1:a.wallet.localeCompare(b.wallet));
  $('entryCount').textContent=partial?`${verified.length}*`:String(verified.length);
  $('totalLocked').textContent=formatEth(verified.reduce((sum,x)=>sum+x.amount,0n),6)+(partial?'*':'');
  $('boardTime').textContent=`${new Date().toLocaleTimeString()} · ${total} public registrations${partial?' · partial ranking':''}`;
  const el=$('leaderboardBody');el.replaceChildren();
  if(!verified.length){
    const item=document.createElement('p');item.className='empty';item.textContent='No locked stakes found. Register a key and lock some test ETH.';el.append(item);return;
  }
  for(const [i,item] of verified.entries()) {
    const row=document.createElement('div');row.className='board-row';
    const rank=document.createElement('span');rank.className='rank';rank.textContent='#'+(i+1);
    const owner=document.createElement('div');
    const nickname=document.createElement('div');nickname.className='board-name';nickname.textContent=item.handle||'Unnamed wallet';
    const address=document.createElement('div');address.className='board-address';address.textContent=short(item.wallet);
    owner.append(nickname,address);
    const amount=document.createElement('div');amount.className='board-value';amount.textContent=formatEth(item.amount,7);
    const unit=document.createElement('small');unit.textContent='TEST ETH LOCKED';amount.append(unit);
    row.append(rank,owner,amount);el.append(row);
  }
  if(partial){const p=document.createElement('p');p.className='empty';p.textContent='* More than 500 registered wallets. Only the first 500 are ranked here. Use an indexer or pagination for large networks.';el.append(p);}
}
async function refreshLeaderboard() {
  const parent=$('leaderboardBody');
  if(!state.config.contract){
    parent.replaceChildren();const p=document.createElement('p');p.className='empty';
    p.textContent='Choose a deployed Base Sepolia v0.3 contract above to load the public leaderboard.';parent.append(p);
    $('entryCount').textContent='—';$('totalLocked').textContent='—';return;
  }
  const p=await reader();
  const count=await readParticipantCount({provider:p,contract:state.config.contract});
  const max=Number(count>500n?500n:count);
  const entries=[];
  for(let i=0;i<max;i+=8){
    const results=await Promise.all(Array.from({length:Math.min(8,max-i)},(_,j)=>readEntry({provider:p,contract:state.config.contract,index:i+j})));
    entries.push(...results);
  }
  drawLeaderboard(entries,count.toString(),count>500n);
}
async function setContract() {
  const addr=assertAddress($('contractInput').value.trim());
  const rpc=await reader();
  const code=await rpc.request({method:'eth_getCode',params:[addr,'latest']});
  if(!code||code==='0x')throw new Error('No contract code at this Base Sepolia address.');
  await readParticipantCount({provider:rpc,contract:addr});
  state.config.contract=addr;
  localStorage.setItem('stake4karma-contract-84532',addr);
  const url=new URL(location.href);url.searchParams.set('contract',addr);
  const a=$('shareLink');a.href=url.toString();a.hidden=false;
  $('contractStatus').textContent=`Connected to Base Sepolia contract ${addr}. Anyone with this contract address can use the same ranking.`;
  syncUi();
  await refreshLeaderboard();
  if(state.wallet)await checkPosition();
  notice('Contract verified as responding to the v0.3 participant API. Check its source before depositing.','success');
}
async function setRpc() {
  const u=$('rpcInput').value.trim();
  if(!/^https:\/\//i.test(u)&&!/^http:\/\/localhost(?::\d+)?(?:\/|$)/i.test(u))throw new Error('Use an HTTPS RPC URL (localhost HTTP allowed for development).');
  const p=httpRpcProvider(u);await assertChain(p,84532);
  state.config.rpcUrl=u;localStorage.setItem('stake4karma-rpc-84532',u);
  await refreshLeaderboard();
  notice('Read-only RPC switched. No funds or keys are transferred to the RPC provider.','success');
}
function hook(id,fn){$(id).addEventListener('click',()=>withAction(fn));}
async function init() {
  const fromQuery=new URL(location.href).searchParams.get('contract');
  const saved=fromQuery||localStorage.getItem('stake4karma-contract-84532');
  const storedRpc=localStorage.getItem('stake4karma-rpc-84532');
  if(storedRpc) {state.config.rpcUrl=storedRpc;$('rpcInput').value=storedRpc;}
  else $('rpcInput').value=state.config.rpcUrl;
  if(saved&&/^0x[0-9a-fA-F]{40}$/.test(saved)){
    $('contractInput').value=saved;
    try{await setContract();}catch(e){notice('Saved contract could not be verified: '+friendly(e),'error');}
  }
  syncUi();
  hook('saveContractBtn',setContract);hook('saveRpcBtn',setRpc);
  hook('connectBtn',connect);hook('createBtn',generate);hook('backupBtn',downloadBackup);
  hook('registerBtn',register);hook('stakeBtn',stake);hook('exitBtn',exitPosition);
  hook('withdrawBtn',withdrawPosition);hook('refreshBtn',refreshLeaderboard);
  $('importFile').addEventListener('change',ev=>withAction(async()=>{
    await importBackup(ev.target.files[0]);ev.target.value='';notice('Identity imported and verified.','success');
  }));
  window.ethereum?.on?.('accountsChanged', accounts=>{
    state.wallet=accounts?.[0]?.toLowerCase()||null;state.registered=false;syncUi();
    if(state.wallet) Promise.all([readWalletBalance(),checkPosition()]).catch(noticeError);
  });
  window.ethereum?.on?.('chainChanged',()=>{state.wallet=null;syncUi();notice('Network changed. Reconnect to Base Sepolia.');});
  if(!saved) await refreshLeaderboard();
}
init().catch(noticeError);
