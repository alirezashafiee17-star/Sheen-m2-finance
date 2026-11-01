'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');const {PGlite}=require('@electric-sql/pglite');const {JSDOM}=require('jsdom');
test('full app: migration, login, inventory-only member, UI forms, and linked finance guards',async()=>{
 const db=new PGlite();await db.waitReady;const errors=[];let server,dom;
 async function query(sql,args=[]){const r=args.length?await db.query(sql,args):(await db.exec(sql)).at(-1)||{rows:[]};return {...r,rowCount:r.rows.length||r.affectedRows||0}}
 const app=require('express')();app.listen=()=>{};
 const context={require:name=>name==='express'?Object.assign(()=>app,require('express')):name==='pg'?{Pool:class{query(...a){return query(...a)}async connect(){return {query,release(){}}}}}:require('node:module').createRequire(path.resolve(__dirname,'../server.js'))(name),__dirname:path.resolve(__dirname,'..'),process:{env:{DATABASE_URL:'memory',JWT_SECRET:'dummy-test-key-for-inventory',OWNER_EMAIL:'owner@example.invalid',OWNER_PASSWORD:'Test-only-secret-123'},exit:()=>{throw Error('unexpected exit')}},console:{log(){},error(...a){errors.push(a.join(' '))}},Buffer,Uint8Array,Map,Number,Date,setTimeout:()=>{}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../server.js'),'utf8').replace(/connectDatabase\(\);\s*$/,'globalThis.initialized=connectDatabase();'),context);await context.initialized;assert.deepEqual(errors,[]);
 server=require('http').createServer(app).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin='http://127.0.0.1:'+server.address().port;
 const call=async(p,b,t,method)=>{const r=await fetch(origin+'/api'+p,{method:method||(b?'POST':'GET'),headers:{'content-type':'application/json',...(t?{authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return {status:r.status,data:await r.json()}};
 try{
  const auth=await call('/auth/login',{email:'owner@example.invalid',password:'Test-only-secret-123'});assert.equal(auth.status,200);const token=auth.data.token;assert.equal(auth.data.user.inventoryAccess,true);
  const member={name:'Stock clerk',email:'clerk@example.invalid',password:'Test-clerk-secret-123',role:'viewer',displayTitle:'کارمند',financeAccess:false,financeEdit:false,financeEntryOnly:false,showroomAccess:false,showroomEdit:false,scoutAccess:false,inventoryAccess:true,inventoryEdit:true,inventoryPrices:false,inventoryScope:'services'};
  const created=await call('/members',member,token);assert.equal(created.status,201,JSON.stringify(created));const updated=await call('/members/'+created.data.id,member,token,'PUT');assert.equal(updated.status,200);
  const listed=await call('/members',null,token);assert.equal(listed.data[0].inventoryScope,'services');assert.equal(listed.data[0].inventoryAccess,true);
  const login=await call('/auth/login',{email:member.email,password:member.password});assert.equal(login.status,200);assert.equal(login.data.user.inventoryAccess,true);assert.equal(login.data.user.inventoryPrices,false);assert.equal((await call('/transactions',null,login.data.token)).status,403);assert.equal((await call('/inventory?scope=gallery',null,login.data.token)).status,403);
  dom=new JSDOM(fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8'),{url:origin,runScripts:'dangerously',pretendToBeVisual:true});const w=dom.window;w.fetch=(url,opt)=>fetch(new URL(url,origin),opt);w.scrollTo=()=>{};w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};w.confirm=()=>true;
  for(const file of ['app.js','showroom.js','scout.js','inventory.js','reception.js','invoice.js']){const script=w.document.createElement('script');script.textContent=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8');w.document.body.appendChild(script)}
  const $=id=>w.document.getElementById(id);$('loginEmail').value=member.email;$('loginPassword').value=member.password;await $('loginBtn').onclick();assert.equal($('authGate').classList.contains('hidden'),true,$('authText').textContent);assert.equal($('inventoryArea').hidden,false);assert.equal($('financeArea').hidden,true);assert.equal($('financeNav').hidden,true);assert.equal($('ivIn').hidden,true);assert.equal($('ivOut').hidden,false);
  $('ivAdd').click();assert.equal($('inventoryModal').open,true);const form=$('ivForm');assert.equal(form.elements.packSize.closest('details').open,false);assert.ok(form.elements.sku.value.startsWith('SH-'));assert.equal(form.elements.unitCost,undefined);assert.equal(form.elements.opening,undefined);form.elements.name.value='Test item';form.elements.sku.value='TEST';form.elements.minStock.value='2';await form.onsubmit({target:form,preventDefault(){}});assert.equal($('ivFormError').textContent,'');assert.ok($('ivBody').textContent.includes('Test item'));assert.ok($('ivBody').querySelector('.iv-product'));assert.equal($('ivBody').querySelector('table'),null);assert.ok(!$('ivStats').textContent.includes('ارزش'));
  // Open the owner account and verify member permissions survive edit.
  $('logout').onclick();$('loginEmail').value='owner@example.invalid';$('loginPassword').value='Test-only-secret-123';await $('loginBtn').onclick();w.eval('openMember(members[0])');assert.equal($('memberInventory').checked,true);assert.equal($('memberInventoryPrices').checked,false);assert.equal($('memberInventoryScope').value,'services');$('memberModal').close();$('inventoryModule').click();await w.loadInventory();assert.equal($('inventoryArea').hidden,false);$('ivIn').click();assert.equal(form.elements.payment.value,'none');assert.equal(form.elements.payment.closest('details').open,false);assert.ok($('ivFields').querySelector('.iv-stock-hint'));form.elements.quantity.value='4';form.elements.totalCost.value='100';form.elements.party.value='Supplier';form.elements.payment.value='create';form.elements.paidAmount.value='100';await form.onsubmit({target:form,preventDefault(){}});assert.equal($('ivFormError').textContent,'');
  w.document.querySelector('[data-ivtab="moves"]').click();const editMove=$('ivBody').querySelector('[data-iv-move-edit]');assert.ok(editMove);editMove.click();assert.equal($('inventoryModal').open,true);assert.equal(form.elements.quantity.value,'4');form.elements.party.value='Supplier corrected';await form.onsubmit({target:form,preventDefault(){}});assert.equal($('ivFormError').textContent,'');assert.ok($('ivBody').textContent.includes('Supplier corrected'));
  const trs=await call('/transactions',null,token);assert.equal(trs.data.length,1);const tx=trs.data[0];assert.equal((await call('/transactions/'+tx.id,null,token,'DELETE')).status,409);assert.equal((await call('/transactions/'+tx.id,{amount:100,kind:'expense',desc:'changed',date:new Date().toISOString()},token,'PUT')).status,409);
  // Financial ten-row restriction is independent of other module permissions.
  const combined={...member,financeEntryOnly:true,financeEdit:true,showroomAccess:true,inventoryManage:true,inventoryScope:'both'};
  assert.equal((await call('/members/'+created.data.id,combined,token,'PUT')).status,200);
  await w.eval('loadAll()');w.eval('openMember(members[0])');assert.equal($('memberEntryOnly').checked,true);assert.equal($('memberInventoryManage').checked,true);assert.equal($('memberFinanceEdit').disabled,false);
  $('memberScout').checked=true;$('memberScout').onchange();assert.equal($('memberEntryOnly').checked,true);
  $('memberInventory').checked=true;$('memberInventory').onchange();assert.equal($('memberEntryOnly').checked,true);
  await w.eval('saveMember()');const saved=(await call('/members',null,token)).data[0];assert.equal(saved.financeEntryOnly,true);assert.equal(saved.financeEdit,true);assert.equal(saved.inventoryManage,true);assert.equal(saved.scoutAccess,true);
  $('logout').onclick();$('loginEmail').value=member.email;$('loginPassword').value=member.password;await $('loginBtn').onclick();assert.equal($('entryArea').hidden,false);assert.equal($('modulePicker').hidden,false);assert.equal($('financeArea').hidden,true);
  $('inventoryModule').click();await w.loadInventory();assert.equal($('inventoryArea').hidden,false);$('financeModule').click();assert.equal($('entryArea').hidden,false);
  const limited=(await call('/auth/login',{email:member.email,password:member.password})).data.token,own=[];
  for(let n=0;n<11;n++){const r=await call('/transactions',{kind:'income',amount:n+10,desc:'Own '+n,date:new Date().toISOString()},limited);assert.equal(r.status,201,JSON.stringify(r));own.push(r.data.id)}
  const rec=await call('/transactions/recent',null,limited);assert.equal(rec.data.length,10);assert.ok(!rec.data.some(r=>r.id===own[0]));
  const edit={kind:'income',amount:44,desc:'Edited limited',date:new Date().toISOString()};
  assert.equal((await call('/transactions/'+own[0],edit,limited,'PUT')).status,403);
  assert.equal((await call('/transactions/'+tx.id,edit,limited,'PUT')).status,403);
  assert.equal((await call('/transactions/'+own[10],edit,limited,'PUT')).status,200);
  assert.equal((await call('/transactions/'+own[10],{...edit,date:new Date(Date.now()-60*86400000).toISOString()},limited,'PUT')).status,403);
  assert.equal((await call('/transactions',null,limited)).status,403);assert.equal((await call('/transaction-edits',null,limited)).status,403);
  assert.equal((await call('/transactions/'+own[10],null,limited,'DELETE')).status,403);
  await w.eval('loadAll()');assert.ok($('entryRecent').querySelector('[data-edit]'));assert.equal($('entryRecent').querySelector('[data-delete]'),null);
  $('entryRecent').querySelector('[data-edit]').click();assert.equal($('modal').open,true);$('desc').value='UI recent edit';await w.eval('saveTransaction()');assert.ok($('entryRecent').textContent.includes('UI recent edit'));
  // Managers confirm deletion, can restore it, and cannot delete stocked items.
  $('inventoryModule').click();await w.loadInventory();w.document.querySelector('[data-ivtab="stock"]').click();
  $('ivAdd').click();form.elements.name.value='Disposable item';form.elements.sku.value='UI-DELETE';
  await form.onsubmit({target:form,preventDefault(){}});
  const card=[...$('ivBody').querySelectorAll('.iv-product')].find(e=>e.textContent.includes('Disposable item'));
  card.querySelector('[data-iv-delete]').click();assert.equal($('inventoryModal').open,true);assert.equal($('ivSubmit').disabled,false);
  $('ivCancel').click();assert.ok($('ivBody').textContent.includes('Disposable item'));
  card.querySelector('[data-iv-delete]').click();await form.onsubmit({target:form,preventDefault(){}});
  assert.equal($('ivFormError').textContent,'');assert.ok(!$('ivBody').textContent.includes('Disposable item'));
  w.document.querySelector('[data-ivtab="deleted"]').click();assert.ok($('ivBody').textContent.includes('Disposable item'));
  $('ivBody').querySelector('[data-iv-restore]').click();assert.equal($('ivSubmit').disabled,false);await form.onsubmit({target:form,preventDefault(){}});
  w.document.querySelector('[data-ivtab="stock"]').click();assert.ok($('ivBody').textContent.includes('Disposable item'));
  const stocked=[...$('ivBody').querySelectorAll('.iv-product')].find(e=>e.textContent.includes('Test item'));
  stocked.querySelector('[data-iv-delete]').click();assert.equal($('ivSubmit').disabled,true);assert.match($('ivHelp').textContent,/موجودی/);$('ivCancel').click();
  const logs=await query('SELECT * FROM transaction_edits WHERE transaction_id=$1',[own[10]]);assert.ok(logs.rowCount>=1);
  assert.equal((await call('/members/'+created.data.id,{...combined,financeEdit:false},token,'PUT')).status,200);
  assert.equal((await call('/transactions/'+own[10],edit,limited,'PUT')).status,403);
  // A reception-only member can enter the independent module and use its complete workflow.
  const receptionist={...member,name:'Reception clerk',email:'reception@example.invalid',inventoryAccess:false,inventoryEdit:false,receptionAccess:true,receptionEdit:true};
  const createdReceptionist=await call('/members',receptionist,token);assert.equal(createdReceptionist.status,201);
  $('logout').onclick();$('loginEmail').value='owner@example.invalid';$('loginPassword').value='Test-only-secret-123';await $('loginBtn').onclick();
  w.eval("openMember(members.find(m=>m.email==='reception@example.invalid'))");assert.equal($('memberReception').checked,true);assert.equal($('memberReceptionEdit').checked,true);assert.equal($('memberFinance').checked,false);await w.eval('saveMember()');
  const receptionistLogin=await call('/auth/login',{email:receptionist.email,password:receptionist.password});assert.equal(receptionistLogin.data.user.receptionAccess,true);assert.equal(receptionistLogin.data.user.receptionEdit,true);
  const beforeFinance=await query('SELECT COUNT(*)::int AS n FROM transactions'),beforeMoves=await query('SELECT COUNT(*)::int AS n FROM inventory_moves');
  $('logout').onclick();$('loginEmail').value=receptionist.email;$('loginPassword').value=receptionist.password;await $('loginBtn').onclick();
  assert.equal($('receptionArea').hidden,false);assert.equal($('inventoryArea').hidden,true);assert.equal($('financeArea').hidden,true);assert.equal($('modulePicker').hidden,true);
  $('rcNew').click();assert.equal($('receptionFormModal').open,true);const rf=$('rcForm');
  rf.elements.customerName.value='Test reception customer';rf.elements.phone.value='۰۹۱۲۱۲۳۴۵۶۷';rf.elements.model.value='Test vehicle';rf.elements.plate.value='۱۲ ب ۳۴۵';rf.elements.services.value='Polish body';rf.elements.condition.value='<script>damage note</script>';rf.elements.dueDate.value='۱۴۰۵/۰۸/۱۲';rf.elements.dueTime.value='۱۸:۳۰';
  await rf.onsubmit({preventDefault(){},target:rf});assert.equal($('rcFormError').textContent,'');assert.equal($('receptionDetailModal').open,true);assert.ok($('rcDetail').textContent.includes('Test reception customer'));assert.equal($('rcDetail').querySelector('script'),null);
  assert.ok($('rcDetail').textContent.includes('۱۸:۳۰'));await $('rcAdvance').onclick();assert.ok($('rcDetail').textContent.includes('در حال انجام'));
  $('rcEdit').click();rf.elements.services.value='Corrected services';await rf.onsubmit({preventDefault(){},target:rf});assert.equal($('rcFormError').textContent,'');assert.ok($('rcDetail').textContent.includes('Corrected services'));
  $('rcStatus').value='delivered';await $('rcStatusSave').onclick();assert.equal($('rcEdit'),null);assert.equal($('rcPhotoInput'),null);assert.ok($('rcDetail').textContent.includes('زمان تحویل واقعی'));
  assert.equal((await query('SELECT COUNT(*)::int AS n FROM transactions')).rows[0].n,beforeFinance.rows[0].n);assert.equal((await query('SELECT COUNT(*)::int AS n FROM inventory_moves')).rows[0].n,beforeMoves.rows[0].n);
  const receptionistToken=receptionistLogin.data.token,record=(await call('/reception',null,receptionistToken)).data.items[0];
  assert.equal((await call('/members/'+createdReceptionist.data.id,{...receptionist,receptionEdit:false},token,'PUT')).status,200);
  assert.equal((await call('/reception/'+record.id+'/status',{status:'working',version:record.version},receptionistToken,'PATCH')).status,403);
  assert.equal((await call('/inventory',null,receptionistToken)).status,403);assert.equal((await call('/transactions',null,receptionistToken)).status,403);
  $('logout').onclick();assert.equal($('rcList').textContent,'');assert.equal($('rcDetail').textContent,'');
  // Invoice-only accounts have their own module, full draft/issued editing, and no implicit finance access.
  const invoiceClerk={...member,name:'Invoice clerk',email:'invoice@example.invalid',inventoryAccess:false,inventoryEdit:false,invoiceAccess:true,invoiceEdit:true};
  const invoiceMember=await call('/members',invoiceClerk,token);assert.equal(invoiceMember.status,201);
  $('loginEmail').value=invoiceClerk.email;$('loginPassword').value=invoiceClerk.password;await $('loginBtn').onclick();
  assert.equal($('invoiceArea').hidden,false);assert.equal($('receptionArea').hidden,true);assert.equal($('financeArea').hidden,true);assert.equal($('modulePicker').hidden,true);
  await $('biNew').onclick();assert.equal($('invoiceFormModal').open,true);const bf=$('biForm');bf.elements.customerName.value='Invoice customer';bf.elements.discount.value='100';
  let line=$('biLines').querySelector('.bi-line');line.querySelector('[data-line="title"]').value='<img src=x onerror=bad> Service';line.querySelector('[data-line="unitPrice"]').value='1000';
  await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');assert.equal($('invoiceDetailModal').open,true);assert.equal($('biDetail').querySelector('img'),null);assert.ok($('biDetail').textContent.includes('۹۰۰'));
  await $('biEdit').onclick();$('biLines').querySelector('[data-line="quantity"]').value='2';await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');
  await $('biIssue').onclick();assert.equal($('biIssue'),null);assert.ok($('biEdit'));assert.ok($('biDetail').textContent.includes('نهایی'));
  await $('biEdit').onclick();bf.elements.reason.value='Correct service price';$('biLines').querySelector('[data-line="unitPrice"]').value='1200';assert.equal(bf.elements.draftPaid.readOnly,true);await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');assert.ok($('biDetail').textContent.includes('Correct service price'));
  // Owner: create from a reception, finalize goods/payment, amend goods, then settle the balance.
  $('logout').onclick();$('loginEmail').value='owner@example.invalid';$('loginPassword').value='Test-only-secret-123';await $('loginBtn').onclick();
  w.eval("openMember(members.find(m=>m.email==='invoice@example.invalid'))");assert.equal($('memberInvoice').checked,true);assert.equal($('memberInvoiceEdit').checked,true);assert.equal($('memberFinance').checked,false);await w.eval('saveMember()');
  w.openInvoicesForReception(record);await w.loadInvoices();assert.equal($('invoiceArea').hidden,false);assert.ok($('biSource').textContent.includes(record.customerName));await $('biNew').onclick();assert.equal(bf.elements.customerName.value,record.customerName);
  $('biLines').querySelector('[data-line="unitPrice"]').value='1000';$('biAddRow').click();const goods=[...$('biLines').querySelectorAll('.bi-line')][1];goods.querySelector('[data-line="type"]').value='goods';goods.querySelector('[data-line="type"]').onchange();const stockItem=(await call('/inventory',null,token)).data.items.find(i=>i.sku==='TEST');goods.querySelector('[data-line="itemId"]').value=stockItem.id;goods.querySelector('[data-line="quantity"]').value='2';goods.querySelector('[data-line="unitPrice"]').value='200';bf.elements.draftPaid.value='500';
  await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');assert.equal((await call('/inventory',null,token)).data.items.find(i=>i.id===stockItem.id).quantity,4);
  await $('biIssue').onclick();assert.equal($('biDetailError').textContent,'');assert.equal((await call('/inventory',null,token)).data.items.find(i=>i.id===stockItem.id).quantity,2);
  await $('biEdit').onclick();[...$('biLines').querySelectorAll('.bi-line')][1].querySelector('[data-line="quantity"]').value='1';bf.elements.reason.value='One item returned';await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');assert.equal((await call('/inventory',null,token)).data.items.find(i=>i.id===stockItem.id).quantity,3);
  $('biPayment').click();assert.equal(bf.elements.amount.value,'700');await bf.onsubmit({preventDefault(){},target:bf});assert.equal($('biFormError').textContent,'');assert.equal($('biPayment'),null);
  const linked=(await query('SELECT transaction_id FROM invoice_payments LIMIT 1')).rows[0].transaction_id;
  assert.equal((await call('/transactions/'+linked,{kind:'income',amount:500,desc:'bypass',date:new Date().toISOString()},token,'PUT')).status,409);assert.equal((await call('/transactions/'+linked,null,token,'DELETE')).status,409);
  assert.equal((await call('/members/'+invoiceMember.data.id,{...invoiceClerk,invoiceEdit:false},token,'PUT')).status,200);
  $('logout').onclick();$('loginEmail').value=invoiceClerk.email;$('loginPassword').value=invoiceClerk.password;await $('loginBtn').onclick();assert.equal($('biNew').hidden,true);await $('biList').querySelector('[data-bi-open]').onclick();assert.equal($('biEdit'),null);
  const viewerToken=(await call('/auth/login',{email:invoiceClerk.email,password:invoiceClerk.password})).data.token;assert.equal((await call('/invoices',{requestId:w.crypto.randomUUID()},viewerToken)).status,403);
  $('logout').onclick();assert.equal($('biList').textContent,'');assert.equal($('biDetail').textContent,'');
  assert.deepEqual(errors,[]);
 }finally{dom?.window.close();if(server)await new Promise(r=>server.close(r));await db.close()}
});
