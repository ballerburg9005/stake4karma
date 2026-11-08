import {readPosition,requestExit,withdraw,waitForReceipt,assertAddress,assertChain,readLockRules,NATIVE_ASSET} from './stake.js';
const $=id=>document.getElementById(id);
let wallet=null; let busy=false; let canExit=false; let canWithdraw=false;
const q=new URL(location.href).searchParams.get('contract');
if(q&&/^0x[\da-fA-F]{40}$/.test(q)) $('contract').value=q;
else {const s=localStorage.getItem('stake4karma-contract-84532');if(s) $('contract').value=s;}
function update(){for(const id of ['connect','check']) $(id).disabled=busy; $('exit').disabled=busy||!canExit; $('withdraw').disabled=busy||!canWithdraw;}
function notice(s,error=false){$('notice').textContent=s;$('notice').className='notice '+(error?'error':'success');$('notice').hidden=false;}
function p(){if(!window.ethereum?.request)throw new Error('A browser wallet such as MetaMask is needed');return window.ethereum;}
async function switchChain(){const v=p();if(Number(BigInt(await v.request({method:'eth_chainId'})))===84532)return;
 try {await v.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]});}
 catch(e){if(e.code!==4902&&e.data?.originalError?.code!==4902)throw e;
 await v.request({method:'wallet_addEthereumChain',params:[{chainId:'0x14a34',chainName:'Base Sepolia',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:['https://sepolia.base.org'],blockExplorerUrls:['https://sepolia.basescan.org']}]});}}
function inputs(){return {contract:assertAddress($('contract').value.trim()),asset:assertAddress($('asset').value.trim())};}
async function connect(){await switchChain();const accounts=await p().request({method:'eth_requestAccounts'});if(!accounts?.[0])throw new Error('No wallet account returned');wallet=assertAddress(accounts[0]);notice('Connected '+wallet);await check();}
async function check(){if(!wallet)throw new Error('Connect the original depositing wallet first');await assertChain(p(),84532);
 const {contract,asset}=inputs();const c=await p().request({method:'eth_getCode',params:[contract,'latest']});if(!c||c==='0x')throw new Error('No contract at this address');
 const rules=await readLockRules({provider:p(),contract});
 $('lockRules').textContent=`Contract minimum hold: ${rules.minHoldSeconds} seconds. Exit delay: ${rules.exitDelaySeconds} seconds. Both conditions apply. Verify the contract source before transacting.`;
 const pos=await readPosition({provider:p(),contract,wallet,asset});
 const n=pos.amount;const formatted=asset===NATIVE_ASSET?`${n/10n**18n}.${(n%10n**18n).toString().padStart(18,'0').slice(0,7)} ETH`:`${n} smallest token units`;
 $('amount').textContent=formatted;
 $('status').textContent=pos.exitRequestedAt?`Exit requested. Available ${new Date(pos.withdrawalAvailableAt*1000).toLocaleString()}`:pos.active?'Active position. Request exit to begin withdrawal.':'No active position for this wallet and asset.';
 const block=await p().request({method:'eth_getBlockByNumber',params:['latest',false]});
 if(!block?.timestamp)throw new Error('Cannot read blockchain time for withdrawal readiness');
 canExit=pos.active;
 canWithdraw=!!pos.exitRequestedAt&&BigInt(block.timestamp)>=BigInt(pos.withdrawalAvailableAt);
 update();
}
async function send(fn){if(!wallet)throw new Error('Connect original wallet first');await switchChain();const {contract,asset}=inputs();
 const hash=await fn({provider:p(),chainId:84532,contract,from:wallet,asset});
 $('txLink').href=`https://sepolia.basescan.org/tx/${hash}`;$('txLink').hidden=false;
 notice('Transaction submitted; confirming…');await waitForReceipt(p(),hash);await check();notice('Transaction confirmed.');}
async function act(fn){if(busy)return;busy=true;update();try{await fn();}catch(e){notice(e?.message||String(e),true);}finally{busy=false;update();}}
$('connect').addEventListener('click',()=>act(connect));
$('check').addEventListener('click',()=>act(check));
$('exit').addEventListener('click',()=>act(async()=>{if(confirm('Exiting removes active score and starts a contract-enforced waiting period. Continue?'))await send(requestExit);}));
$('withdraw').addEventListener('click',()=>act(()=>send(withdraw)));
for(const id of ['contract','asset']) $(id).addEventListener('input',()=>{
  canExit=false;canWithdraw=false;$('status').textContent='Inputs changed; check the position again.';update();
});
window.ethereum?.on?.('accountsChanged',()=>{
  wallet=null;canExit=false;canWithdraw=false;notice('Wallet account changed. Reconnect the depositing wallet.');update();
});
window.ethereum?.on?.('chainChanged',()=>{
  wallet=null;canExit=false;canWithdraw=false;notice('Network changed. Reconnect on Base Sepolia.');update();
});
update();
