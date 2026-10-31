'use strict';
const crypto=require('crypto');
const SCOPES=['services','gallery'];
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const text=(v,max=250)=>String(v??'').trim().slice(0,max);
const quantity=v=>{const n=Number(v);return v!==''&&v!=null&&Number.isFinite(n)&&n>=0&&n<=1e9&&Math.abs(n*1000-Math.round(n*1000))<0.0001?Math.round(n*1000)/1000:null};
const cash=v=>v!==''&&v!=null&&Number.isSafeInteger(Number(v))&&Number(v)>=0&&Number(v)<=1e15?Number(v):null;
const qty=n=>Math.round(Number(n)*1000)/1000;
const fail=(status,message)=>Object.assign(new Error(message),{status});
const owner=u=>u.role==='owner';
const canAccess=(u,s)=>SCOPES.includes(s)&&(owner(u)||(u.inventory_access&&(u.inventory_scope===s||u.inventory_scope==='both')));
const canManage=u=>owner(u)||!!u.inventory_manage;
const canPrice=u=>canManage(u)||!!u.inventory_prices;
function costOf(item,n){const total=Number(item.quantity),value=Number(item.stock_value);return n===total?value:Math.round(value*n/total)}
async function initInventory(q){
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_access BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_manage BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_edit BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_prices BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS inventory_scope TEXT NOT NULL DEFAULT 'services';
 CREATE TABLE IF NOT EXISTS inventory_items(
 id UUID PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('services','gallery')),
 sku TEXT NOT NULL,name TEXT NOT NULL,category TEXT NOT NULL,unit TEXT NOT NULL,
 purchase_unit TEXT NOT NULL DEFAULT '',pack_size NUMERIC(18,3) NOT NULL DEFAULT 1 CHECK(pack_size>0),
 quantity NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK(quantity>=0),
 loaned NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK(loaned>=0 AND loaned<=quantity),
 stock_value BIGINT NOT NULL DEFAULT 0 CHECK(stock_value>=0),min_stock NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK(min_stock>=0),
 location TEXT NOT NULL DEFAULT '',barcode TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',
 active BOOLEAN NOT NULL DEFAULT TRUE,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(scope,sku));
 CREATE UNIQUE INDEX IF NOT EXISTS inventory_barcode_unique ON inventory_items(scope,barcode) WHERE barcode<>'';
 CREATE TABLE IF NOT EXISTS inventory_vehicles(
 id UUID PRIMARY KEY,scope TEXT NOT NULL CHECK(scope IN ('services','gallery')),title TEXT NOT NULL,
 plate TEXT NOT NULL DEFAULT '',job_number TEXT NOT NULL DEFAULT '',showroom_car_id UUID REFERENCES showroom_cars(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE UNIQUE INDEX IF NOT EXISTS inventory_showroom_vehicle ON inventory_vehicles(showroom_car_id) WHERE showroom_car_id IS NOT NULL;
 CREATE TABLE IF NOT EXISTS inventory_requests(
 id UUID PRIMARY KEY,actor_id UUID NOT NULL REFERENCES users(id),scope TEXT NOT NULL,
 payload_hash TEXT NOT NULL,result JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS inventory_moves(
 id UUID PRIMARY KEY,item_id UUID NOT NULL REFERENCES inventory_items(id),scope TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('opening','in','consume','sale','waste','return','count','transfer_in','transfer_out','loan','loan_return')),
 quantity NUMERIC(18,3) NOT NULL,value_amount BIGINT NOT NULL DEFAULT 0,
 party TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '',invoice TEXT NOT NULL DEFAULT '',
 serial TEXT NOT NULL DEFAULT '',expiry_date DATE,vehicle_id UUID REFERENCES inventory_vehicles(id),
 transaction_id UUID REFERENCES transactions(id),reference_id UUID REFERENCES inventory_moves(id),
 transfer_id UUID,actor_id UUID NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,
 happened_at TIMESTAMPTZ NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE UNIQUE INDEX IF NOT EXISTS inventory_finance_link ON inventory_moves(transaction_id) WHERE transaction_id IS NOT NULL;
 CREATE INDEX IF NOT EXISTS inventory_moves_scope ON inventory_moves(scope,created_at DESC);
 CREATE INDEX IF NOT EXISTS inventory_moves_vehicle ON inventory_moves(vehicle_id);
 CREATE TABLE IF NOT EXISTS inventory_move_edits(
 id UUID PRIMARY KEY,move_id UUID NOT NULL REFERENCES inventory_moves(id),scope TEXT NOT NULL,
 actor_id UUID NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,before_data JSONB NOT NULL,after_data JSONB NOT NULL,
 edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE TABLE IF NOT EXISTS inventory_loans(
 id UUID PRIMARY KEY,item_id UUID NOT NULL REFERENCES inventory_items(id),scope TEXT NOT NULL,
 quantity NUMERIC(18,3) NOT NULL CHECK(quantity>0),person TEXT NOT NULL,due_date DATE,
 created_by UUID NOT NULL REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),returned_at TIMESTAMPTZ,returned_by UUID REFERENCES users(id));`);
}
function installInventory(app,{q,pool,auth,periodOf,currentPeriod}){
 const router=require('express').Router();router.use(auth);
 router.use((req,res,next)=>{req.inventoryScope=String(req.query.scope||req.body?.scope||'services');if(!canAccess(req.user,req.inventoryScope))return res.status(403).json({error:'به این انبار دسترسی ندارید'});next()});
 const write=(req,res,next)=>canManage(req.user)||req.user.inventory_edit?next():res.status(403).json({error:'اجازه ثبت گردش انبار ندارید'});
 const priced=(req,res,next)=>canPrice(req.user)?next():res.status(403).json({error:'مجوز مشاهده و ثبت قیمت خرید لازم است'});
 const onlyOwner=(req,res,next)=>canManage(req.user)?next():res.status(403).json({error:'مجوز مدیریت کامل انبار لازم است'});
 const wrap=fn=>async(req,res)=>{try{await fn(req,res)}catch(e){if(!e.status)console.error('Inventory request failed',e.code||e.message);const status=e.status||(e.code==='23505'?409:e.code==='22P02'?400:500);res.status(status).json({error:e.status?e.message:e.code==='23505'?'کد کالا، بارکد یا سند مالی قبلاً استفاده شده است':status===400?'شناسه یا مقدار معتبر نیست':'ثبت انجام نشد؛ دوباره تلاش کنید'})}};
 function date(v){const d=new Date(v||Date.now());if(Number.isNaN(d.getTime())||d.getTime()>Date.now()+300000)throw fail(400,'تاریخ معتبر نیست یا در آینده است');return d.toISOString()}
 const day=v=>{if(!v)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(new Date(v).getTime())||new Date(v).toISOString().slice(0,10)!==v)throw fail(400,'تاریخ معتبر نیست');return v};
 async function atomic(req,fn){
  const key=req.body.requestId;if(!uuid(key))throw fail(400,'شناسه ثبت معتبر نیست؛ فرم را دوباره باز کنید');
  const hash=crypto.createHash('sha256').update(req.path+'\n'+JSON.stringify(req.body)).digest('hex'),client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
   const old=await client.query('SELECT * FROM inventory_requests WHERE id=$1',[key]);
   if(old.rowCount){const o=old.rows[0];if(o.actor_id!==req.user.sub||o.scope!==req.inventoryScope||o.payload_hash!==hash)throw fail(409,'شناسه ثبت قبلاً برای درخواست دیگری استفاده شده است');await client.query('COMMIT');return {...o.result,replayed:true}}
   const result=await fn(client);await client.query('INSERT INTO inventory_requests(id,actor_id,scope,payload_hash,result) VALUES($1,$2,$3,$4,$5)',[key,req.user.sub,req.inventoryScope,hash,JSON.stringify(result)]);
   await client.query('INSERT INTO audit_log(id,action,target,data,actor_id) VALUES($1,$2,$3,$4,$5)',[crypto.randomUUID(),'inventory_'+req.path,key,JSON.stringify({scope:req.inventoryScope,result}),req.user.sub]);
   await client.query('COMMIT');return result;
  }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e}finally{client.release()}
 }
 async function item(c,id,scope){if(!uuid(id))throw fail(400,'کالا را انتخاب کنید');const r=await c.query('SELECT * FROM inventory_items WHERE id=$1 AND scope=$2 AND active=true FOR UPDATE',[id,scope]);if(!r.rowCount)throw fail(404,'کالا در این انبار پیدا نشد');return r.rows[0]}
 async function move(c,req,i,m){const id=crypto.randomUUID();await c.query(`INSERT INTO inventory_moves(id,item_id,scope,type,quantity,value_amount,party,reason,invoice,serial,expiry_date,vehicle_id,transaction_id,reference_id,transfer_id,actor_id,actor_name,happened_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[id,i.id,i.scope,m.type,m.quantity,m.value||0,text(m.party,120),text(m.reason,500),text(m.invoice,100),text(m.serial,100),day(m.expiryDate),m.vehicleId||null,m.transactionId||null,m.referenceId||null,m.transferId||null,req.user.sub,req.user.name,m.date||date(req.body.date)]);return id}
 const numericItem=(i,prices)=>{const {stock_value,...safe}=i;return {...safe,quantity:Number(i.quantity),loaned:Number(i.loaned),min_stock:Number(i.min_stock),pack_size:Number(i.pack_size),...(prices?{stockValue:Number(stock_value),averageCost:Number(i.quantity)?Number(stock_value)/Number(i.quantity):0}:{})}};
 const numericMove=(m,prices)=>{const {value_amount,transaction_id,...safe}=m;return {...safe,quantity:Number(m.quantity),...(prices?{valueAmount:Number(value_amount),transactionId:transaction_id}:{})}};
 router.get('/',wrap(async(req,res)=>{
  const scope=req.inventoryScope,prices=canPrice(req.user);
  const [items,moves,vehicles,loans]=await Promise.all([
   q('SELECT * FROM inventory_items WHERE scope=$1 ORDER BY active DESC,name',[scope]),
   q(`SELECT m.*,i.name AS item_name,i.unit,v.title AS vehicle_title FROM inventory_moves m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN inventory_vehicles v ON v.id=m.vehicle_id WHERE m.scope=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100`,[scope]),
   q(`SELECT v.*,COALESCE((SELECT SUM(value_amount) FROM inventory_moves m WHERE m.vehicle_id=v.id AND m.type IN ('consume','return')),0)::text AS cost FROM inventory_vehicles v WHERE v.scope=$1 ORDER BY v.created_at DESC`,[scope]),
   q(`SELECT l.*,i.name AS item_name,i.unit FROM inventory_loans l JOIN inventory_items i ON i.id=l.item_id WHERE l.scope=$1 ORDER BY (l.returned_at IS NULL) DESC,l.created_at DESC LIMIT 200`,[scope])]);
  res.json({scope,prices,items:items.rows.map(i=>numericItem(i,prices)),moves:moves.rows.map(m=>numericMove(m,prices)),vehicles:vehicles.rows.map(v=>{const {cost,...s}=v;return {...s,...(prices?{cost:Number(cost)}:{})}}),loans:loans.rows.map(l=>({...l,quantity:Number(l.quantity)}))});
 }));
 router.get('/movements',wrap(async(req,res)=>{const page=Number(req.query.page||0);if(!Number.isSafeInteger(page)||page<0||page>100000)throw fail(400,'صفحه نامعتبر است');const r=await q(`SELECT m.*,i.name AS item_name,i.unit,v.title AS vehicle_title FROM inventory_moves m JOIN inventory_items i ON i.id=m.item_id LEFT JOIN inventory_vehicles v ON v.id=m.vehicle_id WHERE m.scope=$1 ORDER BY m.created_at DESC,m.id DESC LIMIT 100 OFFSET $2`,[req.inventoryScope,page*100]);res.json(r.rows.map(m=>numericMove(m,canPrice(req.user))))}));
 router.get('/vehicles/:id/movements',wrap(async(req,res)=>{if(!uuid(req.params.id))throw fail(400,'شناسه خودرو نامعتبر است');const r=await q(`SELECT m.*,i.name AS item_name,i.unit FROM inventory_moves m JOIN inventory_items i ON i.id=m.item_id WHERE m.scope=$1 AND m.vehicle_id=$2 ORDER BY m.created_at DESC`,[req.inventoryScope,req.params.id]);res.json(r.rows.map(m=>numericMove(m,canPrice(req.user))))}));
 router.get('/gallery-cars',wrap(async(req,res)=>{if(req.inventoryScope!=='gallery')throw fail(403,'خودروهای گالری در این انبار قابل مشاهده نیستند');res.json((await q("SELECT id,title,year FROM showroom_cars ORDER BY created_at DESC")).rows)}));
 router.post('/items',write,wrap(async(req,res)=>{
  const b=req.body,n=text(b.name,150),sku=text(b.sku,80),unit=text(b.unit,30),category=text(b.category,40),pack=quantity(b.packSize),minimum=quantity(b.minStock),opening=quantity(b.opening??0),price=cash(b.unitCost??0);
  if(!n||!sku||!unit||!['مواد مصرفی','قطعات خودرو','ابزار و تجهیزات','سایر'].includes(category)||pack===null||pack<=0||minimum===null||opening===null||price===null||!Number.isSafeInteger(Math.round(opening*price)))throw fail(400,'نام، کد، واحد، ضریب تبدیل و مقدار معتبر لازم است');if(opening>0&&!canPrice(req.user))throw fail(403,'موجودی اولیه با قیمت باید توسط مدیر یا مسئول مجاز ثبت شود');
  const result=await atomic(req,async c=>{const id=crypto.randomUUID();await c.query(`INSERT INTO inventory_items(id,scope,sku,name,category,unit,purchase_unit,pack_size,min_stock,location,barcode,notes,quantity,stock_value) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[id,req.inventoryScope,sku,n,category,unit,text(b.purchaseUnit,30)||unit,pack,minimum,text(b.location,100),text(b.barcode,100),text(b.notes,1000),opening,Math.round(opening*price)]);if(opening>0)await move(c,req,{id,scope:req.inventoryScope},{type:'opening',quantity:opening,value:Math.round(opening*price),reason:'موجودی اولیه'});return {id}});res.status(201).json(result);
 }));
 router.put('/items/:id',write,wrap(async(req,res)=>{const b=req.body,minimum=quantity(b.minStock);if(!text(b.name,150)||minimum===null)throw fail(400,'نام کالا و حداقل موجودی معتبر لازم است');res.json(await atomic(req,async c=>{const i=await item(c,req.params.id,req.inventoryScope);await c.query('UPDATE inventory_items SET name=$1,min_stock=$2,location=$3,barcode=$4,notes=$5,updated_at=NOW() WHERE id=$6',[text(b.name,150),minimum,text(b.location,100),text(b.barcode,100),text(b.notes,1000),i.id]);return {id:i.id}}))}));
 router.post('/vehicles',write,wrap(async(req,res)=>{const b=req.body;if(!text(b.title,150)&&!uuid(b.showroomCarId))throw fail(400,'عنوان خودرو را وارد کنید');res.status(201).json(await atomic(req,async c=>{let title=text(b.title,150),car=null;if(b.showroomCarId){if(req.inventoryScope!=='gallery'||!uuid(b.showroomCarId))throw fail(400,'ارتباط خودرو معتبر نیست');const r=await c.query('SELECT id,title,year FROM showroom_cars WHERE id=$1',[b.showroomCarId]);if(!r.rowCount)throw fail(404,'خودرو پیدا نشد');car=r.rows[0].id;title=r.rows[0].title+' '+r.rows[0].year}const id=crypto.randomUUID();await c.query('INSERT INTO inventory_vehicles(id,scope,title,plate,job_number,showroom_car_id) VALUES($1,$2,$3,$4,$5,$6)',[id,req.inventoryScope,title,text(b.plate,40),text(b.jobNumber,80),car]);return {id}}))}));
 router.post('/movements',write,wrap(async(req,res)=>{
  const b=req.body;if(!['in','consume','sale','waste'].includes(b.type))throw fail(400,'نوع گردش معتبر نیست');const n=quantity(b.quantity);if(n===null||n<=0||!text(b.party,120))throw fail(400,'مقدار و تحویل‌گیرنده یا تأمین‌کننده لازم است');if(b.type==='in'&&!canPrice(req.user))throw fail(403,'ورود خرید با قیمت به مجوز قیمت‌ها نیاز دارد');
  res.status(201).json(await atomic(req,async c=>{const i=await item(c,b.itemId,req.inventoryScope);let amount=b.purchaseUnits?qty(n*Number(i.pack_size)):n;if(!Number.isFinite(amount)||amount<=0||amount>1e9)throw fail(400,'مقدار تبدیل‌شده معتبر نیست');let value=0,transactionId=null;const happened=date(b.date);
   if(b.vehicleId){if(!uuid(b.vehicleId))throw fail(400,'خودرو معتبر نیست');const v=await c.query('SELECT id FROM inventory_vehicles WHERE id=$1 AND scope=$2',[b.vehicleId,req.inventoryScope]);if(!v.rowCount)throw fail(400,'خودرو در این انبار تعریف نشده است')}
   if(b.type==='consume'&&!b.vehicleId&&!text(b.reason,500))throw fail(400,'خودرو یا دلیل مصرف عمومی را مشخص کنید');
   if(b.type==='in'){value=cash(b.totalCost);if(value===null)throw fail(400,'مبلغ کل فاکتور معتبر نیست');if(qty(Number(i.quantity)+amount)>1e9||!Number.isSafeInteger(Number(i.stock_value)+value))throw fail(400,'موجودی یا ارزش از حد مجاز بیشتر است');
    if(b.payment&&b.payment!=='none'){
     if(req.inventoryScope!=='services'||!(owner(req.user)||(req.user.finance_access&&req.user.finance_edit&&!req.user.finance_entry_only)))throw fail(403,'ثبت یا اتصال پرداخت فقط با مجوز ویرایش مالی خدمات مجاز است');
     const paid=cash(b.paidAmount);if(paid===null||paid<=0||paid>value)throw fail(400,'مبلغ پرداخت باید مثبت و حداکثر مبلغ خرید باشد');
     if(b.payment==='existing'){if(!uuid(b.transactionId))throw fail(400,'سند مالی را انتخاب کنید');const tr=await c.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE",[b.transactionId]);const t=tr.rows[0];if(!t||t.deleted_at||t.kind!=='expense'||Number(t.amount)!==paid)throw fail(400,'سند باید هزینه فعال با مبلغ برابر پرداخت باشد');transactionId=t.id}
     else if(b.payment==='create'){const period=periodOf(happened);const pr=await c.query('SELECT closed FROM periods WHERE period=$1',[period]);if(!owner(req.user)&&(period!==currentPeriod()||pr.rows[0]?.closed))throw fail(403,'ماه مالی بسته است');transactionId=crypto.randomUUID();await c.query("INSERT INTO transactions(id,kind,amount,description,happened_at,period,actor_id,actor_name,actor_email) VALUES($1,'expense',$2,$3,$4,$5,$6,$7,$8)",[transactionId,paid,'خرید انبار: '+i.name+(b.invoice?' / فاکتور '+text(b.invoice,100):''),happened,period,req.user.sub,req.user.name,req.user.email])}
     else throw fail(400,'روش پرداخت معتبر نیست');
    }
    await c.query('UPDATE inventory_items SET quantity=quantity+$1,stock_value=stock_value+$2,updated_at=NOW() WHERE id=$3',[amount,value,i.id]);
   }else{if(amount>qty(Number(i.quantity)-Number(i.loaned)))throw fail(409,'مقدار خروج از موجودی آزاد بیشتر است');if(i.category==='ابزار و تجهیزات'&&b.type==='consume')throw fail(400,'ابزار را از بخش امانت تحویل دهید؛ برای خروج قطعی علت فروش یا ضایعات را انتخاب کنید');value=costOf(i,amount);await c.query('UPDATE inventory_items SET quantity=quantity-$1,stock_value=stock_value-$2,updated_at=NOW() WHERE id=$3',[amount,value,i.id])}
   const id=await move(c,req,i,{type:b.type,quantity:amount,value,party:b.party,reason:b.reason,invoice:b.invoice,serial:b.serial,expiryDate:b.expiryDate,vehicleId:b.type==='consume'?b.vehicleId:null,transactionId,date:happened});return {id,...(canPrice(req.user)?{transactionId}:{})};
  }));
 }));
 router.put('/movements/:id',write,wrap(async(req,res)=>{
  const b=req.body;if(!uuid(req.params.id)||!text(b.party,120))throw fail(400,'گردش و طرف حساب معتبر لازم است');
  res.json(await atomic(req,async c=>{
   const initial=await c.query('SELECT * FROM inventory_moves WHERE id=$1 AND scope=$2',[req.params.id,req.inventoryScope]);
   if(!initial.rowCount)throw fail(404,'گردش انبار پیدا نشد');
   const original=initial.rows[0],i=await item(c,original.item_id,req.inventoryScope);
   const locked=await c.query('SELECT * FROM inventory_moves WHERE id=$1 FOR UPDATE',[original.id]),m=locked.rows[0];
   if(!['in','consume','sale','waste'].includes(m.type))throw fail(400,'این نوع گردش از فرم اختصاصی خودش اصلاح می‌شود');
   if(m.type==='in'&&!canPrice(req.user))throw fail(403,'ویرایش خرید به مجوز قیمت‌ها نیاز دارد');
   const amount=quantity(b.quantity),valueIn=m.type==='in'?cash(b.totalCost):null;
   if(amount===null||amount<=0||m.type==='in'&&valueIn===null)throw fail(400,'مقدار و مبلغ معتبر وارد کنید');
   let vehicleId=m.type==='consume'?(b.vehicleId||null):null;
   if(vehicleId){if(!uuid(vehicleId))throw fail(400,'خودرو معتبر نیست');const v=await c.query('SELECT id FROM inventory_vehicles WHERE id=$1 AND scope=$2',[vehicleId,req.inventoryScope]);if(!v.rowCount)throw fail(400,'خودرو در این انبار تعریف نشده است')}
   if(m.type==='consume'&&!vehicleId&&!text(b.reason,500))throw fail(400,'خودرو یا دلیل مصرف عمومی لازم است');
   const changesStock=amount!==Number(m.quantity)||m.type==='in'&&valueIn!==Number(m.value_amount);
   let value=Number(m.value_amount);
   if(changesStock){
    const last=await c.query("SELECT id FROM inventory_moves WHERE item_id=$1 AND type NOT IN ('loan','loan_return') ORDER BY created_at DESC,id DESC LIMIT 1",[i.id]);
    if(last.rows[0]?.id!==m.id)throw fail(409,'برای این کالا گردش بعدی ثبت شده است؛ مقدار یا قیمت را با شمارش اصلاحی یا برگشت مصرف اصلاح کنید');
    const incoming=m.type==='in',restoredQty=qty(Number(i.quantity)+(incoming?-1:1)*Number(m.quantity)),restoredValue=Number(i.stock_value)+(incoming?-1:1)*Number(m.value_amount);
    value=incoming?valueIn:costOf({quantity:restoredQty,stock_value:restoredValue},amount);
    const newQty=qty(restoredQty+(incoming?1:-1)*amount),newValue=restoredValue+(incoming?1:-1)*value;
    if(newQty<Number(i.loaned)||newQty>1e9||newValue<0||!Number.isSafeInteger(newValue))throw fail(409,'اصلاح باعث موجودی منفی یا مقدار نامعتبر می‌شود');
    if(m.transaction_id){const payment=await c.query('SELECT amount FROM transactions WHERE id=$1 AND deleted_at IS NULL',[m.transaction_id]);if(!payment.rowCount||value<Number(payment.rows[0].amount))throw fail(409,'مبلغ خرید نمی‌تواند از پرداخت مالی متصل کمتر باشد')}
    await c.query('UPDATE inventory_items SET quantity=$1,stock_value=$2,updated_at=NOW() WHERE id=$3',[newQty,newValue,i.id]);
   }
   // A returned consumption cannot be reassigned to another vehicle.
   if(vehicleId!==m.vehicle_id){const r=await c.query("SELECT id FROM inventory_moves WHERE reference_id=$1 AND type='return'",[m.id]);if(r.rowCount)throw fail(409,'برای این مصرف برگشت ثبت شده؛ ارتباط خودرو قابل تغییر نیست')}
   const happened=date(b.date);
   await c.query('UPDATE inventory_moves SET quantity=$1,value_amount=$2,party=$3,reason=$4,invoice=$5,vehicle_id=$6,happened_at=$7 WHERE id=$8',[amount,value,text(b.party,120),text(b.reason,500),m.type==='in'?text(b.invoice,100):m.invoice,vehicleId,happened,m.id]);
   const after={...m,quantity:amount,value_amount:value,party:text(b.party,120),reason:text(b.reason,500),invoice:m.type==='in'?text(b.invoice,100):m.invoice,vehicle_id:vehicleId,happened_at:happened};
   await c.query('INSERT INTO inventory_move_edits(id,move_id,scope,actor_id,actor_name,before_data,after_data) VALUES($1,$2,$3,$4,$5,$6,$7)',[crypto.randomUUID(),m.id,req.inventoryScope,req.user.sub,req.user.name,JSON.stringify(m),JSON.stringify(after)]);
   return {id:m.id};
  }));
 }));
 router.get('/movements/:id/history',wrap(async(req,res)=>{
  if(!uuid(req.params.id))throw fail(400,'شناسه معتبر نیست');
  const r=await q('SELECT actor_name,edited_at,before_data,after_data FROM inventory_move_edits WHERE move_id=$1 AND scope=$2 ORDER BY edited_at DESC',[req.params.id,req.inventoryScope]);
  const redact=data=>{const {value_amount,transaction_id,...safe}=data;return {...safe,...(canPrice(req.user)?{value_amount,transaction_id}:{})}};
  res.json(r.rows.map(h=>({...h,before_data:redact(h.before_data),after_data:redact(h.after_data)})));
 }));
 router.get('/finance-expenses',priced,wrap(async(req,res)=>{if(req.inventoryScope!=='services'||!(owner(req.user)||(req.user.finance_access&&req.user.finance_edit&&!req.user.finance_entry_only)))throw fail(403,'دسترسی به اسناد مالی ندارید');const r=await q("SELECT t.id,t.description,t.amount::text,t.happened_at FROM transactions t WHERE kind='expense' AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM inventory_moves m WHERE m.transaction_id=t.id) ORDER BY t.happened_at DESC LIMIT 200");res.json(r.rows.map(t=>({...t,amount:Number(t.amount)})))}));
 router.post('/returns',write,wrap(async(req,res)=>{const b=req.body,n=quantity(b.quantity);if(!uuid(b.referenceId)||n===null||n<=0||!text(b.reason,500))throw fail(400,'سند مصرف، مقدار و دلیل برگشت لازم است');res.status(201).json(await atomic(req,async c=>{const prior=await c.query("SELECT * FROM inventory_moves WHERE id=$1 AND scope=$2 AND type='consume'",[b.referenceId,req.inventoryScope]);if(!prior.rowCount)throw fail(404,'سند مصرف پیدا نشد');const m=prior.rows[0],i=await item(c,m.item_id,req.inventoryScope);await c.query('SELECT id FROM inventory_moves WHERE id=$1 FOR UPDATE',[m.id]);const r=await c.query("SELECT COALESCE(SUM(quantity),0) AS quantity,COALESCE(SUM(value_amount),0) AS value FROM inventory_moves WHERE reference_id=$1 AND type='return'",[m.id]);const remaining=qty(Number(m.quantity)-Number(r.rows[0].quantity));if(n>remaining)throw fail(409,'بیش از مقدار مصرف‌شده قابل برگشت نیست');const value=n===remaining?Number(m.value_amount)+Number(r.rows[0].value):Math.round(Number(m.value_amount)*n/Number(m.quantity));await c.query('UPDATE inventory_items SET quantity=quantity+$1,stock_value=stock_value+$2,updated_at=NOW() WHERE id=$3',[n,value,i.id]);return {id:await move(c,req,i,{type:'return',quantity:n,value:-value,vehicleId:m.vehicle_id,referenceId:m.id,reason:b.reason,party:b.party})}}))}));
 router.post('/counts',write,onlyOwner,wrap(async(req,res)=>{const b=req.body,n=quantity(b.actual);if(n===null||!text(b.reason,500))throw fail(400,'شمارش واقعی و دلیل اختلاف لازم است');res.status(201).json(await atomic(req,async c=>{const i=await item(c,b.itemId,req.inventoryScope);if(n<Number(i.loaned))throw fail(409,'شمارش کل نمی‌تواند از تعداد ابزار نزد همکاران کمتر باشد');const delta=qty(n-Number(i.quantity));if(!delta)throw fail(400,'شمارش با موجودی برابر است');const price=cash(b.unitCost);let value=delta<0?-costOf(i,-delta):price===null?NaN:Math.round(delta*price);if(!Number.isSafeInteger(value))throw fail(400,'قیمت هر واحد افزایش موجودی لازم است');await c.query('UPDATE inventory_items SET quantity=$1,stock_value=stock_value+$2,updated_at=NOW() WHERE id=$3',[n,value,i.id]);return {id:await move(c,req,i,{type:'count',quantity:delta,value,reason:b.reason})}}))}));
 router.post('/loans',write,wrap(async(req,res)=>{const b=req.body,n=quantity(b.quantity);if(n===null||n<=0||!text(b.person,120))throw fail(400,'نام تحویل‌گیرنده و مقدار لازم است');res.status(201).json(await atomic(req,async c=>{const i=await item(c,b.itemId,req.inventoryScope);if(i.category!=='ابزار و تجهیزات')throw fail(400,'امانت برای ابزار و تجهیزات است');if(n>qty(Number(i.quantity)-Number(i.loaned)))throw fail(409,'ابزار آزاد کافی نیست');const id=crypto.randomUUID();await c.query('INSERT INTO inventory_loans(id,item_id,scope,quantity,person,due_date,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,i.id,req.inventoryScope,n,text(b.person,120),day(b.dueDate),req.user.sub]);await c.query('UPDATE inventory_items SET loaned=loaned+$1,updated_at=NOW() WHERE id=$2',[n,i.id]);await move(c,req,i,{type:'loan',quantity:n,party:b.person,reason:'تحویل ابزار امانی'});return {id}}))}));
 router.post('/loans/:id/return',write,wrap(async(req,res)=>{if(!uuid(req.params.id))throw fail(400,'امانت معتبر نیست');res.json(await atomic(req,async c=>{const r=await c.query('SELECT * FROM inventory_loans WHERE id=$1 AND scope=$2',[req.params.id,req.inventoryScope]);if(!r.rowCount)throw fail(404,'امانت پیدا نشد');const l=r.rows[0],i=await item(c,l.item_id,req.inventoryScope);const locked=await c.query('SELECT returned_at FROM inventory_loans WHERE id=$1 FOR UPDATE',[l.id]);if(locked.rows[0].returned_at)throw fail(409,'ابزار قبلاً برگشته است');await c.query('UPDATE inventory_loans SET returned_at=NOW(),returned_by=$1 WHERE id=$2',[req.user.sub,l.id]);await c.query('UPDATE inventory_items SET loaned=loaned-$1,updated_at=NOW() WHERE id=$2',[l.quantity,i.id]);await move(c,req,i,{type:'loan_return',quantity:Number(l.quantity),party:l.person,reason:'بازگشت ابزار امانی'});return {id:l.id}}))}));
 router.post('/transfers',write,onlyOwner,wrap(async(req,res)=>{const b=req.body,n=quantity(b.quantity),dest=b.destination;if(!canAccess(req.user,dest)||dest===req.inventoryScope||n===null||n<=0||!text(b.reason,500))throw fail(400,'انبار مقصد، مقدار و دلیل معتبر لازم است');res.status(201).json(await atomic(req,async c=>{await c.query('SELECT pg_advisory_xact_lock(7832315)');const i=await item(c,b.itemId,req.inventoryScope);if(n>qty(Number(i.quantity)-Number(i.loaned)))throw fail(409,'موجودی آزاد کافی نیست');const target=await c.query('SELECT * FROM inventory_items WHERE scope=$1 AND sku=$2 FOR UPDATE',[dest,i.sku]);let t=target.rows[0];if(t&&(t.unit!==i.unit||t.category!==i.category||!t.active))throw fail(409,'کد کالا در مقصد با واحد یا دسته متفاوت تعریف شده است');if(!t){t={...i,id:crypto.randomUUID(),scope:dest};await c.query('INSERT INTO inventory_items(id,scope,sku,name,category,unit,purchase_unit,pack_size,min_stock,location) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[t.id,dest,i.sku,i.name,i.category,i.unit,i.purchase_unit,i.pack_size,i.min_stock,i.location])}const value=costOf(i,n),transferId=crypto.randomUUID();await c.query('UPDATE inventory_items SET quantity=quantity-$1,stock_value=stock_value-$2,updated_at=NOW() WHERE id=$3',[n,value,i.id]);await c.query('UPDATE inventory_items SET quantity=quantity+$1,stock_value=stock_value+$2,updated_at=NOW() WHERE id=$3',[n,value,t.id]);await move(c,req,i,{type:'transfer_out',quantity:n,value,reason:b.reason,transferId});await move(c,req,t,{type:'transfer_in',quantity:n,value,reason:b.reason,transferId});return {id:transferId}}))}));
 app.use('/api/inventory',router);
}
module.exports={initInventory,installInventory,quantity,cash,costOf,canAccess,canPrice,canManage};
