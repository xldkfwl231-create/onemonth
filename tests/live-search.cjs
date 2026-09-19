const {chromium}=require('playwright');
(async()=>{
 const b=await chromium.launch({channel:'msedge',headless:true});
 const p=await b.newPage();
 p.on('requestfailed',r=>console.log('REQUEST FAILED',r.url().split('?')[0],r.failure()?.errorText));
 await p.goto('http://127.0.0.1:4173');
 const result=await p.evaluate(async()=>{
   const r=await fetch('https://openlibrary.org/search.json?q=isbn%3A9780140328721&limit=1&fields=key,title,author_name,cover_i',{signal:AbortSignal.timeout(15000)});
   const d=await r.json();
   const book=d.docs?.[0];
   if(!book)throw new Error('No live book returned');
   const image=new Image(); image.referrerPolicy='no-referrer'; image.src=`https://covers.openlibrary.org/b/id/${book.cover_i}-M.jpg?default=false`;
   await image.decode();
   return {status:r.status,title:book.title,author:book.author_name,coverId:book.cover_i,coverSize:[image.naturalWidth,image.naturalHeight]};
 });
 console.log(JSON.stringify(result));
 await b.close();
})().catch(e=>{console.error(e);process.exit(1);});
