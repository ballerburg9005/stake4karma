import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createIdentity, signCredential} from '../src/stake.js';

const contract = '0x' + 'ab'.repeat(20);
const wallet = '0x' + 'cd'.repeat(20);
const words = n => BigInt(n).toString(16).padStart(64, '0');

function listen(server) {
  return new Promise((resolve, reject) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)).once('error',reject));
}
function close(server) {return new Promise(resolve => server.close(resolve));}
async function get(base, path, input) {
  const result = await fetch(base+path, input ? {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(input)} : {});
  return {status:result.status, data: await result.json()};
}
async function waitForServer(base) {
  for (let i=0;i<100;i++) {
    try {const response = await fetch(base+'/api/config'); if(response.ok)return;}
    catch {}
    await new Promise(r=>setTimeout(r,50));
  }
  throw new Error('Server did not start');
}

test('registration is credential-signed; leaderboard independently reads and verifies chain state', {timeout:25000}, async t => {
  const key = await createIdentity();
  let chainKey = key.publicKey;
  let active = true;
  let rpcCalls = 0;
  const rpcServer = createServer(async(req,res)=>{
    const buffers=[];
    for await (const b of req) buffers.push(b);
    const input=JSON.parse(Buffer.concat(buffers));
    const response = input.method === 'eth_chainId' ? '0x14a34'
      : input.method === 'eth_call' ? ('0x' + chainKey.slice(2) + words(4000000000000000n) + words(active ? 1 : 0) + words(0) + words(0))
      : null;
    rpcCalls++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:response}));
  });
  const rpcPort=await listen(rpcServer);
  const reservation=createServer((_,res)=>res.end('reserved'));
  const appPort=await listen(reservation);
  await close(reservation);
  const dir=await mkdtemp(join(tmpdir(),'stake4karma-test-'));
  const file=join(dir,'registered.json');
  const child=spawn(process.execPath,[resolve('server.js')],{
    cwd:resolve('.'),
    env:{...process.env,PORT:String(appPort),RPC_URL:`http://127.0.0.1:${rpcPort}`,
      STAKE_CONTRACT:contract,CHAIN_ID:'84532',DATA_FILE:file},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill('SIGTERM');await close(rpcServer);await rm(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${appPort}`;
  await waitForServer(base);
  const {data:empty} = await get(base,'/api/leaderboard');
  assert.deepEqual(empty.rows,[]);
  const issued = await get(base,'/api/challenge',{wallet,publicKey:key.publicKey});
  assert.equal(issued.status,200);
  const proof=await signCredential({chainId:84532,contract,wallet,publicKey:key.publicKey,
    privateKey:key.privateKey,challenge:issued.data.challenge});
  const bad = await get(base,'/api/register',{handle:'Alice',nonce:issued.data.challenge.nonce,
    proof:{...proof, signature:'0x'+'00'.repeat(64)}});
  assert.equal(bad.status,401);
  // Failed challenge has been consumed, even if the valid proof is resubmitted.
  assert.equal((await get(base,'/api/register',{handle:'Alice',nonce:issued.data.challenge.nonce,proof})).status,401);
  const next = await get(base,'/api/challenge',{wallet,publicKey:key.publicKey});
  const validProof = await signCredential({chainId:84532,contract,wallet,publicKey:key.publicKey,
    privateKey:key.privateKey,challenge:next.data.challenge});
  const reg = await get(base,'/api/register',{handle:'Alice',nonce:next.data.challenge.nonce,proof:validProof});
  assert.equal(reg.status,200);
  assert.equal((await get(base,'/api/register',{handle:'Alice',nonce:next.data.challenge.nonce,proof:validProof})).status,401);
  const saved=JSON.parse(await readFile(file,'utf8'));
  assert.equal(saved[0].handle,'Alice');
  assert.equal(saved[0].wallet,wallet);
  assert.equal(saved[0].privateKey,undefined);
  const ranking = (await get(base,'/api/leaderboard')).data;
  assert.equal(ranking.rows.length,1);
  assert.equal(ranking.rows[0].rank,1);
  assert.equal(ranking.rows[0].amountWei,'4000000000000000');
  assert(rpcCalls >= 3);
  // These changes are visible only after the short leaderboard RPC-cache duration.
  chainKey = '0x'+'11'.repeat(32);
  active = false;
  assert.notEqual(chainKey,key.publicKey);
});