import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const onceMessage=(ws,type,check=()=>true,timeout=3000)=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.off('message',on);reject(Error(`Timed out waiting for ${type}`))},timeout);
  function on(raw){const m=JSON.parse(raw);if(m.type===type&&check(m)){clearTimeout(timer);ws.off('message',on);resolve(m)}}ws.on('message',on);
});
const send=(ws,type,data={})=>ws.send(JSON.stringify({type,...data}));
async function open(url){return new Promise((resolve,reject)=>{const w=new WebSocket(url);w.once('open',()=>resolve(w));w.once('error',reject)})}

test('authoritative two-player goods and stock trades persist',async t=>{
  const port=33000+Math.floor(Math.random()*2000),dir=mkdtempSync(join(tmpdir(),'market-square-'));
  const child=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),DB_PATH:join(dir,'test.db')},stdio:['ignore','pipe','pipe']});
  t.after(()=>child.kill());await new Promise((resolve,reject)=>{child.stdout.on('data',d=>String(d).includes('running')&&resolve());child.once('exit',c=>reject(Error(`server exited ${c}`)))});
  const a=await open(`ws://localhost:${port}`);t.after(()=>a.close());send(a,'createRoom');const room=(await onceMessage(a,'roomCreated')).code;
  send(a,'join',{code:room,playerId:'alice',name:'Alice'});let s=(await onceMessage(a,'state',m=>m.state.players.alice)).state;
  send(a,'openBusiness',{businessType:'logging',plotId:0,name:'Alice Timber'});s=(await onceMessage(a,'state',m=>m.state.businesses.B1)).state;
  send(a,'renameBusiness',{businessId:'B1',name:'North Star Timber'});s=(await onceMessage(a,'state',m=>m.state.businesses.B1?.name==='North Star Timber')).state;assert.equal(s.businesses.B1.name,'North Star Timber');
  send(a,'transferCash',{businessId:'B1',amount:100,direction:'toBusiness'});await onceMessage(a,'state',m=>m.state.businesses.B1.cash===100);
  const b=await open(`ws://localhost:${port}`);t.after(()=>b.close());send(b,'join',{code:room,playerId:'bob',name:'Bob'});await onceMessage(b,'state',m=>m.state.players.bob);
  send(b,'openBusiness',{businessType:'farm',plotId:1,name:'Bob Farm'});await onceMessage(b,'state',m=>m.state.businesses.B2);
  // Produce wood, then escrow it in a sell order.
  send(a,'produce',{businessId:'B1'});await onceMessage(a,'state',m=>m.state.businesses.B1.productionEnds>0);await delay(12200);s=(await onceMessage(a,'state',m=>m.state.businesses.B1.inventory.wood===3,3000)).state;
  send(a,'goodsOrder',{businessId:'B1',side:'sell',good:'wood',quantity:2,price:4});await onceMessage(a,'state',m=>m.state.goodsOrders.length===1);
  send(b,'transferCash',{businessId:'B2',amount:50,direction:'toBusiness'});await onceMessage(b,'state',m=>m.state.businesses.B2.cash===50);
  send(b,'goodsOrder',{businessId:'B2',side:'buy',good:'wood',quantity:2,price:5});s=(await onceMessage(b,'state',m=>m.state.transactions[0]?.good==='wood')).state;
  assert.equal(s.businesses.B2.inventory.wood,2);assert.equal(s.businesses.B1.cash,108);assert.equal(s.transactions[0].price,4);
  // Company shares are capped, escrowed, and priced by the completed trade.
  send(a,'issueShares',{businessId:'B1',quantity:100,price:2});await onceMessage(a,'state',m=>m.state.stockOrders.length===1);
  send(b,'stockOrder',{businessId:'B1',side:'buy',quantity:25,price:2});s=(await onceMessage(b,'state',m=>m.state.stockTrades.length===1)).state;
  assert.equal(s.players.bob.holdings.B1,25);assert.equal(s.businesses.B1.cash,158);assert.equal(s.businesses.B1.recentTrades[0].price,2);assert.equal(s.businesses.B1.sharesOutstanding,1100);
  send(b,'stockOrder',{businessId:'B1',side:'buy',quantity:10,price:1});s=(await onceMessage(b,'state',m=>m.state.stockOrders.some(o=>o.playerId==='bob'))).state;const pending=s.stockOrders.find(o=>o.playerId==='bob');assert.equal(s.players.bob.cash,290);
  send(b,'cancelOrder',{kind:'stock',orderId:pending.id});s=(await onceMessage(b,'state',m=>!m.state.stockOrders.some(o=>o.id===pending.id))).state;assert.equal(s.players.bob.cash,300);
});
