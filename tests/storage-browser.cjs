const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const b=await chromium.launch({headless:true,channel:'msedge'});
 const c=await b.newContext();const p=await c.newPage();await p.goto('http://127.0.0.1:4173');await p.getByRole('heading',{name:'나의 책장'}).waitFor();
 const result=await p.evaluate(async()=>{
  const {openStore,load,commit,previous}=await import('/src/storage.js');const db=await openStore();
  const initial=await load(db);const a=structuredClone(initial.state),z=structuredClone(initial.state);
  a.thoughts.push({id:crypto.randomUUID(),text:'창 A의 기록',createdAt:new Date().toISOString()});
  z.thoughts.push({id:crypto.randomUUID(),text:'창 B의 기록',createdAt:new Date().toISOString()});
  const results=await Promise.allSettled([commit(db,a,initial.revision),commit(db,z,initial.revision)]);
  const current=await load(db),prev=await previous(db);
  let badRejected=false;try{await commit(db,{version:2,books:[],thoughts:'bad',trips:[]},current.revision);}catch{badRejected=true;}
  const after=await load(db);
  return {results:results.map(r=>r.status),current:current.state,prev,badRejected,unchanged:JSON.stringify(current)===JSON.stringify(after)};
 });
 assert.deepEqual(result.results,['fulfilled','rejected']);assert.equal(result.current.thoughts[0].text,'창 A의 기록');assert.equal(result.prev.thoughts.length,0);assert.ok(result.badRejected&&result.unchanged);
 console.log('PASS atomic revision conflict, prior snapshot, malformed commit leaves database unchanged');
 const broken=await b.newContext();const q=await broken.newPage();
 await broken.addInitScript(()=>localStorage.setItem('onemonth_v1','{"books":[{"t":"broken","e":{}}]}'));
 await q.goto('http://127.0.0.1:4173');await q.getByRole('heading',{name:'기록을 안전하게 열지 못했습니다'}).waitFor();
 const original=await q.evaluate(()=>localStorage.getItem('onemonth_v1'));assert.match(original,/broken/);
 const noCurrent=await q.evaluate(async()=>{const {openStore}=await import('/src/storage.js');const db=await openStore();return new Promise(resolve=>{const r=db.transaction('records').objectStore('records').get('current');r.onsuccess=()=>resolve(!r.result);});});
 assert.ok(noCurrent);console.log('PASS malformed legacy data never overwritten or migrated to empty state');
 await b.close();
})().catch(e=>{console.error(e);process.exit(1);});
