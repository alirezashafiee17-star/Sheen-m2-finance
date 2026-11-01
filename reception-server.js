'use strict';
const crypto=require('crypto');
const statuses=['received','working','ready','delivered'];
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const fail=(status,message)=>Object.assign(new Error(message),{status});
const digits=v=>String(v??'').replace(/[۰-۹]/g,d=>'۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const clean=(v,max)=>String(v??'').trim().slice(0,max);
function fields(b){
 const customerName=clean(b.customerName,120),phone=digits(clean(b.phone,30)).replace(/[\s()-]/g,''),model=clean(b.model,120),plate=digits(clean(b.plate,30)),services=clean(b.services,3000);
 const mileage=b.mileage===''||b.mileage==null?null:Number(digits(b.mileage));
 if(!customerName||!/^\+?\d{8,15}$/.test(phone)||!model||!plate||!services)throw fail(400,'نام مشتری، شماره تماس معتبر، مدل، پلاک و خدمات درخواستی را وارد کنید');
 if(mileage!==null&&(!Number.isSafeInteger(mileage)||mileage<0||mileage>10000000))throw fail(400,'کیلومتر خودرو معتبر نیست');
 let dueAt=null;if(b.dueAt){const d=new Date(b.dueAt);if(Number.isNaN(d.getTime())||d.getUTCFullYear()<2000||d.getUTCFullYear()>2200)throw fail(400,'زمان تحویل معتبر نیست');dueAt=d.toISOString()}
 return {customerName,phone,model,plate,color:clean(b.color,60),mileage,services,condition:clean(b.condition,3000),dueAt};
}
const columns=`id,number,customer_name AS "customerName",phone,model,plate,color,mileage,services,condition,due_at AS "dueAt",status,version,actor_name AS "actorName",created_at AS "createdAt",updated_at AS "updatedAt",delivered_at AS "deliveredAt"`;
async function initReception(q){
 await q(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reception_access BOOLEAN NOT NULL DEFAULT FALSE;
 ALTER TABLE users ADD COLUMN IF NOT EXISTS reception_edit BOOLEAN NOT NULL DEFAULT FALSE;
 CREATE TABLE IF NOT EXISTS reception_records(
 id UUID PRIMARY KEY,number BIGSERIAL UNIQUE NOT NULL,customer_name TEXT NOT NULL,phone TEXT NOT NULL,
 model TEXT NOT NULL,plate TEXT NOT NULL,color TEXT NOT NULL DEFAULT '',mileage INTEGER CHECK(mileage>=0),
 services TEXT NOT NULL,condition TEXT NOT NULL DEFAULT '',due_at TIMESTAMPTZ,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','working','ready','delivered')),
 version INTEGER NOT NULL DEFAULT 1,created_by UUID NOT NULL REFERENCES users(id),actor_name TEXT NOT NULL,
 create_hash TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),delivered_at TIMESTAMPTZ);
 CREATE INDEX IF NOT EXISTS reception_records_status ON reception_records(status,number DESC);
 CREATE TABLE IF NOT EXISTS reception_events(
 id UUID PRIMARY KEY,reception_id UUID NOT NULL REFERENCES reception_records(id),actor_name TEXT NOT NULL,
 action TEXT NOT NULL,from_status TEXT,to_status TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS reception_events_record ON reception_events(reception_id,created_at);
 CREATE TABLE IF NOT EXISTS reception_photos(
 id UUID PRIMARY KEY,reception_id UUID NOT NULL REFERENCES reception_records(id),mime TEXT NOT NULL,
 image BYTEA NOT NULL,sha256 TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
 CREATE INDEX IF NOT EXISTS reception_photos_record ON reception_photos(reception_id);
 CREATE UNIQUE INDEX IF NOT EXISTS reception_photos_content ON reception_photos(reception_id,sha256);`);
}
function installReception(app,{q,pool,auth}){
 const router=require('express').Router();router.use(auth);
 router.use((req,res,next)=>req.user.role==='owner'||req.user.reception_access?next():res.status(403).json({error:'به بخش پذیرش خودرو دسترسی ندارید'}));
 const write=(req,res,next)=>req.user.role==='owner'||req.user.reception_edit?next():res.status(403).json({error:'اجازه ثبت و ویرایش پذیرش ندارید'});
 const wrap=fn=>async(req,res)=>{try{res.set('Cache-Control','private, no-store');await fn(req,res)}catch(e){if(!e.status)console.error('Reception request failed',e.code||e.message);res.status(e.status||500).json({error:e.status?e.message:'اطلاعات پذیرش ذخیره نشد؛ دوباره تلاش کنید'})}};
 async function tx(fn){const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e}finally{c.release()}}
 async function record(c,id,lock=false){if(!uuid(id))throw fail(400,'شماره پذیرش معتبر نیست');const r=await c.query(`SELECT ${columns} FROM reception_records WHERE id=$1${lock?' FOR UPDATE':''}`,[id]);if(!r.rowCount)throw fail(404,'پذیرش پیدا نشد');return r.rows[0]}
 async function event(c,req,id,action,from=null,to=null){await c.query('INSERT INTO reception_events(id,reception_id,actor_name,action,from_status,to_status) VALUES($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),id,req.user.name,action,from,to]);await c.query('INSERT INTO audit_log(id,action,target,data,actor_id) VALUES($1,$2,$3,$4,$5)',[crypto.randomUUID(),'reception_'+action,id,JSON.stringify({from,to}),req.user.sub])}
 router.get('/',wrap(async(req,res)=>{
  const page=Number(req.query.page||0),status=String(req.query.status||''),search=clean(digits(req.query.q),120).replace(/[يى]/g,'ی').replace(/ك/g,'ک');
  if(!Number.isSafeInteger(page)||page<0||page>100000||status&&!statuses.includes(status))throw fail(400,'فیلتر پذیرش معتبر نیست');
  const where=`($1='' OR status=$1) AND ($2='' OR strpos(translate(lower(replace(replace(replace(customer_name||' '||phone||' '||model||' '||plate||' '||number::text,'ي','ی'),'ى','ی'),'ك','ک')),'۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩','01234567890123456789'),lower($2))>0)`;
  const [rows,total,counts]=await Promise.all([q(`SELECT ${columns},(SELECT COUNT(*)::int FROM reception_photos p WHERE p.reception_id=reception_records.id) AS "photoCount" FROM reception_records WHERE ${where} ORDER BY number DESC LIMIT 30 OFFSET $3`,[status,search,page*30]),q(`SELECT COUNT(*)::int AS count FROM reception_records WHERE ${where}`,[status,search]),q('SELECT status,COUNT(*)::int AS count FROM reception_records GROUP BY status')]);
  res.json({items:rows.rows.map(r=>({...r,number:Number(r.number)})),total:total.rows[0].count,page,counts:Object.fromEntries(counts.rows.map(x=>[x.status,x.count]))});
 }));
 router.get('/:id',wrap(async(req,res)=>{
  const r=await record({query:q},req.params.id);
  const [photos,events]=await Promise.all([q('SELECT id,mime FROM reception_photos WHERE reception_id=$1 ORDER BY created_at,id',[r.id]),q('SELECT actor_name AS "actorName",action,from_status AS "fromStatus",to_status AS "toStatus",created_at AS "createdAt" FROM reception_events WHERE reception_id=$1 ORDER BY created_at,id',[r.id])]);
  res.json({...r,number:Number(r.number),photos:photos.rows,events:events.rows});
 }));
 router.post('/',write,wrap(async(req,res)=>{
  const f=fields(req.body),id=req.body.id;if(!uuid(id))throw fail(400,'فرم پذیرش را دوباره باز کنید');
  const hash=crypto.createHash('sha256').update(JSON.stringify(f)).digest('hex');
  const result=await tx(async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[id]);
   const old=await c.query('SELECT id,number,created_by,create_hash FROM reception_records WHERE id=$1',[id]);
   if(old.rowCount){if(old.rows[0].created_by!==req.user.sub||old.rows[0].create_hash!==hash)throw fail(409,'این فرم قبلاً ثبت شده؛ فهرست پذیرش را بروزرسانی کنید');return {id,number:Number(old.rows[0].number),replayed:true}}
   const r=await c.query(`INSERT INTO reception_records(id,customer_name,phone,model,plate,color,mileage,services,condition,due_at,created_by,actor_name,create_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING number`,[id,f.customerName,f.phone,f.model,f.plate,f.color,f.mileage,f.services,f.condition,f.dueAt,req.user.sub,req.user.name,hash]);
   await event(c,req,id,'created',null,'received');return {id,number:Number(r.rows[0].number)};
  });res.status(result.replayed?200:201).json(result);
 }));
 router.put('/:id',write,wrap(async(req,res)=>{
  const f=fields(req.body);
  res.json(await tx(async c=>{const old=await record(c,req.params.id,true);if(req.body.version!==old.version)throw fail(409,'این پذیرش تغییر کرده؛ آن را دوباره باز کنید');
   if(old.status==='delivered')throw fail(409,'برای ویرایش پذیرش تحویل‌شده، ابتدا وضعیت آن را برگردانید');
   await c.query('UPDATE reception_records SET customer_name=$1,phone=$2,model=$3,plate=$4,color=$5,mileage=$6,services=$7,condition=$8,due_at=$9,version=version+1,updated_at=NOW() WHERE id=$10',[f.customerName,f.phone,f.model,f.plate,f.color,f.mileage,f.services,f.condition,f.dueAt,old.id]);
   await event(c,req,old.id,'edited');return {id:old.id,version:old.version+1};
  }));
 }));
 router.patch('/:id/status',write,wrap(async(req,res)=>{
  const status=req.body.status;if(!statuses.includes(status))throw fail(400,'وضعیت پذیرش معتبر نیست');
  res.json(await tx(async c=>{const old=await record(c,req.params.id,true);if(req.body.version!==old.version)throw fail(409,'این پذیرش تغییر کرده؛ آن را دوباره باز کنید');
   if(old.status===status)return {id:old.id,version:old.version};
   await c.query("UPDATE reception_records SET status=$1,version=version+1,updated_at=NOW(),delivered_at=CASE WHEN $1='delivered' THEN NOW() ELSE NULL END WHERE id=$2",[status,old.id]);
   await event(c,req,old.id,'status',old.status,status);return {id:old.id,version:old.version+1};
  }));
 }));
 router.get('/:id/photos/:photo',wrap(async(req,res)=>{
  if(!uuid(req.params.id)||!uuid(req.params.photo))throw fail(400,'شناسه عکس معتبر نیست');
  const r=await q('SELECT mime,image FROM reception_photos WHERE id=$1 AND reception_id=$2',[req.params.photo,req.params.id]);if(!r.rowCount)throw fail(404,'عکس پیدا نشد');res.type(r.rows[0].mime).send(Buffer.from(r.rows[0].image));
 }));
 router.post('/:id/photos',write,wrap(async(req,res)=>{
  const {id,mime,data}=req.body;
  if(!uuid(id)||!['image/jpeg','image/png','image/webp'].includes(mime)||typeof data!=='string'||data.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw fail(400,'عکس JPG، PNG یا WebP تا ۲ مگابایت انتخاب کنید');
  const image=Buffer.from(data,'base64'),sha=crypto.createHash('sha256').update(image).digest('hex');
  const valid=mime==='image/jpeg'?image[0]===255&&image[1]===216&&image[2]===255:mime==='image/png'?image.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):image.toString('ascii',0,4)==='RIFF'&&image.toString('ascii',8,12)==='WEBP';
  if(!valid||image.length>2*1024*1024)throw fail(400,'فایل عکس معتبر نیست یا بیش از ۲ مگابایت است');
  res.status(201).json(await tx(async c=>{
   const r=await record(c,req.params.id,true);if(r.status==='delivered')throw fail(409,'پذیرش تحویل‌شده قابل تغییر نیست');
   const old=await c.query('SELECT reception_id,sha256 FROM reception_photos WHERE id=$1',[id]);
   if(old.rowCount){if(old.rows[0].reception_id!==r.id||old.rows[0].sha256!==sha)throw fail(409,'شناسه عکس تکراری است');return {id,replayed:true}}
   const duplicate=await c.query('SELECT id FROM reception_photos WHERE reception_id=$1 AND sha256=$2',[r.id,sha]);if(duplicate.rowCount)return {id:duplicate.rows[0].id,replayed:true};
   const count=await c.query('SELECT COUNT(*)::int AS n FROM reception_photos WHERE reception_id=$1',[r.id]);if(count.rows[0].n>=5)throw fail(409,'برای هر پذیرش حداکثر ۵ عکس مجاز است');
   await c.query('INSERT INTO reception_photos(id,reception_id,mime,image,sha256) VALUES($1,$2,$3,$4,$5)',[id,r.id,mime,image,sha]);
   await event(c,req,r.id,'photo_added');return {id};
  }));
 }));
 app.use('/api/reception',router);
}
module.exports={initReception,installReception};
