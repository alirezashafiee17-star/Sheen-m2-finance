'use strict';
const {test,before,after}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express'),{PGlite}=require('@electric-sql/pglite');
const {initInventory,installInventory}=require('../inventory-server'),{initReception}=require('../reception-server'),{initInvoices,installInvoices}=require('../invoice-server');
const id=()=>crypto.randomUUID();let db,server,origin,itemId,billId;const users={};
async function q(sql,args=[]){const r=args.length?await db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};return {...r,rowCount:r.rows.length||r.affectedRows||0}}
const draft=(overrides={})=>({id:id(),customerName:'مشتری تست',phone:'09121234567',model:'پژو ۲۰۷',plate:'۱۲ ب ۳۴۵',items:[{type:'service',title:'پولیش',quantity:1,unitPrice:1000}],discount:100,draftPaid:0,...overrides});
async function request(path='',body,user='owner',method){const r=await fetch(origin+'/api/invoices'+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json','x-user':user},body:body?JSON.stringify({requestId:id(),...body}):undefined});return {status:r.status,data:await r.json()}}
async function ok(path='',body,user='owner',method){const r=await request(path,body,user,method);assert.ok(r.status<300,JSON.stringify(r));return r.data}
before(async()=>{db=new PGlite();await db.waitReady;await q(`CREATE TABLE users(id UUID PRIMARY KEY);CREATE TABLE showroom_cars(id UUID PRIMARY KEY,title TEXT,year TEXT);CREATE TABLE transactions(id UUID PRIMARY KEY,kind TEXT,amount BIGINT,description TEXT,happened_at TIMESTAMPTZ,period TEXT,actor_id UUID,actor_name TEXT,actor_email TEXT,deleted_at TIMESTAMPTZ);CREATE TABLE periods(period TEXT PRIMARY KEY,closed BOOLEAN);CREATE TABLE audit_log(id UUID PRIMARY KEY,action TEXT,target TEXT,data JSONB,actor_id UUID);`);await initInventory(q);await initReception(q);await initInvoices(q);await initInvoices(q);for(const name of ['owner','editor','viewer','denied','clerk','limited']){const sub=id();await q('INSERT INTO users(id) VALUES($1)',[sub]);users[name]={sub,name,email:'test@example.invalid',role:name==='owner'?'owner':'viewer',invoice_access:name!=='denied',invoice_edit:!['viewer','denied'].includes(name),inventory_access:true,inventory_edit:true,inventory_scope:'services',finance_access:true,finance_edit:true}}users.clerk.inventory_access=false;users.clerk.finance_access=false;users.limited.finance_entry_only=true;
 const app=express();app.use(express.json());const auth=(req,res,next)=>{req.user=users[req.headers['x-user']];if(!req.user)return res.sendStatus(401);next()},pool={connect:async()=>({query:q,release(){}})},periodOf=()=> 'test-period',currentPeriod=()=> 'test-period';installInventory(app,{q,pool,auth,periodOf,currentPeriod});installInvoices(app,{q,pool,auth,periodOf,currentPeriod});server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;
 itemId=id();await q("INSERT INTO inventory_items(id,scope,sku,name,category,unit,quantity,stock_value) VALUES($1,'services','TEST','دستمال','مواد مصرفی','عدد',20,2000)",[itemId]);
});
after(async()=>{if(server)await new Promise(r=>server.close(r));if(db)await db.close()});
test('invoice module isolates view/edit permissions and validates calculated totals',async()=>{
 assert.equal((await request('',null,'denied')).status,403);assert.equal((await request('',draft(),'viewer')).status,403);
 assert.equal((await request('',draft({items:[]}))).status,400);assert.equal((await request('',draft({discount:1001}))).status,400);assert.equal((await request('',draft({draftPaid:1001}))).status,400);
 for(const quantity of [0,-1,0.0001,1e7])assert.equal((await request('',draft({items:[{type:'service',title:'x',quantity,unitPrice:100}]}))).status,400);
 assert.equal((await request('',draft({items:[{type:'goods',itemId,quantity:1,unitPrice:200}]}),'clerk')).status,403);
 assert.deepEqual(await ok('/catalog',null,'clerk'),[]);assert.equal((await ok('/catalog'))[0].available,20);
});
test('draft registration is idempotent, searchable and has no inventory or financial effects',async()=>{
 const payload=draft({requestId:id(),items:[{type:'service',title:'پولیش',quantity:1,unitPrice:1000},{type:'goods',itemId,quantity:5,unitPrice:200}],draftPaid:500}),first=await ok('',payload);billId=first.id;
 assert.equal((await ok('',payload)).replayed,true);assert.equal((await request('',{...payload,discount:0})).status,409);
 const r=await ok('/'+billId);assert.equal(r.total,1900);assert.equal(r.subtotal,2000);assert.equal(r.paid,0);assert.equal(r.draftPaid,500);assert.equal(r.items[1].title,'دستمال');assert.equal(r.items[1].unit,'عدد');
 assert.equal((await q('SELECT quantity FROM inventory_items WHERE id=$1',[itemId])).rows[0].quantity,'20.000');assert.equal((await q('SELECT COUNT(*)::int AS n FROM transactions')).rows[0].n,0);
 assert.equal((await ok('?q='+encodeURIComponent('۲۰۷'))).total,1);assert.equal((await ok('?status=issued')).total,0);assert.equal((await request('?page=-1')).status,400);
});
test('finalization writes stock and the actual income once; retries do not duplicate either',async()=>{
 const payload={version:1,requestId:id()};await ok('/'+billId+'/issue',payload);assert.equal((await ok('/'+billId+'/issue',payload)).replayed,true);
 const r=await ok('/'+billId);assert.equal(r.status,'issued');assert.equal(r.paid,500);assert.equal(r.remaining,1400);assert.equal(r.payments.length,1);
 const item=(await q('SELECT * FROM inventory_items WHERE id=$1',[itemId])).rows[0];assert.equal(item.quantity,'15.000');assert.equal(Number(item.stock_value),1500);
 assert.equal((await q('SELECT COUNT(*)::int AS n FROM inventory_moves WHERE invoice_id=$1',[billId])).rows[0].n,1);assert.equal((await q("SELECT SUM(amount)::text AS n FROM transactions WHERE kind='income'")).rows[0].n,'500');
 assert.equal((await request('/'+billId+'/issue',{version:2})).status,409);
 const move=(await q('SELECT id FROM inventory_moves WHERE invoice_id=$1',[billId])).rows[0];const response=await fetch(origin+'/api/inventory/movements/'+move.id,{method:'PUT',headers:{'content-type':'application/json','x-user':'owner'},body:JSON.stringify({requestId:id(),scope:'services',quantity:4,party:'Bypass',reason:'invalid',date:new Date().toISOString()})});assert.equal(response.status,409);
});
test('issued invoice edits keep payments and adjust only stock differences with history',async()=>{
 const r=await ok('/'+billId),payload={...r,items:[r.items[0],{...r.items[1],quantity:3}],draftPaid:r.paid,reason:'تعداد اصلاح شد',requestId:id()};await ok('/'+billId,payload,'owner','PUT');assert.equal((await ok('/'+billId,payload,'owner','PUT')).replayed,true);
 let item=(await q('SELECT * FROM inventory_items WHERE id=$1',[itemId])).rows[0];assert.equal(item.quantity,'17.000');assert.equal(Number(item.stock_value),1700);
 let changed=await ok('/'+billId);assert.equal(changed.total,1500);assert.equal(changed.paid,500);assert.equal(changed.payments.length,1);assert.ok(changed.events.some(e=>e.action==='edited'&&e.reason==='تعداد اصلاح شد'));
 assert.equal((await request('/'+billId,{...payload,requestId:id()},'owner','PUT')).status,409);
 assert.equal((await request('/'+billId,{...changed,draftPaid:500,reason:''},'owner','PUT')).status,400);
 await ok('/'+billId,{...changed,items:[changed.items[0],{...changed.items[1],quantity:4}],draftPaid:500,reason:'یک عدد اضافه شد'},'owner','PUT');
 item=(await q('SELECT * FROM inventory_items WHERE id=$1',[itemId])).rows[0];assert.equal(item.quantity,'16.000');assert.equal(Number(item.stock_value),1600);
 changed=await ok('/'+billId);const moves=await q('SELECT type,quantity,value_amount FROM inventory_moves WHERE invoice_id=$1 ORDER BY created_at',[billId]);assert.deepEqual(moves.rows.map(m=>m.type),['sale','return','sale']);
 await ok('/'+billId,{...changed,draftPaid:500,notes:'metadata only',reason:'توضیح جدید'},'owner','PUT');assert.equal((await q('SELECT COUNT(*)::int AS n FROM inventory_moves WHERE invoice_id=$1',[billId])).rows[0].n,3);
});
test('overselling duplicate goods lines and finance permission failures roll back atomically',async()=>{
 let r=await ok('',draft({items:[{type:'goods',itemId,quantity:10,unitPrice:200},{type:'goods',itemId,quantity:10,unitPrice:200}],discount:0,draftPaid:100}));const before=(await q('SELECT quantity,stock_value FROM inventory_items WHERE id=$1',[itemId])).rows[0];assert.equal((await request('/'+r.id+'/issue',{version:1})).status,409);assert.equal((await ok('/'+r.id)).status,'draft');assert.deepEqual((await q('SELECT quantity,stock_value FROM inventory_items WHERE id=$1',[itemId])).rows[0],before);
 r=await ok('',draft({draftPaid:100}),'clerk');assert.equal((await request('/'+r.id+'/issue',{version:1},'clerk')).status,403);assert.equal((await ok('/'+r.id)).status,'draft');
 r=await ok('',draft({items:[{type:'goods',itemId,quantity:1,unitPrice:200}],discount:0,draftPaid:100}));users.editor.finance_access=false;assert.equal((await request('/'+r.id+'/issue',{version:1},'editor')).status,403);users.editor.finance_access=true;assert.deepEqual((await q('SELECT quantity,stock_value FROM inventory_items WHERE id=$1',[itemId])).rows[0],before);
 users.editor.inventory_scope='gallery';assert.equal((await request('/'+r.id+'/issue',{version:1},'editor')).status,403);users.editor.inventory_scope='services';
});
test('additional payments enforce the outstanding balance, closed periods and editing rights',async()=>{
 let r=await ok('/'+billId);const payload={version:r.version,amount:r.remaining,requestId:id()};assert.equal((await request('/'+billId+'/payments',payload,'viewer')).status,403);assert.equal((await request('/'+billId+'/payments',payload,'limited')).status,403);
 await q("INSERT INTO periods(period,closed) VALUES('test-period',true)");assert.equal((await request('/'+billId+'/payments',payload,'editor')).status,403);await q("UPDATE periods SET closed=false");
 await ok('/'+billId+'/payments',payload,'editor');assert.equal((await ok('/'+billId+'/payments',payload,'editor')).replayed,true);r=await ok('/'+billId);assert.equal(r.remaining,0);assert.equal(r.payments.length,2);assert.equal(r.paid,r.total);
 assert.equal((await request('/'+billId+'/payments',{version:r.version,amount:1})).status,400);
 assert.equal((await request('/'+billId,{...r,discount:r.subtotal,draftPaid:r.paid,reason:'invalid'},'owner','PUT')).status,400);
});
