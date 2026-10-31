import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { mkdirSync } from 'node:fs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const DB_PATH = process.env.DB_PATH || join(ROOT, 'data', 'market-square.db');
mkdirSync(join(DB_PATH, '..'), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`);

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 12;
const PLOTS = [
  [-18,-13],[-6,-13],[6,-13],[18,-13],[-18,0],[-6,0],[6,0],[18,0],[-18,13],[-6,13],[6,13],[18,13]
].map(([x,z], id) => ({ id, x, z }));
const BUSINESS = {
  logging: { name:'Logging Co.', cost:120, output:'wood', seconds:12, amount:3, input:{} },
  farm: { name:'Farm', cost:100, output:'food', seconds:10, amount:3, input:{} },
  factory: { name:'Furniture Factory', cost:180, output:'furniture', seconds:18, amount:1, input:{ wood:3 } },
  store: { name:'Retail Store', cost:140, output:null, seconds:0, amount:0, input:{} }
};
const STARTER_STOCK = { wood:0, food:0, furniture:0 };

const copy = x => JSON.parse(JSON.stringify(x));
const now = () => Date.now();
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const code = () => Math.random().toString(36).slice(2,7).toUpperCase();
const safeName = v => String(v || 'Player').replace(/[^a-zA-Z0-9 _-]/g,'').trim().slice(0,20) || 'Player';

function freshRoom(roomCode) {
  return { code:roomCode, createdAt:now(), players:{}, businesses:{}, goodsOrders:[], stockOrders:[], transactions:[], stockTrades:[], npcFund:4000, nextBusiness:1, nextOrder:1 };
}
function loadRoom(roomCode) {
  const row = db.prepare('SELECT state,updated_at FROM rooms WHERE code=?').get(roomCode);
  if(!row)return null;
  const room=JSON.parse(row.state),offlineFor=Math.max(0,now()-Number(row.updated_at));
  // Active batches are paused, not completed, while this room is unloaded/offline.
  for(const b of Object.values(room.businesses))if(b.productionEnds>row.updated_at)b.productionEnds+=offlineFor;
  return room;
}
function saveRoom(room) {
  db.prepare(`INSERT INTO rooms(code,state,updated_at) VALUES(?,?,?)
    ON CONFLICT(code) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
    .run(room.code, JSON.stringify(room), now());
}
function publicState(room) {
  return { ...room, players:Object.fromEntries(Object.entries(room.players).map(([id,p]) => [id,{...p, token:undefined}])) };
}
const rooms = new Map();
function getRoom(c) { if(!c)return null; let r=rooms.get(c); if(!r){r=loadRoom(c); if(r) rooms.set(c,r);} return r; }

function ensurePlayer(room, id, name) {
  let p=room.players[id];
  if (!p) room.players[id] = p = { id, name:safeName(name), cash:500, inventory:copy(STARTER_STOCK), businesses:[], holdings:{}, x:0, z:22, color:`hsl(${Math.floor(Math.random()*360)} 65% 55%)`, online:true };
  p.name=safeName(name || p.name); p.online=true; return p;
}
function businessOwner(room,b,pid){ if(!b || b.ownerId!==pid) throw Error('Only the owner can do that.'); }
function debit(p, amount, message='Not enough cash.') { amount=money(amount); if(amount<=0) throw Error('Amount must be positive.'); if(p.cash+1e-8<amount) throw Error(message); p.cash=money(p.cash-amount); }
function credit(p, amount){ p.cash=money(p.cash+amount); }
function qty(v){ const n=Math.floor(Number(v)); if(!Number.isFinite(n)||n<=0||n>9999) throw Error('Quantity must be 1–9,999.'); return n; }
function price(v){ const n=money(v); if(!Number.isFinite(n)||n<=0||n>10000) throw Error('Price must be between $0.01 and $10,000.'); return n; }
function ownsShares(p,bid){ return Number(p.holdings[bid]||0); }

function createBusiness(room,p,type,plotId,name) {
  const spec=BUSINESS[type]; if(!spec) throw Error('Unknown business type.');
  const plot=PLOTS.find(x=>x.id===Number(plotId)); if(!plot) throw Error('Choose a valid plot.');
  if(Object.values(room.businesses).some(b=>b.plotId===plot.id)) throw Error('That plot is already occupied.');
  debit(p,spec.cost,'You cannot afford that business.');
  const id=`B${room.nextBusiness++}`;
  const b={ id,type,name:safeName(name)||`${p.name}'s ${spec.name}`,ownerId:p.id,plotId:plot.id,x:plot.x,z:plot.z,cash:0,inventory:copy(STARTER_STOCK),workers:0,workerWage:2,auto:false,pricing:{food:7,furniture:35},revenue:0,expenses:0,sharesOutstanding:1000,maxShares:2000,treasuryShares:0,shareholders:{[p.id]:1000},lastProduction:now(),productionEnds:0,recentTrades:[] };
  room.businesses[id]=b; p.businesses.push(id); p.holdings[id]=(p.holdings[id]||0)+1000; return b;
}
function startProduction(room,b,pid) {
  businessOwner(room,b,pid); const spec=BUSINESS[b.type]; if(!spec.output) throw Error('Stores sell goods rather than produce them.');
  if(b.productionEnds>now()) throw Error('Production is already running.');
  for(const [g,n] of Object.entries(spec.input)) if((b.inventory[g]||0)<n) throw Error(`Needs ${n} ${g}.`);
  for(const [g,n] of Object.entries(spec.input)) b.inventory[g]-=n;
  b.productionEnds=now()+spec.seconds*1000; return b;
}
function completeProduction(room,b,t) {
  if(!b.productionEnds||b.productionEnds>t) return false;
  const spec=BUSINESS[b.type]; b.inventory[spec.output]+=spec.amount; b.productionEnds=0; b.lastProduction=t;
  if(b.auto&&b.workers>0){
    const wage=money(b.workerWage*b.workers);
    const canInput=Object.entries(spec.input).every(([g,n])=>b.inventory[g]>=n);
    if(b.cash>=wage&&canInput){ b.cash=money(b.cash-wage); b.expenses=money(b.expenses+wage); for(const[g,n]of Object.entries(spec.input)) b.inventory[g]-=n; b.productionEnds=t+Math.max(4000,spec.seconds*1000/(1+b.workers*.35)); }
  }
  return true;
}
function placeGoodsOrder(room,p,data) {
  const side=data.side==='buy'?'buy':'sell', amount=qty(data.quantity), unit=price(data.price), good=data.good;
  if(!Object.hasOwn(STARTER_STOCK,good)) throw Error('Unknown good.');
  const b=room.businesses[data.businessId]; businessOwner(room,b,p.id);
  if(side==='sell') { if(b.inventory[good]<amount) throw Error('Business inventory is too low.'); b.inventory[good]-=amount; }
  else { const total=money(amount*unit); if(b.cash<total) throw Error('Business cash is too low.'); b.cash=money(b.cash-total); }
  const o={id:room.nextOrder++,kind:'goods',side,good,quantity:amount,remaining:amount,price:unit,businessId:b.id,playerId:p.id,createdAt:now()}; room.goodsOrders.push(o); matchGoods(room,good); return o;
}
function matchGoods(room,good) {
  while(true){
    const buy=room.goodsOrders.filter(o=>o.good===good&&o.side==='buy'&&o.remaining>0).sort((a,b)=>b.price-a.price||a.createdAt-b.createdAt)[0];
    const sell=room.goodsOrders.filter(o=>o.good===good&&o.side==='sell'&&o.remaining>0).sort((a,b)=>a.price-b.price||a.createdAt-b.createdAt)[0];
    if(!buy||!sell||buy.price<sell.price) break;
    const q=Math.min(buy.remaining,sell.remaining), px=sell.createdAt<=buy.createdAt? sell.price:buy.price;
    const buyer=room.businesses[buy.businessId], seller=room.businesses[sell.businessId], reserved=money(q*buy.price), actual=money(q*px);
    buyer.inventory[good]+=q; seller.cash=money(seller.cash+actual); seller.revenue=money(seller.revenue+actual); if(reserved>actual) buyer.cash=money(buyer.cash+(reserved-actual));
    buy.remaining-=q; sell.remaining-=q; const tx={kind:'goods',good,quantity:q,price:px,buyer:buyer.name,seller:seller.name,at:now()}; room.transactions.unshift(tx); room.transactions=room.transactions.slice(0,30);
  }
  room.goodsOrders=room.goodsOrders.filter(o=>o.remaining>0);
}
function issueShares(room,p,b,amount,askPrice) {
  businessOwner(room,b,p.id); const n=qty(amount); const px=price(askPrice);
  if(b.sharesOutstanding+n>b.maxShares) throw Error(`Share cap is ${b.maxShares}.`);
  b.sharesOutstanding+=n; b.treasuryShares+=n;
  const o={id:room.nextOrder++,kind:'stock',side:'sell',businessId:b.id,quantity:n,remaining:n,price:px,playerId:'treasury',createdAt:now()}; room.stockOrders.push(o); matchStocks(room,b.id); return o;
}
function placeStockOrder(room,p,data){
  const b=room.businesses[data.businessId]; if(!b) throw Error('Company not found.'); const side=data.side==='buy'?'buy':'sell', n=qty(data.quantity), px=price(data.price);
  if(side==='buy'){ debit(p,n*px); }
  else { if(ownsShares(p,b.id)<n) throw Error('Not enough shares.'); p.holdings[b.id]-=n; b.shareholders[p.id]=(b.shareholders[p.id]||0)-n; }
  const o={id:room.nextOrder++,kind:'stock',side,businessId:b.id,quantity:n,remaining:n,price:px,playerId:p.id,createdAt:now()}; room.stockOrders.push(o); matchStocks(room,b.id); return o;
}
function cancelOrder(room,p,kind,orderId){
  const list=kind==='stock'?room.stockOrders:room.goodsOrders, index=list.findIndex(o=>o.id===Number(orderId));
  if(index<0)throw Error('Order no longer exists.'); const o=list[index];
  if(o.playerId!==p.id&&!(o.playerId==='treasury'&&room.businesses[o.businessId]?.ownerId===p.id))throw Error('You cannot cancel that order.');
  const b=room.businesses[o.businessId];
  if(kind==='goods'){if(o.side==='sell')b.inventory[o.good]+=o.remaining;else b.cash=money(b.cash+o.remaining*o.price);}
  else if(o.side==='buy')credit(p,o.remaining*o.price);
  else if(o.playerId==='treasury'){b.treasuryShares-=o.remaining;b.sharesOutstanding-=o.remaining;}
  else {p.holdings[o.businessId]=(p.holdings[o.businessId]||0)+o.remaining;b.shareholders[p.id]=(b.shareholders[p.id]||0)+o.remaining;}
  list.splice(index,1);
}
function matchStocks(room,bid){
  while(true){
    const buy=room.stockOrders.filter(o=>o.businessId===bid&&o.side==='buy'&&o.remaining>0).sort((a,b)=>b.price-a.price||a.createdAt-b.createdAt)[0];
    const sell=room.stockOrders.filter(o=>o.businessId===bid&&o.side==='sell'&&o.remaining>0).sort((a,b)=>a.price-b.price||a.createdAt-b.createdAt)[0];
    if(!buy||!sell||buy.price<sell.price) break;
    const b=room.businesses[bid], q=Math.min(buy.remaining,sell.remaining), px=sell.createdAt<=buy.createdAt?sell.price:buy.price, buyer=room.players[buy.playerId];
    const reserved=money(q*buy.price), actual=money(q*px); if(reserved>actual) credit(buyer,reserved-actual);
    buyer.holdings[bid]=(buyer.holdings[bid]||0)+q; b.shareholders[buyer.id]=(b.shareholders[buyer.id]||0)+q;
    if(sell.playerId==='treasury'){ b.treasuryShares-=q; b.cash=money(b.cash+actual); }
    else credit(room.players[sell.playerId],actual);
    buy.remaining-=q; sell.remaining-=q; const tr={businessId:bid,quantity:q,price:px,buyer:buyer.name,seller:sell.playerId==='treasury'?'Company':room.players[sell.playerId].name,at:now()}; b.recentTrades.unshift(tr); b.recentTrades=b.recentTrades.slice(0,10); room.stockTrades.unshift(tr); room.stockTrades=room.stockTrades.slice(0,30);
  }
  room.stockOrders=room.stockOrders.filter(o=>o.remaining>0);
}
function dividends(room,p,b,amount){
  businessOwner(room,b,p.id); const total=price(amount); if(total>b.cash) throw Error('Company does not have that much cash.'); b.cash=money(b.cash-total); b.expenses=money(b.expenses+total);
  let paid=0; for(const [pid,shares] of Object.entries(b.shareholders)){ const part=money(total*shares/b.sharesOutstanding); if(room.players[pid]){credit(room.players[pid],part); paid+=part;} } return money(paid);
}
function npcSales(room,t){
  if(room._lastNpc&&t-room._lastNpc<4000)return false; room._lastNpc=t; let changed=false;
  const stores=Object.values(room.businesses).filter(b=>b.type==='store');
  for(const b of stores){ for(const good of ['food','furniture']){
    if(b.inventory[good]<=0)continue; const fair=good==='food'?8:40, px=price(b.pricing[good]||fair); const chance=Math.max(.04,Math.min(.9,1.1-px/(fair*1.55))); if(Math.random()>chance)continue;
    const q=Math.min(b.inventory[good],good==='food'?1:1), sale=money(q*px); if(room.npcFund<sale)continue; b.inventory[good]-=q; b.cash=money(b.cash+sale); b.revenue=money(b.revenue+sale); room.npcFund=money(room.npcFund-sale); room.transactions.unshift({kind:'npc',good,quantity:q,price:px,buyer:'NPC customer',seller:b.name,at:t}); changed=true;
  }} room.transactions=room.transactions.slice(0,30); return changed;
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
const server=http.createServer(async(req,res)=>{ try{ const url=new URL(req.url,'http://x'); let p=url.pathname==='/'?'/index.html':url.pathname; let file=p==='/vendor/three.module.js'?join(ROOT,'node_modules','three','build','three.module.js'):normalize(join(PUBLIC,p)); if(!file.startsWith(PUBLIC)&&!file.startsWith(join(ROOT,'node_modules','three','build')))throw Error(); const body=await readFile(file); res.writeHead(200,{'content-type':mime[extname(file)]||'application/octet-stream','cache-control':'no-cache'});res.end(body);}catch{res.writeHead(404);res.end('Not found');} });
const wss=new WebSocketServer({server});
function send(ws,type,payload={}){if(ws.readyState===1)ws.send(JSON.stringify({type,...payload}));}
function broadcast(room){const state=publicState(room);for(const ws of wss.clients)if(ws.roomCode===room.code)send(ws,'state',{state});}
function fail(ws,e){send(ws,'error',{message:e.message||'Request failed.'});}
wss.on('connection',ws=>{
  ws.on('message',raw=>{ let m;try{m=JSON.parse(raw)}catch{return fail(ws,Error('Bad message.'))} try{
    if(m.type==='createRoom'){let c;do{c=code()}while(loadRoom(c));const r=freshRoom(c);rooms.set(c,r);saveRoom(r);send(ws,'roomCreated',{code:c});return;}
    if(m.type==='join'){const c=String(m.code||'').toUpperCase();const r=getRoom(c);if(!r)throw Error('Room not found.');const online=[...wss.clients].filter(x=>x.roomCode===c).length;if(online>=MAX_PLAYERS&&!r.players[m.playerId])throw Error('Room is full.');ws.roomCode=c;ws.playerId=String(m.playerId);ensurePlayer(r,ws.playerId,m.name);saveRoom(r);broadcast(r);return;}
    const r=getRoom(ws.roomCode);if(!r)throw Error('Join a room first.');const p=r.players[ws.playerId];if(!p)throw Error('Player not found.');
    if(m.type==='move'){p.x=Math.max(-29,Math.min(29,Number(m.x)||0));p.z=Math.max(-24,Math.min(24,Number(m.z)||0));}
    else if(m.type==='openBusiness')createBusiness(r,p,m.businessType,m.plotId,m.name);
    else if(m.type==='renameBusiness'){const b=r.businesses[m.businessId];businessOwner(r,b,p.id);const name=safeName(m.name);if(name.length<2)throw Error('Company name must be at least 2 characters.');b.name=name;}
    else if(m.type==='produce')startProduction(r,r.businesses[m.businessId],p.id);
    else if(m.type==='hire'){const b=r.businesses[m.businessId];businessOwner(r,b,p.id);const n=qty(m.count);debit(p,n*25);b.workers+=n;b.expenses=money(b.expenses+n*25);}
    else if(m.type==='toggleAuto'){const b=r.businesses[m.businessId];businessOwner(r,b,p.id);if(!b.workers)throw Error('Hire a worker first.');b.auto=!b.auto;if(b.auto&&!b.productionEnds&&BUSINESS[b.type].output)startProduction(r,b,p.id);}
    else if(m.type==='setRetailPrice'){const b=r.businesses[m.businessId];businessOwner(r,b,p.id);if(b.type!=='store')throw Error('Only stores set retail prices.');b.pricing[m.good]=price(m.price);}
    else if(m.type==='transferCash'){const b=r.businesses[m.businessId];businessOwner(r,b,p.id);const a=price(m.amount);if(m.direction==='toBusiness'){debit(p,a);b.cash=money(b.cash+a);}else{if(b.cash<a)throw Error('Business cash is too low.');b.cash=money(b.cash-a);credit(p,a);}}
    else if(m.type==='goodsOrder')placeGoodsOrder(r,p,m);
    else if(m.type==='stockOrder')placeStockOrder(r,p,m);
    else if(m.type==='cancelOrder')cancelOrder(r,p,m.kind,m.orderId);
    else if(m.type==='issueShares')issueShares(r,p,r.businesses[m.businessId],m.quantity,m.price);
    else if(m.type==='dividend')dividends(r,p,r.businesses[m.businessId],m.amount);
    else throw Error('Unknown action.');
    saveRoom(r);broadcast(r);
  }catch(e){fail(ws,e)} });
  ws.on('close',()=>{const r=getRoom(ws.roomCode);if(r?.players[ws.playerId]){r.players[ws.playerId].online=false;saveRoom(r);broadcast(r);}});
});
setInterval(()=>{for(const r of rooms.values()){let changed=false;const t=now();for(const b of Object.values(r.businesses))changed=completeProduction(r,b,t)||changed;changed=npcSales(r,t)||changed;if(changed){saveRoom(r);broadcast(r);}}},1000);
setInterval(()=>{for(const r of rooms.values())saveRoom(r)},15000);
server.listen(PORT,()=>console.log(`Market Square running at http://localhost:${PORT}`));
