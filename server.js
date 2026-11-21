// Luna & Andgel — blind relay. Encrypted payloads are stored, never decrypted here.
// Start: npm install ws && node server.js
'use strict';
const http=require('http'),https=require('https'),fs=require('fs'),path=require('path'),crypto=require('crypto'),{WebSocketServer}=require('ws');
const pairingCode=process.env.PAIRING_CODE;
if(typeof pairingCode!=='string'||pairingCode.length<16){console.error('Le code d’appairage est absent ou invalide');process.exit(1)}
const same=(a,b)=>{a=Buffer.from(String(a||''));b=Buffer.from(String(b||''));return a.length===b.length&&crypto.timingSafeEqual(a,b)};
const root=__dirname,dataDir=process.env.DATA_DIR||root,pageFile=path.join(root,'index.html'),queueFile=path.join(dataDir,'pending-messages.json'),pubFile=path.join(dataDir,'public-keys.json'),scheduleFile=path.join(dataDir,'scheduled-messages.json');
fs.mkdirSync(dataDir,{recursive:true});
function readJSON(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(error){if(error.code==='ENOENT')return fallback;console.error(`Impossible de lire ${file}:`,error.message);throw error}}
function writeJSON(file,data){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data));fs.renameSync(tmp,file)}
const pushFile=path.join(dataDir,'push-tokens.json'),pushTokens=readJSON(pushFile,{andgel:[],luna:[]});
let firebaseAdmin=null;
if(process.env.GOOGLE_APPLICATION_CREDENTIALS){
 try{firebaseAdmin=require('firebase-admin');firebaseAdmin.initializeApp({credential:firebaseAdmin.credential.applicationDefault()})}
 catch(error){console.error('[relay] Push notifications disabled:',error.message)}
}
const pushCategories=new Set(['message','voice','affection','reaction','date','game']);
function notifyProfile(who,category){
 if(!firebaseAdmin||!pushCategories.has(category))return;
 const devices=(pushTokens[who]||[]).filter(device=>device.preferences?.[category]!==false);
 if(!devices.length)return;
 void firebaseAdmin.messaging().sendEachForMulticast({
  tokens:devices.map(device=>device.token),
  notification:{title:'Luna & Andgel',body:category==='voice'?'Nouveau message vocal':category==='affection'?'Un cœur ou un câlin t’attend':category==='reaction'?'Nouvelle réaction':category==='date'?'Une date importante a changé':category==='game'?'Une invitation à jouer t’attend':'Nouveau message'},
  data:{category}
 }).then(result=>{
  const invalid=new Set();
  result.responses.forEach((response,index)=>{
   if(!response.success&&['messaging/registration-token-not-registered','messaging/invalid-registration-token'].includes(response.error?.code))invalid.add(devices[index].token);
   else if(!response.success)console.error('[relay] Push delivery failed:',response.error?.message||'unknown error');
  });
  if(invalid.size){pushTokens[who]=devices.filter(device=>!invalid.has(device.token));writeJSON(pushFile,pushTokens)}
 }).catch(error=>console.error('[relay] Push delivery failed:',error.message));
}
const on={},pubs=readJSON(pubFile,{}),queue=readJSON(queueFile,{andgel:[],luna:[]}),schedules=readJSON(scheduleFile,[]);
const authAttempts=new Map();
for(const who of ['andgel','luna'])if(!Array.isArray(queue[who]))queue[who]=[];
const other=w=>w==='andgel'?'luna':'andgel';const isOpen=ws=>ws&&ws.readyState===1;
function safeSend(ws,obj){if(isOpen(ws))try{ws.send(JSON.stringify(obj))}catch{}}
function persistQueue(){writeJSON(queueFile,queue)}
function persistSchedules(){writeJSON(scheduleFile,schedules)}
function deliverPending(who){const socket=on[who];if(!isOpen(socket))return;for(const item of queue[who])safeSend(socket,{t:'msg',id:item.id,d:item.d})}
const requestHandler=(req,res)=>{
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,connected:{andgel:isOpen(on.andgel),luna:isOpen(on.luna)},pending:{andgel:queue.andgel.length,luna:queue.luna.length},scheduled:schedules.length}))}
 const assets={'/manifest.webmanifest':['manifest.webmanifest','application/manifest+json; charset=utf-8'],'/app-icon.svg':['app-icon.svg','image/svg+xml'],'/app-icons.css':['app-icons.css','text/css; charset=utf-8'],'/pwa.js':['pwa.js','text/javascript; charset=utf-8'],'/update-config.js':['update-config.js','text/javascript; charset=utf-8'],'/enhancements.js':['enhancements.js','text/javascript; charset=utf-8'],'/sw.js':['sw.js','text/javascript; charset=utf-8']};
 if(assets[pathname]){const [file,type]=assets[pathname];try{const body=fs.readFileSync(path.join(root,file));res.writeHead(200,{'Content-Type':type,'Cache-Control':file==='sw.js'?'no-cache':'public, max-age=3600','X-Content-Type-Options':'nosniff'});return res.end(body)}catch{res.writeHead(500);return res.end('Application asset unavailable')}}
 if(pathname!=='/'){res.writeHead(404);return res.end('Not found')}
 let page;try{page=fs.readFileSync(pageFile)}catch{res.writeHead(500);return res.end('index.html introuvable')}
 const pwaHead='<link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/app-icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/app-icons.css"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Luna & Andgel"><script defer src="/update-config.js"></script><script defer src="/pwa.js"></script>';
 page=Buffer.from(page.toString().replace('</head>',pwaHead+'</head>'));
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src data: blob:; connect-src 'self' ws: wss:; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'"});res.end(page)
};
const tlsKey=process.env.TLS_KEY_FILE,tlsCert=process.env.TLS_CERT_FILE;
if(Boolean(tlsKey)!==Boolean(tlsCert)){console.error('Définis TLS_KEY_FILE et TLS_CERT_FILE ensemble');process.exit(1)}
const srv=tlsKey
 ?https.createServer({key:fs.readFileSync(tlsKey),cert:fs.readFileSync(tlsCert)},requestHandler)
 :http.createServer(requestHandler);
const wss=new WebSocketServer({server:srv,maxPayload:12*1024*1024});
function enqueue(recipient,item){if(queue[recipient].length>=500)return false;queue[recipient].push(item);persistQueue();return true}
function deliverScheduled(){const now=Date.now();for(let i=schedules.length-1;i>=0;i--){const item=schedules[i];if(item.deliverAt>now)continue;
 if(queue[item.recipient].length>=500){item.deliverAt=now+30000;safeSend(on[item.sender],{t:'scheduleDelayed',clientId:item.clientId});continue}
 const message={id:crypto.randomBytes(12).toString('hex'),d:item.d,clientId:item.clientId,scheduled:1};queue[item.recipient].push(message);persistQueue();if(isOpen(on[item.recipient]))safeSend(on[item.recipient],{t:'msg',id:message.id,d:message.d});safeSend(on[item.sender],{t:'scheduleFired',clientId:item.clientId,deliverAt:item.deliverAt});schedules.splice(i,1);persistSchedules();
 }}
const scheduleTicker=setInterval(deliverScheduled,1000);scheduleTicker.unref?.();
wss.on('connection',ws=>{
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}
 if(m.t==='hi'){
  const address=ws._socket?.remoteAddress||'unknown',attempt=authAttempts.get(address)||{count:0,since:Date.now()};
  if(Date.now()-attempt.since>60000){attempt.count=0;attempt.since=Date.now()}
  attempt.count++;authAttempts.set(address,attempt);
  if(attempt.count>12||!same(m.pairingCode,pairingCode)||!['andgel','luna'].includes(m.who)||typeof m.pub!=='string'||!m.pub||m.pub.length>2048){safeSend(ws,{t:'bad'});ws.close(1008,'Pairing required');return}
  authAttempts.delete(address);
  if(ws.who)return;ws.who=m.who;pubs[m.who]=String(m.pub||'');writeJSON(pubFile,pubs);
  if(on[m.who]&&on[m.who]!==ws)on[m.who].close();on[m.who]=ws;const peer=other(m.who);
  safeSend(ws,{t:'peer',pub:pubs[peer]||null,online:isOpen(on[peer])});if(isOpen(on[peer]))safeSend(on[peer],{t:'presence',online:true});deliverPending(m.who);
 }else if(m.t==='pushRegister'&&ws.who){
  if(typeof m.token!=='string'||m.token.length<32||m.token.length>4096)return;
  const preferences=Object.fromEntries([...pushCategories].map(category=>[category,m.preferences?.[category]!==false]));
  const entries=(pushTokens[ws.who]||[]).filter(device=>device.token!==m.token);
  entries.push({token:m.token,preferences});pushTokens[ws.who]=entries.slice(-3);writeJSON(pushFile,pushTokens);
 }else if(m.t==='pushUnregister'&&ws.who&&typeof m.token==='string'){
  pushTokens[ws.who]=(pushTokens[ws.who]||[]).filter(device=>device.token!==m.token);writeJSON(pushFile,pushTokens);
 }else if(m.t==='msg'&&ws.who){const recipient=other(ws.who),entry={id:crypto.randomBytes(12).toString('hex'),d:String(m.d||''),clientId:String(m.clientId||'')};if(!enqueue(recipient,entry)){safeSend(ws,{t:'queuefull'});return}safeSend(ws,{t:'accepted',clientId:entry.clientId});if(isOpen(on[recipient]))safeSend(on[recipient],{t:'msg',id:entry.id,d:entry.d});if(pushCategories.has(m.category))notifyProfile(recipient,m.category);
 }else if(m.t==='schedule'&&ws.who){const deliverAt=Number(m.deliverAt),clientId=String(m.clientId||''),d=String(m.d||'');if(!clientId||!d||!Number.isFinite(deliverAt)||deliverAt<Date.now()+5000||deliverAt>Date.now()+30*86400000||schedules.length>=200){safeSend(ws,{t:'scheduleRejected',clientId,reason:'invalid'});return}if(schedules.some(x=>x.sender===ws.who&&x.clientId===clientId)){safeSend(ws,{t:'scheduleAccepted',clientId});return}schedules.push({sender:ws.who,recipient:other(ws.who),clientId,d,deliverAt});persistSchedules();safeSend(ws,{t:'scheduleAccepted',clientId});
 }else if(m.t==='cancelSchedule'&&ws.who){const clientId=String(m.clientId||''),idx=schedules.findIndex(x=>x.sender===ws.who&&x.clientId===clientId);if(idx>=0){schedules.splice(idx,1);persistSchedules();safeSend(ws,{t:'scheduleCanceled',clientId})}
 }else if(m.t==='ack'&&ws.who&&m.id){const who=ws.who,old=queue[who].length;queue[who]=queue[who].filter(x=>x.id!==String(m.id));if(queue[who].length!==old)persistQueue();
 }
 });
 ws.on('close',()=>{if(ws.who&&on[ws.who]===ws){delete on[ws.who];const peer=other(ws.who);safeSend(on[peer],{t:'presence',online:false})}});
 ws.on('error',err=>console.error('WebSocket client error:',err.message));
});
srv.listen(process.env.PORT||3000,()=>console.log('Relais Luna & Andgel prêt sur le port',process.env.PORT||3000));
