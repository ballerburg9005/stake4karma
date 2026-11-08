import test from 'node:test';
import assert from 'node:assert/strict';
import {SELECTORS,NATIVE_ASSET,encodeHandle,decodeHandle,readParticipantCount,readEntry,
  registerOnChain,changeHandle,assertChain} from '../src/stake.js';
const contract='0x'+'12'.repeat(20);
const wallet='0x'+'ab'.repeat(20);
const publicKey='0x'+'23'.repeat(32);
const name='Node_ Keeper';
function word(n){return BigInt(n).toString(16).padStart(64,'0');}
function padAddr(a){return a.slice(2).padStart(64,'0');}
function key(k){return k.slice(2);}
test('on-chain handles encode cleanly and reject invalid values',()=>{
  const h=encodeHandle(name);
  assert.equal(h.length,66);assert.equal(decodeHandle(h),name);
  for(const v of ['', 'a', 'üser', 'evil\x00name', '<script>', 'x'.repeat(25)])
    assert.throws(()=>encodeHandle(v));
});
test('public stake directory is read using read-only eth_call',async()=>{
  const calls=[];
  const provider={async request(x){calls.push(x);
    if(x.method!=='eth_call')throw Error('Unexpected method');
    if(x.params[0].data===SELECTORS.participantCount)return '0x'+word(1);
    assert.equal(x.params[0].data.slice(0,10),SELECTORS.entryAt);
    return '0x'+padAddr(wallet)+key(publicKey)+encodeHandle(name).slice(2)+word(55)+word(1);
  }};
  assert.equal(await readParticipantCount({provider,contract}),1n);
  const row=await readEntry({provider,contract,index:0});
  assert.deepEqual(row,{wallet,publicKey,handle:name,amount:55n,active:true});
  assert.equal(calls.length,2);
});
test('register and update name require wallet-approved transactions',async()=>{
  const requests=[];
  const provider={async request(x){requests.push(x);
    if(x.method==='eth_chainId')return '0x14a34';
    if(x.method==='eth_sendTransaction')return '0x'+'ab'.repeat(32);
    throw Error('Unexpected method');
  }};
  await registerOnChain({provider,chainId:84532,contract,from:wallet,publicKey,handle:name});
  await changeHandle({provider,chainId:84532,contract,from:wallet,handle:'Second'});
  assert.equal(requests[1].params[0].data.slice(0,10),SELECTORS.register);
  assert.equal(requests[1].params[0].data.slice(10,74),publicKey.slice(2));
  assert.equal(requests[1].params[0].to,contract);
  assert.equal(requests[3].params[0].data.slice(0,10),SELECTORS.setHandle);
  assert.equal(requests[3].params[0].value,'0x0');
});
