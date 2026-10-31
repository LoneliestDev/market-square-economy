import * as THREE from '/vendor/three.module.js';

const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
const uid=()=>crypto.randomUUID();
const playerId=localStorage.msPlayerId||(localStorage.msPlayerId=uid());
let ws,state=null,me=null,currentPanel='',selectedBusiness=null,tutorialDismissed=false;
const BUSINESS={logging:{name:'Logging Company',icon:'🌲',cost:120,color:0x8c6746},farm:{name:'Farm',icon:'🌾',cost:100,color:0xd5ae52},factory:{name:'Furniture Factory',icon:'⚙',cost:180,color:0x7d8790},store:{name:'Retail Store',icon:'◆',cost:140,color:0x557b9d}};
const PLOTS=[[-18,-13],[-6,-13],[6,-13],[18,-13],[-18,0],[-6,0],[6,0],[18,0],[-18,13],[-6,13],[6,13],[18,13]].map(([x,z],id)=>({id,x,z}));
const money=n=>`$${Number(n||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const age=t=>{const s=Math.max(0,Math.floor((Date.now()-t)/1000));return s<60?`${s}s ago`:`${Math.floor(s/60)}m ago`};
const toast=(msg,bad=false)=>{const e=$('#toast');e.textContent=msg;e.style.background=bad?'#8b3737':'#172820';e.classList.add('show');clearTimeout(e.t);e.t=setTimeout(()=>e.classList.remove('show'),2800)};
const send=(type,data={})=>{if(ws?.readyState===1)ws.send(JSON.stringify({type,...data}));};

// --- Three.js town ----------------------------------------------------------
const scene=new THREE.Scene();scene.background=new THREE.Color(0xb9d7df);scene.fog=new THREE.Fog(0xb9d7df,50,95);
const camera=new THREE.PerspectiveCamera(55,innerWidth/innerHeight,.1,150);camera.position.set(0,8,12);
const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.setSize(innerWidth,innerHeight);renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;$('#world').append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xeaf8ff,0x72865b,2.2));const sun=new THREE.DirectionalLight(0xfff2d4,2.8);sun.position.set(-20,35,18);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-45;sun.shadow.camera.right=45;sun.shadow.camera.top=40;sun.shadow.camera.bottom=-40;scene.add(sun);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(90,72),new THREE.MeshLambertMaterial({color:0x8eb274}));ground.rotation.x=-Math.PI/2;ground.receiveShadow=true;scene.add(ground);
const mat=c=>new THREE.MeshLambertMaterial({color:c});
function box(w,h,d,c,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat(c));m.position.set(x,y,z);m.castShadow=m.receiveShadow=true;scene.add(m);return m}
box(64,.12,5,0xc8c3b4,0,.07,0);box(5,.13,54,0xc8c3b4,0,.08,0);
for(const [x,z] of [[-24,-21],[-12,-21],[12,-21],[24,-21],[-24,21],[-12,21],[12,21],[24,21],[-28,-7],[28,-7],[-28,7],[28,7]]){
  const trunk=box(.45,2,.45,0x76533b,x,1,z);const crown=new THREE.Mesh(new THREE.ConeGeometry(1.7,4,7),mat(0x3f7952));crown.position.set(x,3.4,z);crown.castShadow=true;scene.add(crown);
}
// plaza fountain and marketplace canopy
const fountain=new THREE.Mesh(new THREE.CylinderGeometry(3.2,3.5,.7,16),mat(0x78969d));fountain.position.set(0,.35,0);fountain.receiveShadow=true;scene.add(fountain);
const water=new THREE.Mesh(new THREE.CylinderGeometry(2.7,2.7,.08,20),new THREE.MeshPhongMaterial({color:0x65b8c9,shininess:80}));water.position.set(0,.74,0);scene.add(water);
for(const p of PLOTS){const base=new THREE.Mesh(new THREE.BoxGeometry(8,.1,8),new THREE.MeshLambertMaterial({color:0xd4cba8,transparent:true,opacity:.72}));base.position.set(p.x,.09,p.z);base.userData={plotId:p.id};scene.add(base)}
const playerMeshes=new Map(),businessMeshes=new Map();
function labelSprite(text,bg='#244a3b'){const c=document.createElement('canvas');c.width=512;c.height=96;const x=c.getContext('2d');x.fillStyle=bg;x.roundRect(4,4,504,84,18);x.fill();x.fillStyle='white';x.font='bold 28px system-ui';x.textAlign='center';x.textBaseline='middle';x.fillText(text.slice(0,28),256,48);const tx=new THREE.CanvasTexture(c);const s=new THREE.Sprite(new THREE.SpriteMaterial({map:tx,transparent:true}));s.scale.set(6.5,1.22,1);return s}
function makePlayer(p){const g=new THREE.Group();const body=new THREE.Mesh(new THREE.CapsuleGeometry(.42,.85,4,8),mat(new THREE.Color(p.color)));body.position.y=1.05;body.castShadow=true;g.add(body);const head=new THREE.Mesh(new THREE.SphereGeometry(.36,12,8),mat(0xe1aa82));head.position.y=1.95;head.castShadow=true;g.add(head);const l=labelSprite(p.name,'#1f2b27');l.position.y=2.75;l.scale.set(2.9,.54,1);g.add(l);scene.add(g);return g}
function makeBusiness(b){const g=new THREE.Group();g.position.set(b.x,0,b.z);const c=BUSINESS[b.type].color;
  const walls=new THREE.Mesh(new THREE.BoxGeometry(6.3,3.2,5.2),mat(c));walls.position.y=1.65;walls.castShadow=walls.receiveShadow=true;g.add(walls);
  const roof=new THREE.Mesh(new THREE.ConeGeometry(4.4,2,4),mat(b.type==='farm'?0x9c5c3d:0x40584e));roof.position.y=4.1;roof.rotation.y=Math.PI/4;roof.castShadow=true;g.add(roof);
  const door=new THREE.Mesh(new THREE.BoxGeometry(1.2,2,.15),mat(0x4b3528));door.position.set(0,1,2.66);g.add(door);
  if(b.type==='logging'){for(let i=-2;i<=2;i++){const log=new THREE.Mesh(new THREE.CylinderGeometry(.22,.22,3,8),mat(0x7a4d2e));log.rotation.z=Math.PI/2;log.position.set(i*.25,.4,3.2);g.add(log)}}
  if(b.type==='farm'){for(let i=-2;i<=2;i++)for(let j=0;j<3;j++){const crop=new THREE.Mesh(new THREE.ConeGeometry(.12,.8,5),mat(0xd8b440));crop.position.set(-2+i,0.4,-3.1-j*.5);g.add(crop)}}
  if(b.type==='factory'){const stack=new THREE.Mesh(new THREE.CylinderGeometry(.38,.52,3,8),mat(0x596167));stack.position.set(2.1,4.1,-1.2);g.add(stack)}
  if(b.type==='store'){const awning=new THREE.Mesh(new THREE.BoxGeometry(3,.28,1),mat(0xd7a643));awning.position.set(0,2.25,2.9);g.add(awning)}
  const l=labelSprite(b.name);l.position.set(0,5.6,0);g.add(l);g.userData={businessId:b.id};g.traverse(o=>o.userData={...o.userData,businessId:b.id});scene.add(g);return g
}
let yaw=0,pitch=.35,drag=false,lastX=0,lastY=0;const keys={};
addEventListener('keydown',e=>keys[e.code]=true);addEventListener('keyup',e=>keys[e.code]=false);
renderer.domElement.addEventListener('pointerdown',e=>{drag=true;lastX=e.clientX;lastY=e.clientY});addEventListener('pointerup',()=>drag=false);addEventListener('pointermove',e=>{if(!drag)return;yaw-=(e.clientX-lastX)*.006;pitch=Math.max(.1,Math.min(.85,pitch+(e.clientY-lastY)*.004));lastX=e.clientX;lastY=e.clientY});
const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();renderer.domElement.addEventListener('click',e=>{if(Math.abs(e.clientX-lastX)>4)return;mouse.x=e.clientX/innerWidth*2-1;mouse.y=-(e.clientY/innerHeight*2-1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects([...businessMeshes.values()],true)[0];if(hit){let o=hit.object;const id=o.userData.businessId;if(id){selectedBusiness=id;openPanel('business')}}});
addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight)});
let last=performance.now(),lastMove=0;
function animate(t){requestAnimationFrame(animate);const dt=Math.min(.05,(t-last)/1000);last=t;if(me){let dx=(keys.KeyD?1:0)-(keys.KeyA?1:0),dz=(keys.KeyS?1:0)-(keys.KeyW?1:0);if(dx||dz){const len=Math.hypot(dx,dz);dx/=len;dz/=len;const sin=Math.sin(yaw),cos=Math.cos(yaw);me.x=Math.max(-29,Math.min(29,me.x+(dx*cos-dz*sin)*7*dt));me.z=Math.max(-24,Math.min(24,me.z+(dx*sin+dz*cos)*7*dt));if(t-lastMove>100){send('move',{x:me.x,z:me.z});lastMove=t}}
    const target=new THREE.Vector3(me.x,1.1,me.z),dist=10,cp=Math.cos(pitch);camera.position.set(target.x+Math.sin(yaw)*cp*dist,target.y+Math.sin(pitch)*dist,target.z+Math.cos(yaw)*cp*dist);camera.lookAt(target);
  }renderer.render(scene,camera)}animate(performance.now());

function syncWorld(){
  for(const [id,p] of Object.entries(state.players)){let m=playerMeshes.get(id);if(!m){m=makePlayer(p);playerMeshes.set(id,m)}m.position.lerp(new THREE.Vector3(p.x,0,p.z),id===playerId?1:.3);m.visible=p.online}
  for(const [id,m] of playerMeshes)if(!state.players[id]){scene.remove(m);playerMeshes.delete(id)}
  for(const [id,b] of Object.entries(state.businesses)){if(!businessMeshes.has(id))businessMeshes.set(id,makeBusiness(b))}
}

// --- UI --------------------------------------------------------------------
function connect(code,name){
  ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);ws.onopen=()=>send('join',{code,playerId,name});ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='roomCreated')connect(m.code,name);if(m.type==='error')toast(m.message,true);if(m.type==='state'){state=m.state;me=state.players[playerId];if(!me)return;$('#lobby').classList.remove('open');['#topbar','#hud','#dock','#crosshair','#hint','#tutorial'].forEach(s=>$(s).classList.remove('hidden'));localStorage.msRoom=state.code;localStorage.msName=me.name;render();syncWorld();}};ws.onclose=()=>state&&setTimeout(()=>connect(state.code,localStorage.msName),1200);
}
$('#playerName').value=localStorage.msName||'';$('#roomCode').value=new URLSearchParams(location.search).get('room')||localStorage.msRoom||'';
$('#createRoom').onclick=()=>{const name=$('#playerName').value.trim();if(!name)return toast('Enter your name first.',true);ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}`);ws.onopen=()=>send('createRoom');ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.type==='roomCreated'){ws.close();connect(m.code,name)}}};
$('#joinRoom').onclick=()=>{const name=$('#playerName').value.trim(),code=$('#roomCode').value.trim().toUpperCase();if(!name||code.length!==5)return toast('Enter your name and 5-letter room code.',true);connect(code,name)};
$('#copyCode').onclick=()=>navigator.clipboard.writeText(state.code).then(()=>toast('Room code copied.'));
$('#closePanel').onclick=()=>{$('#panel').classList.add('hidden');currentPanel='';$$('#dock button').forEach(b=>b.classList.remove('active'))};
$('#dismissTutorial').onclick=()=>{tutorialDismissed=true;$('#tutorial').classList.add('hidden')};
$$('#dock button').forEach(b=>b.onclick=()=>openPanel(b.dataset.panel));

function render(){
  $('#codeLabel').textContent=state.code;$('#cash').textContent=money(me.cash);$('#online').textContent=`${Object.values(state.players).filter(p=>p.online).length} / 12`;
  const totals=['wood','food','furniture'].reduce((a,g)=>(a[g]=me.businesses.reduce((n,id)=>n+(state.businesses[id]?.inventory[g]||0),0),a),{});
  $('#inventory').innerHTML=['wood','food','furniture'].map(g=>`<div class="chip">${g==='wood'?'▤':g==='food'?'●':'▰'}<b>${totals[g]}</b>${g}</div>`).join('');
  $('#owned').innerHTML=me.businesses.length?me.businesses.map(id=>`<button data-business="${id}">${esc(state.businesses[id]?.name||id)}</button>`).join(''):'<span class="sub">No businesses yet</span>';
  $$('#owned button').forEach(b=>b.onclick=()=>{selectedBusiness=b.dataset.business;openPanel('business')});
  renderTutorial();if(currentPanel)renderPanel();
}
function renderTutorial(){if(tutorialDismissed)return;let n=1,title='Claim your first plot',text='Open Business, pick a free plot and choose a company type.';if(me.businesses.length){n=2;const bs=me.businesses.map(id=>state.businesses[id]);if(bs.some(b=>Object.values(b.inventory).some(x=>x>0))){n=3;title='Make your first sale';text='Place a sell order, or use a store to sell food or furniture to NPC customers.'}else{title='Produce your first goods';text='Open your business and start a timed production batch.'}}if(state.transactions.some(t=>t.seller&&me.businesses.some(id=>state.businesses[id]?.name===t.seller))){n=4;title='Tutorial complete';text='Reinvest, expand to another plot, or buy shares in another player’s company.'}$('#tutorialNum').textContent=n;$('#tutorialTitle').textContent=title;$('#tutorialText').textContent=text;$('#tutorialProgress').style.width=`${n*25}%`}
function openPanel(name){currentPanel=name;$('#panel').classList.remove('hidden');$$('#dock button').forEach(b=>b.classList.toggle('active',b.dataset.panel===name));renderPanel()}
function renderPanel(){if(currentPanel==='business')renderBusiness();if(currentPanel==='market')renderMarket();if(currentPanel==='stocks')renderStocks();if(currentPanel==='players')renderPlayers();}
function freePlots(){const used=new Set(Object.values(state.businesses).map(b=>b.plotId));return PLOTS.filter(p=>!used.has(p.id))}

function renderBusiness(){
  const b=selectedBusiness&&state.businesses[selectedBusiness]; if(!b){
    $('#panelContent').innerHTML=`<h2>Open a business</h2><p class="sub">Choose one of ${freePlots().length} available plots. Each business has a viable route to profit.</p>
      <div class="cards">${Object.entries(BUSINESS).map(([k,v])=>`<label class="biz-card"><div><b>${v.icon} ${v.name}</b><p>${k==='logging'?'Produces wood for furniture factories.':k==='farm'?'Produces food for retail stores.':k==='factory'?'Turns 3 wood into 1 furniture.':'Sells food and furniture to NPC customers.'}</p></div><span class="badge">${money(v.cost)}</span><input type="radio" name="biztype" value="${k}"></label>`).join('')}</div>
      <div class="section grid2"><label class="field">BUSINESS NAME<input id="newBizName" placeholder="${esc(me.name)}'s company"></label><label class="field">STARTER PLOT<select id="newPlot">${freePlots().map(p=>`<option value="${p.id}">Plot ${p.id+1} (${p.x}, ${p.z})</option>`).join('')}</select></label></div><button id="openBiz" class="primary action">Purchase and open</button>`;
    $('#openBiz').onclick=()=>{const type=$('input[name=biztype]:checked')?.value;if(!type)return toast('Choose a business type.',true);send('openBusiness',{businessType:type,plotId:$('#newPlot').value,name:$('#newBizName').value})};return;
  }
  const owned=b.ownerId===playerId,spec=BUSINESS[b.type],remain=Math.max(0,b.productionEnds-Date.now()),duration=({logging:12,farm:10,factory:18}[b.type]||1)*1000,progress=b.productionEnds?Math.max(0,100-remain/duration*100):0;
  $('#panelContent').innerHTML=`<h2>${esc(b.name)}</h2><p class="sub">${spec.icon} ${spec.name} · Plot ${b.plotId+1} · Owner: ${esc(state.players[b.ownerId]?.name)}</p>
    <div class="metric-grid"><div class="metric"><span>CASH</span><b>${money(b.cash)}</b></div><div class="metric"><span>REVENUE</span><b>${money(b.revenue)}</b></div><div class="metric"><span>EXPENSES</span><b>${money(b.expenses)}</b></div><div class="metric"><span>PROFIT</span><b class="${b.revenue-b.expenses>=0?'positive':'negative'}">${money(b.revenue-b.expenses)}</b></div></div>
    <div class="section"><h3>BUSINESS INVENTORY</h3><div class="inventory">${['wood','food','furniture'].map(g=>`<div class="chip"><b>${b.inventory[g]}</b>${g}</div>`).join('')}</div></div>
    ${owned?`<div class="section"><h3>OPERATIONS</h3>${spec.name==='Retail Store'?`<div class="grid2"><label class="field">FOOD RETAIL PRICE<input id="foodPrice" type="number" step=".25" value="${b.pricing.food}"></label><label class="field">FURNITURE RETAIL PRICE<input id="furnPrice" type="number" step="1" value="${b.pricing.furniture}"></label></div><button id="savePrices" class="action">Update prices</button>`:`${b.productionEnds?`<p class="sub">Production in progress · ${Math.ceil(remain/1000)} seconds remaining</p><div class="bar"><i style="width:${progress}%"></i></div>`:`<button id="produce" class="primary">Start production batch</button>`}<div class="row action"><span class="grow sub">${b.workers} worker${b.workers===1?'':'s'} · $${b.workerWage}/batch each</span><button id="hire">Hire · $25</button><button id="auto" ${!b.workers?'disabled':''}>${b.auto?'Stop':'Automate'}</button></div>`}
      <div class="row action"><input id="cashAmount" type="number" min=".01" step="1" placeholder="Amount"><button id="deposit">Deposit</button><button id="withdraw">Withdraw</button></div></div>`:''}
    <div class="section"><h3>OWNERSHIP</h3><p class="sub">${b.sharesOutstanding.toLocaleString()} shares outstanding · issue cap ${b.maxShares.toLocaleString()}</p>${Object.entries(b.shareholders).filter(([,n])=>n>0).map(([id,n])=>`<div class="row"><span class="grow">${esc(state.players[id]?.name||'Former player')}</span><b>${(n/b.sharesOutstanding*100).toFixed(1)}%</b></div>`).join('')}</div>
    ${owned?`<div class="section"><h3>OWNER FINANCE</h3><div class="grid2"><label class="field">NEW SHARES<input id="issueQty" type="number" value="100"></label><label class="field">ASK PRICE<input id="issuePrice" type="number" step=".01" value="5"></label></div><button id="issue" class="action">Issue shares (dilutes ownership)</button><div class="row action"><input id="dividendAmount" type="number" step=".01" placeholder="Total dividend"><button id="dividend">Distribute</button></div></div>`:''}`;
  if(!owned)return;
  $('#produce')?.addEventListener('click',()=>send('produce',{businessId:b.id}));$('#hire')?.addEventListener('click',()=>send('hire',{businessId:b.id,count:1}));$('#auto')?.addEventListener('click',()=>send('toggleAuto',{businessId:b.id}));
  $('#savePrices')?.addEventListener('click',()=>{send('setRetailPrice',{businessId:b.id,good:'food',price:$('#foodPrice').value});send('setRetailPrice',{businessId:b.id,good:'furniture',price:$('#furnPrice').value})});
  $('#deposit').onclick=()=>send('transferCash',{businessId:b.id,amount:$('#cashAmount').value,direction:'toBusiness'});$('#withdraw').onclick=()=>send('transferCash',{businessId:b.id,amount:$('#cashAmount').value,direction:'toPlayer'});
  $('#issue').onclick=()=>send('issueShares',{businessId:b.id,quantity:$('#issueQty').value,price:$('#issuePrice').value});$('#dividend').onclick=()=>send('dividend',{businessId:b.id,amount:$('#dividendAmount').value});
}

function renderMarket(){const mine=me.businesses.map(id=>state.businesses[id]);
  $('#panelContent').innerHTML=`<h2>Goods marketplace</h2><p class="sub">Orders reserve inventory or company cash. Compatible orders settle immediately at the earlier order’s price.</p>
    ${mine.length?`<div class="grid2"><label class="field">BUSINESS<select id="marketBiz">${mine.map(b=>`<option value="${b.id}">${esc(b.name)} · ${money(b.cash)}</option>`).join('')}</select></label><label class="field">SIDE<select id="goodsSide"><option value="buy">Buy supplies</option><option value="sell">Sell goods</option></select></label><label class="field">GOOD<select id="goodsGood"><option>wood</option><option>food</option><option>furniture</option></select></label><label class="field">QUANTITY<input id="goodsQty" type="number" value="1"></label><label class="field">UNIT PRICE<input id="goodsPrice" type="number" step=".01" value="5"></label></div><button id="placeGoods" class="primary action">Place order</button>`:`<div class="notice">Open a business before trading goods.</div>`}
    <div class="section"><h3>OPEN ORDERS</h3>${state.goodsOrders.length?`<table class="table"><thead><tr><th>SIDE</th><th>GOOD</th><th>QTY</th><th>PRICE</th><th>BUSINESS</th><th></th></tr></thead><tbody>${state.goodsOrders.map(o=>`<tr><td class="${o.side==='buy'?'positive':'negative'}">${o.side.toUpperCase()}</td><td>${o.good}</td><td>${o.remaining}</td><td>${money(o.price)}</td><td>${esc(state.businesses[o.businessId]?.name)}</td><td>${o.playerId===playerId?`<button data-cancel-goods="${o.id}">×</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No open goods orders</div>'}</div>
    <div class="section"><h3>RECENT TRANSACTIONS</h3>${state.transactions.length?`<table class="table"><thead><tr><th>GOOD</th><th>QTY</th><th>PRICE</th><th>FROM → TO</th></tr></thead><tbody>${state.transactions.slice(0,12).map(t=>`<tr><td>${t.good}</td><td>${t.quantity}</td><td>${money(t.price)}</td><td>${esc(t.seller)} → ${esc(t.buyer)}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">The market is waiting for its first trade.</div>'}</div>`;
  $('#placeGoods')?.addEventListener('click',()=>send('goodsOrder',{businessId:$('#marketBiz').value,side:$('#goodsSide').value,good:$('#goodsGood').value,quantity:$('#goodsQty').value,price:$('#goodsPrice').value}));
  $$('[data-cancel-goods]').forEach(x=>x.onclick=()=>send('cancelOrder',{kind:'goods',orderId:x.dataset.cancelGoods}));
}
function renderStocks(){const companies=Object.values(state.businesses);const selected=state.businesses[selectedBusiness]||companies[0];
  $('#panelContent').innerHTML=`<h2>Stock exchange</h2><p class="sub">Prices move only when players complete trades. Company-issued shares raise company cash and dilute existing owners.</p>${companies.length?`<label class="field">COMPANY<select id="stockCompany">${companies.map(b=>`<option value="${b.id}" ${b.id===selected.id?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label>
    <div class="metric-grid section"><div class="metric"><span>LAST PRICE</span><b>${selected.recentTrades[0]?money(selected.recentTrades[0].price):'—'}</b></div><div class="metric"><span>COMPANY CASH</span><b>${money(selected.cash)}</b></div><div class="metric"><span>PROFIT</span><b>${money(selected.revenue-selected.expenses)}</b></div><div class="metric"><span>YOUR STAKE</span><b>${((me.holdings[selected.id]||0)/selected.sharesOutstanding*100).toFixed(1)}%</b></div></div>
    <div class="section grid2"><label class="field">SIDE<select id="stockSide"><option value="buy">Buy</option><option value="sell">Sell</option></select></label><label class="field">SHARES<input id="stockQty" type="number" value="10"></label><label class="field">LIMIT PRICE<input id="stockPrice" type="number" step=".01" value="5"></label></div><button id="placeStock" class="primary action">Place stock order</button>
    <div class="section"><h3>ORDER BOOK</h3>${state.stockOrders.filter(o=>o.businessId===selected.id).length?`<table class="table"><thead><tr><th>SIDE</th><th>SHARES</th><th>PRICE</th><th>TRADER</th><th></th></tr></thead><tbody>${state.stockOrders.filter(o=>o.businessId===selected.id).map(o=>`<tr><td>${o.side.toUpperCase()}</td><td>${o.remaining}</td><td>${money(o.price)}</td><td>${o.playerId==='treasury'?'Company':esc(state.players[o.playerId]?.name)}</td><td>${o.playerId===playerId||(o.playerId==='treasury'&&selected.ownerId===playerId)?`<button data-cancel-stock="${o.id}">×</button>`:''}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">No open orders for this company</div>'}</div>
    <div class="section"><h3>RECENT TRADES</h3>${selected.recentTrades.length?selected.recentTrades.map(t=>`<div class="order row"><b class="grow">${t.quantity} shares @ ${money(t.price)}</b><span class="sub">${esc(t.seller)} → ${esc(t.buyer)} · ${age(t.at)}</span></div>`).join(''):'<div class="empty">No completed trades. Prices never move randomly.</div>'}</div>`:'<div class="empty">No companies exist yet.</div>'}`;
  $('#stockCompany')?.addEventListener('change',e=>{selectedBusiness=e.target.value;renderStocks()});$('#placeStock')?.addEventListener('click',()=>send('stockOrder',{businessId:selected.id,side:$('#stockSide').value,quantity:$('#stockQty').value,price:$('#stockPrice').value}));
  $$('[data-cancel-stock]').forEach(x=>x.onclick=()=>send('cancelOrder',{kind:'stock',orderId:x.dataset.cancelStock}));
}
function renderPlayers(){
  $('#panelContent').innerHTML=`<h2>Town residents</h2><p class="sub">Invite friends with room code <b>${state.code}</b>. Reconnecting with the same browser restores progress.</p><div class="cards">${Object.values(state.players).map(p=>`<div class="company row"><span style="width:10px;height:10px;border-radius:50%;background:${p.online?'#43a56c':'#a9b0ab'}"></span><div class="grow"><b>${esc(p.name)} ${p.id===playerId?'(you)':''}</b><p>${p.businesses.length} business${p.businesses.length===1?'':'es'} · ${Object.values(p.holdings).reduce((a,b)=>a+b,0).toLocaleString()} shares</p></div><span class="badge">${p.online?'ONLINE':'OFFLINE'}</span></div>`).join('')}</div>`;
}
