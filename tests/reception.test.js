'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {initReception,installReception}=require('../reception-server');
const id=()=>crypto.randomUUID();let db,server,origin,recordId;
const users={},sample={customerName:'مشتری آزمایشی',phone:'۰۹۱۲۱۲۳۴۵۶۷',model:'پژو ۲۰۷',plate:'۱۲ ب ۳۴۵ ـ ۶۷',color:'سفید',mileage:'۱۲۳۴۵',services:'پولیش و صفرشویی',condition:'خط روی در عقب',dueAt:'2026-11-02T14:30:00+03:30'};
async function q(sql,args=[]){const r=args.length?await db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};return {...r,rowCount:r.rows.length||r.affectedRows||0}}
async function request(path='',body,user='owner',method){const r=await fetch(origin+'/api/reception'+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json','x-user':user},body:body?JSON.stringify(body):undefined});return {status:r.status,data:(r.headers.get('content-type')||'').includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer()),cache:r.headers.get('cache-control')}}
async function ok(path='',body,user='owner',method){const r=await request(path,body,user,method);assert.ok(r.status<300,JSON.stringify(r));return r.data}
before(async()=>{db=new PGlite();await db.waitReady;await q('CREATE TABLE users(id UUID PRIMARY KEY);CREATE TABLE audit_log(id UUID PRIMARY KEY,action TEXT,target TEXT,data JSONB,actor_id UUID);');await initReception(q);await initReception(q);const owner=id(),editor=id();await q('INSERT INTO users(id) VALUES($1),($2)',[owner,editor]);users.owner={sub:owner,name:'Owner',role:'owner'};users.editor={sub:editor,name:'Receptionist',role:'viewer',reception_access:true,reception_edit:true};users.viewer={...users.editor,reception_edit:false};users.denied={...users.editor,reception_access:false};const app=express();app.use(express.json({limit:'4mb'}));installReception(app,{q,pool:{connect:async()=>({query:q,release(){}})},auth:(req,res,next)=>{req.user=users[req.headers['x-user']];if(!req.user)return res.sendStatus(401);next()}});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close()});
test('reception grants isolate records, writes and photos',async()=>{
 assert.equal((await request('',null,'denied')).status,403);
 assert.equal((await request('',{...sample,id:id()},'viewer')).status,403);
 assert.equal((await request('/bad')).status,400);
 assert.equal((await request('/'+id())).status,404);
 assert.equal((await request('',{...sample,id:id(),phone:'bad'})).status,400);
 assert.equal((await request('',{...sample,id:id(),mileage:-1})).status,400);
 assert.equal((await request('',{...sample,id:id(),dueAt:'bad'})).status,400);
 assert.equal((await request('',{...sample,id:id(),plate:''})).status,400);
});
test('automatic numbers, idempotent creation and searchable paginated lists',async()=>{
 recordId=id();const payload={...sample,id:recordId},first=await ok('',payload,'editor'),retry=await ok('',payload,'editor');
 assert.equal(first.number,1);assert.equal(retry.replayed,true);assert.equal(retry.number,first.number);
 assert.equal((await request('',{...payload,services:'changed'},'editor')).status,409);
 assert.equal((await request('',payload,'owner')).status,409);
 const detail=await ok('/'+recordId);assert.equal(detail.phone,'09121234567');assert.equal(detail.mileage,12345);assert.equal(detail.status,'received');assert.equal(detail.version,1);assert.equal(detail.events.length,1);assert.deepEqual(detail.photos,[]);
 let list=await ok('?q='+encodeURIComponent('۲۰۷'));assert.equal(list.total,1);assert.equal(list.items[0].number,1);assert.equal(list.items[0].photoCount,0);assert.equal(list.counts.received,1);
 assert.equal((await ok('?q=09121234567')).total,1);assert.equal((await ok('?q=%25')).total,0);assert.equal((await ok('?status=ready')).total,0);
 assert.equal((await request('?page=-1')).status,400);assert.equal((await request('?status=bad')).status,400);
 assert.equal((await request('/'+recordId)).cache,'private, no-store');
});
test('versioned editing preserves delivery status and rejects stale updates',async()=>{
 assert.equal((await request('/'+recordId,{...sample,version:1},'viewer','PUT')).status,403);
 await ok('/'+recordId,{...sample,services:'ویرایش خدمات',version:1},'editor','PUT');
 assert.equal((await request('/'+recordId,{...sample,version:1},'editor','PUT')).status,409);
 await ok('/'+recordId+'/status',{status:'working',version:2},'editor','PATCH');
 await ok('/'+recordId+'/status',{status:'ready',version:3},'editor','PATCH');
 assert.equal((await request('/'+recordId+'/status',{status:'bad',version:4},'editor','PATCH')).status,400);
 await ok('/'+recordId+'/status',{status:'delivered',version:4},'editor','PATCH');
 let r=await ok('/'+recordId);assert.ok(r.deliveredAt);assert.equal(r.events.filter(e=>e.action==='status').length,3);
 const acceptedAt='2026-11-01T09:30:00+03:30';
 await ok('/'+recordId,{...sample,acceptedAt,version:5},'editor','PUT');
 r=await ok('/'+recordId);assert.equal(r.status,'delivered');assert.ok(r.deliveredAt);assert.equal(r.acceptedAt,new Date(acceptedAt).toISOString());
 await ok('/'+recordId+'/status',{status:'working',version:6},'owner','PATCH');r=await ok('/'+recordId);assert.equal(r.deliveredAt,null);assert.equal(r.version,7);
 assert.equal((await q("SELECT COUNT(*)::int AS n FROM audit_log WHERE target=$1",[recordId])).rows[0].n,7);
});
test('authenticated photos validate file data, deduplicate retries and enforce the five-photo limit',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4wAAAABJRU5ErkJggg==','base64');
 const photo={id:id(),mime:'image/png',data:png.toString('base64')};
 assert.equal((await request('/'+recordId+'/photos',photo,'viewer')).status,403);
 assert.equal((await request('/'+recordId+'/photos',{...photo,mime:'image/svg+xml'})).status,400);
 assert.equal((await request('/'+recordId+'/photos',{...photo,data:Buffer.from('not png').toString('base64')})).status,400);
 assert.equal((await request('/'+recordId+'/photos',{...photo,data:Buffer.alloc(2*1024*1024+1).toString('base64')})).status,400);
 await ok('/'+recordId+'/photos',photo,'editor');assert.equal((await ok('/'+recordId+'/photos',photo,'editor')).replayed,true);
 const duplicate=await ok('/'+recordId+'/photos',{...photo,id:id()},'editor');assert.equal(duplicate.id,photo.id);assert.equal(duplicate.replayed,true);
 const downloaded=await request('/'+recordId+'/photos/'+photo.id,null,'viewer');assert.equal(downloaded.status,200);assert.deepEqual(downloaded.data,png);assert.equal(downloaded.cache,'private, no-store');
 assert.equal((await request('/'+recordId+'/photos/'+photo.id,null,'denied')).status,403);
 assert.equal((await request('/'+id()+'/photos/'+photo.id)).status,404);
 for(let i=0;i<4;i++)await ok('/'+recordId+'/photos',{...photo,id:id(),data:Buffer.concat([png,Buffer.from([i])]).toString('base64')},'editor');
 assert.equal((await ok('/'+recordId)).photos.length,5);
 assert.equal((await request('/'+recordId+'/photos',{...photo,id:id(),data:Buffer.concat([png,Buffer.from([9])]).toString('base64')},'editor')).status,409);
 await ok('/'+recordId+'/status',{status:'delivered',version:7},'editor','PATCH');
 assert.equal((await request('/'+recordId+'/photos',photo,'editor')).status,409);
});
