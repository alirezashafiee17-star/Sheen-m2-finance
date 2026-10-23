const express=require("express");
const path=require("path");
const crypto=require("crypto");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");
const helmet=require("helmet");
const compression=require("compression");
const rateLimit=require("express-rate-limit");
const {generateRegistrationOptions,verifyRegistrationResponse,generateAuthenticationOptions,verifyAuthenticationResponse}=require("@simplewebauthn/server");

const app=express();
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(compression());
app.use(express.json({limit:"4mb"}));
app.use("/api/auth",rateLimit({windowMs:15*60*1000,max:60,standardHeaders:true,legacyHeaders:false}));

const PORT=Number(process.env.PORT||3000);
const DATABASE_URL=process.env.DATABASE_URL;
const JWT_SECRET=process.env.JWT_SECRET;
const OWNER_EMAIL=(process.env.OWNER_EMAIL||"").trim().toLowerCase();
const OWNER_PASSWORD=process.env.OWNER_PASSWORD||"";
if(!DATABASE_URL||!JWT_SECRET||!OWNER_EMAIL||!OWNER_PASSWORD){
 console.error("Missing DATABASE_URL, JWT_SECRET, OWNER_EMAIL or OWNER_PASSWORD");
 process.exit(1);
}
const pool=new Pool({connectionString:DATABASE_URL,ssl:process.env.DB_SSL==="true"?{rejectUnauthorized:false}:false});
const q=(text,params=[])=>pool.query(text,params);
let dbReady=false;
let dbErrorCode="STARTING";
const passkeyChallenges=new Map();
const RP_ID=process.env.PASSKEY_RP_ID||"www.sheenfinance.ir";
const ORIGIN=process.env.PASSKEY_ORIGIN||"https://www.sheenfinance.ir";
const passkeyUserID=id=>new Uint8Array(Buffer.from(id.replace(/-/g,""),"hex"));
const cleanEmail=v=>String(v||"").trim().toLowerCase();
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role,displayTitle:u.role==="owner"?"مالک":u.display_title,financeEdit:u.role==="owner"||(u.finance_access&&u.finance_edit),financeAccess:u.role==="owner"||u.finance_access,showroomAccess:u.role==="owner"||u.showroom_access,showroomEdit:u.role==="owner"||u.showroom_edit,scoutAccess:u.role==="owner"||u.scout_access});
function sign(u){return jwt.sign({sub:u.id,email:u.email,role:u.role},JWT_SECRET,{expiresIn:"30d"})}
async function init(){
 await q(`CREATE TABLE IF NOT EXISTS users(
  id UUID PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','admin','viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS transactions(
  id UUID PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('income','expense','withdrawal')),
  amount BIGINT NOT NULL CHECK(amount>0), description TEXT NOT NULL,
  happened_at TIMESTAMPTZ NOT NULL, period TEXT NOT NULL,
  actor_id UUID REFERENCES users(id), actor_name TEXT, actor_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS periods(
  period TEXT PRIMARY KEY, closed BOOLEAN NOT NULL DEFAULT TRUE,
  closed_at TIMESTAMPTZ, closed_by UUID REFERENCES users(id)
 ); CREATE TABLE IF NOT EXISTS audit_log(
  id UUID PRIMARY KEY, action TEXT NOT NULL, target TEXT, data JSONB NOT NULL DEFAULT '{}',
  actor_id UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS transaction_edits(
  id UUID PRIMARY KEY, transaction_id UUID NOT NULL REFERENCES transactions(id),
  actor_id UUID REFERENCES users(id), actor_name TEXT NOT NULL,
  before_amount BIGINT NOT NULL, after_amount BIGINT NOT NULL,
  before_kind TEXT NOT NULL, after_kind TEXT NOT NULL,
  before_description TEXT NOT NULL, after_description TEXT NOT NULL,
  before_happened_at TIMESTAMPTZ NOT NULL, after_happened_at TIMESTAMPTZ NOT NULL,
  edited_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS passkeys(
  id TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id), public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0, transports TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );`);
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_access BOOLEAN NOT NULL DEFAULT TRUE");
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS finance_edit BOOLEAN NOT NULL DEFAULT FALSE");
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_title TEXT NOT NULL DEFAULT 'عضو'");
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS showroom_access BOOLEAN NOT NULL DEFAULT FALSE");
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS showroom_edit BOOLEAN NOT NULL DEFAULT FALSE");
 await q("ALTER TABLE users ADD COLUMN IF NOT EXISTS scout_access BOOLEAN NOT NULL DEFAULT FALSE");
 await q(`CREATE TABLE IF NOT EXISTS showroom_cars(
  id UUID PRIMARY KEY, title TEXT NOT NULL, year TEXT NOT NULL DEFAULT '',
  mileage BIGINT NOT NULL DEFAULT 0 CHECK(mileage>=0), paint TEXT NOT NULL DEFAULT '',
  ownership TEXT NOT NULL CHECK(ownership IN ('owned','consignment')),
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','reserved','inspection','sold','settled')),
  asking_price BIGINT NOT NULL DEFAULT 0 CHECK(asking_price>=0),
  owner_name TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS showroom_leads(
  id UUID PRIMARY KEY, car_id UUID REFERENCES showroom_cars(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'followup' CHECK(status IN ('followup','visit','negotiation','won','lost')),
  next_followup TIMESTAMPTZ, notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS showroom_deals(
  id UUID PRIMARY KEY, car_id UUID NOT NULL REFERENCES showroom_cars(id),
  sale_amount BIGINT NOT NULL CHECK(sale_amount>=0),
  acquisition_amount BIGINT NOT NULL CHECK(acquisition_amount>=0),
  expense_amount BIGINT NOT NULL DEFAULT 0 CHECK(expense_amount>=0),
  commission_amount BIGINT NOT NULL DEFAULT 0 CHECK(commission_amount>=0),
  notes TEXT NOT NULL DEFAULT '', happened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS showroom_photos(
  id UUID PRIMARY KEY, car_id UUID NOT NULL REFERENCES showroom_cars(id) ON DELETE CASCADE,
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp')),
  image BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 ); CREATE TABLE IF NOT EXISTS showroom_withdrawals(
  id UUID PRIMARY KEY, amount BIGINT NOT NULL CHECK(amount>0), description TEXT NOT NULL,
  happened_at TIMESTAMPTZ NOT NULL, actor_id UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 );`);
 await q(`CREATE TABLE IF NOT EXISTS showroom_agencies(
  id UUID PRIMARY KEY, car_id UUID NOT NULL REFERENCES showroom_cars(id),
  version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'draft'
   CHECK(status IN ('draft','expired','superseded','signed','owner_submitted','approved','revision_requested')),
  owner_name TEXT NOT NULL, owner_national_id TEXT NOT NULL, owner_phone TEXT NOT NULL,
  car_snapshot JSONB NOT NULL, net_price BIGINT NOT NULL CHECK(net_price>=0),
  commission TEXT NOT NULL DEFAULT '', settlement TEXT NOT NULL DEFAULT '',
  authority TEXT NOT NULL DEFAULT '', terms TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE, expires_at TIMESTAMPTZ NOT NULL,
  created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  signed_at TIMESTAMPTZ, provider_reference TEXT
 ); CREATE INDEX IF NOT EXISTS showroom_agencies_car_idx ON showroom_agencies(car_id,created_at DESC);`);
 await q(`CREATE TABLE IF NOT EXISTS showroom_agency_documents(
  id UUID PRIMARY KEY, agency_id UUID NOT NULL REFERENCES showroom_agencies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('vehicle','national_front','national_back','power_of_attorney')),
  mime TEXT NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp','application/pdf')),
  content BYTEA NOT NULL, sha256 TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','approved','revision_requested')),
  review_note TEXT NOT NULL DEFAULT '', reviewed_by UUID REFERENCES users(id), reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(agency_id,kind)
 ); CREATE INDEX IF NOT EXISTS showroom_agency_documents_agency_idx ON showroom_agency_documents(agency_id);`);
 await q("ALTER TABLE showroom_agencies DROP CONSTRAINT IF EXISTS showroom_agencies_status_check");
 await q("ALTER TABLE showroom_agencies ADD CONSTRAINT showroom_agencies_status_check CHECK(status IN ('draft','expired','superseded','signed','owner_submitted','approved','revision_requested'))");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS owner_submitted_at TIMESTAMPTZ");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES users(id)");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS revision_note TEXT NOT NULL DEFAULT ''");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS owner_correction TEXT NOT NULL DEFAULT ''");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS accepted_digest TEXT");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS owner_declared_name TEXT");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS owner_declared_phone TEXT");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS owner_declared_national_id TEXT");
 await q("ALTER TABLE showroom_agencies ADD COLUMN IF NOT EXISTS link_issued_at TIMESTAMPTZ");
 await q("ALTER TABLE showroom_agency_documents DROP CONSTRAINT IF EXISTS showroom_agency_documents_kind_check");
 await q("ALTER TABLE showroom_agency_documents ADD CONSTRAINT showroom_agency_documents_kind_check CHECK(kind IN ('vehicle','national_front','national_back','power_of_attorney','contract_page_1','contract_page_2'))");
 const existing=await q("SELECT id FROM users WHERE email=$1",[OWNER_EMAIL]);
 const hash=await bcrypt.hash(OWNER_PASSWORD,12);
 if(!existing.rowCount) await q("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[crypto.randomUUID(),"علیرضا شفیعی",OWNER_EMAIL,hash]);
 else await q("UPDATE users SET role='owner',active=true,password_hash=$2,updated_at=NOW() WHERE email=$1",[OWNER_EMAIL,hash]);
}
async function auth(req,res,next){
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 try{const payload=jwt.verify(token,JWT_SECRET);const r=await q("SELECT id,name,email,role,display_title,finance_access,finance_edit,showroom_access,showroom_edit,scout_access FROM users WHERE id=$1 AND active=true",[payload.sub]);if(!r.rowCount)return res.status(401).json({error:"حساب غیرفعال است"});req.user={...r.rows[0],sub:r.rows[0].id};next()}catch{return res.status(401).json({error:"نیاز به ورود مجدد"})}
}
const allow=(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:"دسترسی کافی ندارید"});
const finance=(req,res,next)=>req.user.role==="owner"||req.user.finance_access?next():res.status(403).json({error:"به بخش مالی دسترسی ندارید"});
const financeWrite=(req,res,next)=>req.user.role==="owner"||(req.user.finance_access&&req.user.finance_edit)?next():res.status(403).json({error:"اجازهٔ ثبت و ویرایش مالی ندارید"});
const showroom=(req,res,next)=>req.user.role==="owner"||req.user.showroom_access?next():res.status(403).json({error:"به بخش نمایشگاه دسترسی ندارید"});
const showroomWrite=(req,res,next)=>req.user.role==="owner"||(req.user.showroom_access&&req.user.showroom_edit)?next():res.status(403).json({error:"مجوز ثبت و ویرایش نمایشگاه ندارید"});
async function audit(user,action,target,data={}){await q("INSERT INTO audit_log(id,action,target,data,actor_id) VALUES($1,$2,$3,$4,$5)",[crypto.randomUUID(),action,target,JSON.stringify(data),user.sub]).catch(()=>{})}
function periodOf(value){
 const d=new Date(value); if(Number.isNaN(d.getTime())) return null;
 const parts=new Intl.DateTimeFormat("en-u-ca-persian",{year:"numeric",month:"2-digit",timeZone:"Asia/Tehran"}).formatToParts(d);
 return parts.find(x=>x.type==="year").value+"-"+parts.find(x=>x.type==="month").value;
}
function currentPeriod(){return periodOf(new Date())}
async function closePastPeriods(){
 await q("INSERT INTO periods(period,closed,closed_at) SELECT DISTINCT period,true,NOW() FROM transactions WHERE period<>$1 ON CONFLICT(period) DO UPDATE SET closed=true,closed_at=COALESCE(periods.closed_at,NOW())",[currentPeriod()]);
}
app.get("/api/health",async(req,res)=>{try{await q("SELECT 1");dbReady=true;dbErrorCode="";res.json({ok:true})}catch(e){dbReady=false;dbErrorCode=e.code||"DB_UNAVAILABLE";res.status(503).json({ok:false,code:dbErrorCode})}});
app.use("/api",(req,res,next)=>dbReady?next():res.status(503).json({error:"پایگاه داده در حال اتصال است",code:dbErrorCode}));
app.post("/api/auth/login",async(req,res)=>{
 const email=cleanEmail(req.body.email),password=String(req.body.password||"");
 const r=await q("SELECT * FROM users WHERE email=$1 AND active=true",[email]);
 if(!r.rowCount||!await bcrypt.compare(password,r.rows[0].password_hash)) return res.status(401).json({error:"ایمیل یا رمز عبور اشتباه است"});
 res.json({token:sign(r.rows[0]),user:publicUser(r.rows[0])});
});
app.post("/api/auth/passkey/register/options",auth,async(req,res)=>{
 const u=await q("SELECT id,name,email FROM users WHERE id=$1 AND active=true",[req.user.sub]);
 if(!u.rowCount)return res.status(401).json({error:"حساب غیرفعال است"});
 const existing=await q("SELECT id,transports FROM passkeys WHERE user_id=$1",[req.user.sub]);
 const options=await generateRegistrationOptions({rpName:"Sheen Finance",rpID:RP_ID,userID:passkeyUserID(u.rows[0].id),userName:u.rows[0].email,userDisplayName:u.rows[0].name,attestationType:"none",authenticatorSelection:{residentKey:"preferred",userVerification:"required"},excludeCredentials:existing.rows.map(x=>({id:x.id,transports:x.transports}))});
 passkeyChallenges.set("reg:"+req.user.sub,{challenge:options.challenge,expires:Date.now()+300000});res.json(options);
});
app.post("/api/auth/passkey/register",auth,async(req,res)=>{
 try{const key="reg:"+req.user.sub, saved=passkeyChallenges.get(key);if(!saved||saved.expires<Date.now())return res.status(400).json({error:"ثبت Face ID منقضی شده است"});
  const v=await verifyRegistrationResponse({response:req.body,expectedChallenge:saved.challenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true});
  if(!v.verified||!v.registrationInfo)return res.status(400).json({error:"ثبت Passkey ناموفق بود"});
  const c=v.registrationInfo.credential;await q("INSERT INTO passkeys(id,user_id,public_key,counter,transports) VALUES($1,$2,$3,$4,$5)",[c.id,req.user.sub,Buffer.from(c.publicKey),c.counter,c.transports||[]]);passkeyChallenges.delete(key);res.json({ok:true});
 }catch(e){console.error("Passkey registration failed",e.message);res.status(400).json({error:"ثبت Face ID انجام نشد"})}
});
app.post("/api/auth/passkey/options",async(req,res)=>{
 const email=cleanEmail(req.body.email),u=await q("SELECT id FROM users WHERE email=$1 AND active=true",[email]);
 if(!u.rowCount)return res.status(404).json({error:"ایمیل پیدا نشد"});
 const creds=await q("SELECT id,transports FROM passkeys WHERE user_id=$1",[u.rows[0].id]);if(!creds.rowCount)return res.status(404).json({error:"برای این حساب Passkey ثبت نشده است"});
 const options=await generateAuthenticationOptions({rpID:RP_ID,userVerification:"required",allowCredentials:creds.rows.map(x=>({id:x.id,transports:x.transports}))});passkeyChallenges.set("auth:"+email,{challenge:options.challenge,userId:u.rows[0].id,expires:Date.now()+300000});res.json(options);
});
app.post("/api/auth/passkey/login",async(req,res)=>{
 try{const email=cleanEmail(req.body.email),saved=passkeyChallenges.get("auth:"+email);if(!saved||saved.expires<Date.now())return res.status(400).json({error:"درخواست Face ID منقضی شده است"});
  const r=await q("SELECT * FROM passkeys WHERE user_id=$1",[saved.userId]);let match;for(const c of r.rows){if(c.id===req.body.id){match=c;break}}if(!match)return res.status(401).json({error:"Passkey معتبر نیست"});
  const v=await verifyAuthenticationResponse({response:req.body,expectedChallenge:saved.challenge,expectedOrigin:ORIGIN,expectedRPID:RP_ID,requireUserVerification:true,credential:{id:match.id,publicKey:new Uint8Array(match.public_key),counter:Number(match.counter),transports:match.transports}});if(!v.verified)return res.status(401).json({error:"تأیید Face ID ناموفق بود"});const u=await q("SELECT * FROM users WHERE id=$1 AND active=true",[saved.userId]);if(!u.rowCount)return res.status(401).json({error:"حساب غیرفعال است"});await q("UPDATE passkeys SET counter=$1 WHERE id=$2",[v.authenticationInfo.newCounter,match.id]);passkeyChallenges.delete("auth:"+email);res.json({token:sign(u.rows[0]),user:publicUser(u.rows[0])});
 }catch(e){console.error("Passkey authentication failed",e.message);res.status(401).json({error:"ورود با Face ID ناموفق بود"})}
});
app.get("/api/me",auth,async(req,res)=>{const r=await q("SELECT * FROM users WHERE id=$1 AND active=true",[req.user.sub]);if(!r.rowCount)return res.status(401).json({error:"حساب غیرفعال است"});res.json(publicUser(r.rows[0]))});
app.use(["/api/transactions","/api/transaction-edits","/api/periods","/api/import"],auth,finance);
app.get("/api/transactions",auth,async(req,res)=>{
 await closePastPeriods();
 const r=await q("SELECT id,kind,amount::text,description AS desc,happened_at AS date,period,actor_name AS \"actorName\",actor_email AS \"actorEmail\" FROM transactions ORDER BY happened_at DESC");
 res.json(r.rows.map(x=>({...x,amount:Number(x.amount)})));
});
app.get("/api/transaction-edits",auth,async(req,res)=>{
 const r=await q(`SELECT transaction_id AS "transactionId",actor_name AS "actorName",
 before_amount::text AS "beforeAmount",after_amount::text AS "afterAmount",
 before_kind AS "beforeKind",after_kind AS "afterKind",
 before_description AS "beforeDescription",after_description AS "afterDescription",
 before_happened_at AS "beforeDate",after_happened_at AS "afterDate",edited_at AS "editedAt"
 FROM transaction_edits ORDER BY edited_at ASC,id ASC`);
 res.json(r.rows.map(x=>({...x,beforeAmount:Number(x.beforeAmount),afterAmount:Number(x.afterAmount)})));
});
app.post("/api/transactions",auth,financeWrite,async(req,res)=>{
 const amount=Math.trunc(Number(req.body.amount)),kind=req.body.kind,desc=String(req.body.desc||"").trim(),date=new Date(req.body.date),period=periodOf(req.body.date);
 if(!amount||amount<1||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))return res.status(400).json({error:"اطلاعات تراکنش کامل نیست"});
 const pr=await q("SELECT closed FROM periods WHERE period=$1",[period]);if(req.user.role!=="owner"&&period!==currentPeriod()&&pr.rows[0]?.closed!==false)return res.status(403).json({error:"این ماه بسته شده است"});
 const u=await q("SELECT name,email FROM users WHERE id=$1",[req.user.sub]),id=crypto.randomUUID();
 await q("INSERT INTO transactions(id,kind,amount,description,happened_at,period,actor_id,actor_name,actor_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,kind,amount,desc,date.toISOString(),period,req.user.sub,u.rows[0].name,u.rows[0].email]);
 await audit(req.user,"create_transaction",id,{amount,kind,desc,date:req.body.date});res.status(201).json({id});
});
app.put("/api/transactions/:id",auth,financeWrite,async(req,res)=>{
 const amount=Math.trunc(Number(req.body.amount)),kind=req.body.kind,desc=String(req.body.desc||"").trim(),date=new Date(req.body.date),period=periodOf(req.body.date);
 if(!Number.isSafeInteger(amount)||amount<1||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))return res.status(400).json({error:"اطلاعات نامعتبر"});
 const client=await pool.connect();
 try{
  await client.query("BEGIN");
  const old=await client.query("SELECT * FROM transactions WHERE id=$1 FOR UPDATE",[req.params.id]);
  if(!old.rowCount){await client.query("ROLLBACK");return res.status(404).json({error:"تراکنش پیدا نشد"})}
  const before=old.rows[0];
  if(req.user.role!=="owner"){
   const pr=await client.query("SELECT closed FROM periods WHERE period=$1",[before.period]);
   if(before.period!==currentPeriod()||pr.rows[0]?.closed){await client.query("ROLLBACK");return res.status(403).json({error:"ماه بسته شده است"})}
  }
  const user=await client.query("SELECT name FROM users WHERE id=$1 AND active=true",[req.user.sub]);
  if(!user.rowCount){await client.query("ROLLBACK");return res.status(401).json({error:"حساب غیرفعال است"})}
  await client.query("UPDATE transactions SET kind=$1,amount=$2,description=$3,happened_at=$4,period=$5,updated_at=NOW() WHERE id=$6",[kind,amount,desc,date.toISOString(),period,req.params.id]);
  await client.query(`INSERT INTO transaction_edits(id,transaction_id,actor_id,actor_name,before_amount,after_amount,before_kind,after_kind,before_description,after_description,before_happened_at,after_happened_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
   [crypto.randomUUID(),req.params.id,req.user.sub,user.rows[0].name,before.amount,amount,before.kind,kind,before.description,desc,before.happened_at,date.toISOString()]);
  await client.query("COMMIT");
  res.json({ok:true});
 }catch(e){await client.query("ROLLBACK").catch(()=>{});console.error("Transaction update failed",e.code||e.message);res.status(500).json({error:"ویرایش ذخیره نشد؛ دوباره تلاش کنید"})}
 finally{client.release()}
});
app.get("/api/periods",auth,async(req,res)=>{await closePastPeriods();const r=await q("SELECT period,closed FROM periods");res.json(Object.fromEntries(r.rows.map(x=>[x.period,x])))});
app.get("/api/members",auth,allow("owner"),async(req,res)=>{const r=await q("SELECT id,name,email,role,display_title AS \"displayTitle\",active,finance_access AS \"financeAccess\",finance_edit AS \"financeEdit\",showroom_access AS \"showroomAccess\",showroom_edit AS \"showroomEdit\",scout_access AS \"scoutAccess\" FROM users WHERE role<>'owner' AND active=true ORDER BY created_at");res.json(r.rows)});
app.post("/api/members",auth,allow("owner"),async(req,res)=>{
 const name=String(req.body.name||"").trim(),email=cleanEmail(req.body.email),role=req.body.role,password=String(req.body.password||"");
 const financeAccess=req.body.financeAccess===true,financeEdit=financeAccess&&req.body.financeEdit===true,showroomAccess=req.body.showroomAccess===true,showroomEdit=showroomAccess&&req.body.showroomEdit===true,scoutAccess=req.body.scoutAccess===true,displayTitle=req.body.displayTitle;
 if(!name||!/^\S+@\S+\.\S+$/.test(email)||!["admin","viewer"].includes(role)||!["عضو","مدیر","کارمند"].includes(displayTitle)||password.length<8||!financeAccess&&!showroomAccess&&!scoutAccess)return res.status(400).json({error:"نام، ایمیل، رمز حداقل ۸ حرف و یک بخش مجاز لازم است"});
 const hash=await bcrypt.hash(password,12),id=crypto.randomUUID();
 try{await q("INSERT INTO users(id,name,email,password_hash,role,display_title,finance_access,finance_edit,showroom_access,showroom_edit,scout_access) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",[id,name,email,hash,role,displayTitle,financeAccess,financeEdit,showroomAccess,showroomEdit,scoutAccess])}catch(e){if(e.code==="23505")return res.status(409).json({error:"این ایمیل قبلاً ثبت شده"});throw e}
 await audit(req.user,"add_member",email,{name,role,displayTitle,financeAccess,financeEdit,showroomAccess,showroomEdit,scoutAccess});res.status(201).json({id});
});
app.put("/api/members/:id",auth,allow("owner"),async(req,res)=>{
 const name=String(req.body.name||"").trim(),role=req.body.role,password=String(req.body.password||"");
 const financeAccess=req.body.financeAccess===true,financeEdit=financeAccess&&req.body.financeEdit===true,showroomAccess=req.body.showroomAccess===true,showroomEdit=showroomAccess&&req.body.showroomEdit===true,scoutAccess=req.body.scoutAccess===true,displayTitle=req.body.displayTitle;
 if(!name||!["admin","viewer"].includes(role)||!["عضو","مدیر","کارمند"].includes(displayTitle)||!financeAccess&&!showroomAccess&&!scoutAccess)return res.status(400).json({error:"نام و دسترسی به حداقل یک بخش لازم است"});
 if(password&&password.length<8)return res.status(400).json({error:"رمز باید حداقل ۸ حرف باشد"});
 const r=await q("UPDATE users SET name=$1,role=$2,display_title=$3,finance_access=$4,finance_edit=$5,showroom_access=$6,showroom_edit=$7,scout_access=$8,password_hash=COALESCE($9,password_hash),updated_at=NOW() WHERE id=$10 AND role<>'owner' RETURNING id",[name,role,displayTitle,financeAccess,financeEdit,showroomAccess,showroomEdit,scoutAccess,password?await bcrypt.hash(password,12):null,req.params.id]);
 if(!r.rowCount)return res.status(404).json({error:"عضو پیدا نشد"});
 await audit(req.user,"update_member",req.params.id,{name,role,displayTitle,financeAccess,financeEdit,showroomAccess,showroomEdit,scoutAccess});res.json({ok:true});
});
app.delete("/api/members/:id",auth,allow("owner"),async(req,res)=>{await q("UPDATE users SET active=false,updated_at=NOW() WHERE id=$1 AND role<>'owner'",[req.params.id]);await audit(req.user,"disable_member",req.params.id);res.json({ok:true})});
app.post("/api/import",auth,allow("owner"),async(req,res)=>{
 const items=Array.isArray(req.body)?req.body.slice(0,5000):[];let count=0;
 for(const x of items){const amount=Math.trunc(Number(x.amount)),kind=x.kind,desc=String(x.desc||"").trim(),date=new Date(x.date),period=periodOf(x.date);if(!amount||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))continue;const id=String(x.id||crypto.randomUUID()).replace(/[^a-f0-9-]/gi,"").slice(0,36);const safeId=/^[0-9a-f]{8}-/.test(id)?id:crypto.randomUUID();await q("INSERT INTO transactions(id,kind,amount,description,happened_at,period,actor_id,actor_name,actor_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING",[safeId,kind,amount,desc,date.toISOString(),period,req.user.sub,"مالک",OWNER_EMAIL]);count++}
 await audit(req.user,"import_transactions","bulk",{count});res.json({count});
});
const money=v=>Number.isSafeInteger(Number(v))&&Number(v)>=0?Number(v):null;
const short=(v,max=250)=>String(v||"").trim().slice(0,max);
const carFields=b=>({title:short(b.title,120),year:short(b.year,20),mileage:money(b.mileage),paint:short(b.paint,100),ownership:b.ownership,status:b.status,askingPrice:money(b.askingPrice),ownerName:short(b.ownerName,120),notes:short(b.notes,1000)});
const carValid=c=>c.title&&c.mileage!==null&&c.askingPrice!==null&&["owned","consignment"].includes(c.ownership)&&["available","reserved","inspection","sold","settled"].includes(c.status);
app.use("/api/showroom",auth,showroom);
const agencyTokenHash=token=>crypto.createHash("sha256").update(token).digest("hex");
app.get("/api/showroom/agencies",async(req,res)=>{
 const r=await q('SELECT a.id,a.car_id AS "carId",c.title AS "carTitle",a.version,a.status,a.owner_name AS "ownerName",a.net_price::text AS "netPrice",a.expires_at AS "expiresAt",a.created_at AS "createdAt",a.owner_submitted_at AS "ownerSubmittedAt",a.revision_note AS "revisionNote",a.owner_correction AS "ownerCorrection",a.owner_declared_name AS "declaredName",a.owner_declared_phone AS "declaredPhone",a.owner_declared_national_id AS "declaredNationalId",a.commission,a.settlement,a.authority,a.terms,a.accepted_digest AS "acceptedDigest" FROM showroom_agencies a JOIN showroom_cars c ON c.id=a.car_id ORDER BY a.created_at DESC');res.json(r.rows);
});
app.post("/api/showroom/agencies",showroomWrite,async(req,res)=>{
 const {carId,ownerName,ownerNationalId,ownerPhone,commission,settlement,authority,terms}=req.body||{};
 const netPrice=Number(req.body?.netPrice),days=Number(req.body?.validDays||6);
 if(!carId||!String(ownerName||"").trim()||!/^[0-9]{10}$/.test(String(ownerNationalId||""))||!/^09[0-9]{9}$/.test(String(ownerPhone||""))||!Number.isSafeInteger(netPrice)||netPrice<0||!Number.isInteger(days)||days<1||days>30||!String(authority||"").trim()||!String(settlement||"").trim())return res.status(400).json({error:"مشخصات مالک و شرایط قرارداد را کامل کنید"});
 const client=await pool.connect();let token,id;try{
  await client.query("BEGIN");const car=await client.query("SELECT id,title,year,mileage,paint,ownership,asking_price,owner_name FROM showroom_cars WHERE id=$1 FOR UPDATE",[carId]);
  if(!car.rowCount||car.rows[0].ownership!=="consignment"){await client.query("ROLLBACK");return res.status(400).json({error:"نیابت فقط برای خودروی امانی ثبت می‌شود"})}
  const prior=await client.query("SELECT COALESCE(MAX(version),0)+1 AS version FROM showroom_agencies WHERE car_id=$1",[carId]);
  await client.query("UPDATE showroom_agencies SET status='superseded' WHERE car_id=$1 AND status IN ('draft','revision_requested')",[carId]);
  token=crypto.randomBytes(32).toString("hex");id=crypto.randomUUID();
  await client.query("INSERT INTO showroom_agencies(id,car_id,version,owner_name,owner_national_id,owner_phone,car_snapshot,net_price,commission,settlement,authority,terms,token_hash,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW()+($14::int * INTERVAL '1 day'),$15)",[id,carId,prior.rows[0].version,String(ownerName).trim(),ownerNationalId,ownerPhone,JSON.stringify(car.rows[0]),netPrice,String(commission||"").slice(0,1000),String(settlement).slice(0,1000),String(authority).slice(0,1000),String(terms||"").slice(0,5000),agencyTokenHash(token),days,req.user.sub]);
  await client.query("COMMIT");
 }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}
 await audit(req.user,"showroom_agency_create",id,{carId});res.status(201).json({id});
});
const agencyDocumentKinds=new Set(["vehicle","national_front","national_back","power_of_attorney","contract_page_1","contract_page_2"]);
const agencyDocumentMimes=new Set(["image/jpeg","image/png","image/webp","application/pdf"]);
const ownerUploadKinds=new Set(["vehicle","national_front","national_back","power_of_attorney"]);
const ownerLimiter=rateLimit({windowMs:15*60*1000,max:50,standardHeaders:true,legacyHeaders:false});
app.use("/api/owner-agency",ownerLimiter);
async function auditOwner(action,agencyId,data={}){
 await q("INSERT INTO audit_log(id,action,target,data) VALUES($1,$2,$3,$4)",[crypto.randomUUID(),action,agencyId,JSON.stringify(data)]);
}
async function ownerAgency(req,res,next){
 const token=String(req.headers["x-agency-token"]||"");
 if(!/^[a-f0-9]{64}$/.test(token))return res.sendStatus(404);
 const r=await q("SELECT * FROM showroom_agencies WHERE token_hash=$1 AND expires_at>NOW() AND status IN ('draft','revision_requested','owner_submitted')",[agencyTokenHash(token)]);
 if(!r.rowCount)return res.sendStatus(404);
 req.agency=r.rows[0];next();
}
app.post("/api/showroom/agencies/:id/owner-link",showroomWrite,async(req,res)=>{
 const docs=await q("SELECT kind FROM showroom_agency_documents WHERE agency_id=$1 AND kind IN ('contract_page_1','contract_page_2')",[req.params.id]);
 if(docs.rowCount!==2)return res.status(409).json({error:"ابتدا هر دو صفحهٔ نیابت‌نامهٔ وکیل را بارگذاری کنید"});
 const token=crypto.randomBytes(32).toString("hex");
 const r=await q("UPDATE showroom_agencies SET token_hash=$2,link_issued_at=COALESCE(link_issued_at,NOW()) WHERE id=$1 AND status IN ('draft','revision_requested') AND owner_correction='' AND expires_at>NOW() RETURNING id",[req.params.id,agencyTokenHash(token)]);
 if(!r.rowCount)return res.status(409).json({error:"درخواست قابل ارسال نیست"});
 await audit(req.user,"showroom_agency_link_issued",req.params.id);
 res.set("Cache-Control","no-store").json({url:"/agency.html#"+token});
});
app.post("/api/showroom/agencies/:id/revoke-link",showroomWrite,async(req,res)=>{
 const r=await q("UPDATE showroom_agencies SET token_hash=$2,expires_at=NOW() WHERE id=$1 RETURNING id",[req.params.id,agencyTokenHash(crypto.randomBytes(32).toString("hex"))]);
 if(!r.rowCount)return res.sendStatus(404);
 await audit(req.user,"showroom_agency_link_revoked",req.params.id);res.json({ok:true});
});
app.get("/api/owner-agency",ownerAgency,async(req,res)=>{
 const a=req.agency;
 const docs=await q("SELECT kind,review_status AS status,review_note AS note FROM showroom_agency_documents WHERE agency_id=$1",[a.id]);
 res.set("Cache-Control","no-store").json({car:a.car_snapshot,version:a.version,netPrice:String(a.net_price),commission:a.commission,settlement:a.settlement,authority:a.authority,terms:a.terms,status:a.status,revisionNote:a.revision_note,expiresAt:a.expires_at,documents:docs.rows});
});
app.get("/api/owner-agency/contract/:page",ownerAgency,async(req,res)=>{
 if(!["1","2"].includes(req.params.page))return res.sendStatus(404);
 const r=await q("SELECT mime,content FROM showroom_agency_documents WHERE agency_id=$1 AND kind=$2",[req.agency.id,"contract_page_"+req.params.page]);
 if(!r.rowCount)return res.sendStatus(404);
 res.set({"Content-Type":r.rows[0].mime,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}).send(r.rows[0].content);
});
app.put("/api/owner-agency/document/:kind",ownerAgency,async(req,res)=>{
 const {kind}=req.params,{mime,data}=req.body||{};
 if(!ownerUploadKinds.has(kind)||!agencyDocumentMimes.has(mime)||typeof data!=="string"||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))return res.status(400).json({error:"فایل نامعتبر است"});
 const bytes=Buffer.from(data,"base64");
 if(!bytes.length||bytes.length>2*1024*1024||!validDocumentBytes(mime,bytes))return res.status(400).json({error:"حداکثر حجم ۲ مگابایت؛ تصویر یا PDF معتبر"});
 if(req.agency.status==="owner_submitted")return res.status(409).json({error:"درخواست ثبت شده است"});
 const hash=crypto.createHash("sha256").update(bytes).digest("hex");
 await q(`INSERT INTO showroom_agency_documents(id,agency_id,kind,mime,content,sha256) VALUES($1,$2,$3,$4,$5,$6)
 ON CONFLICT(agency_id,kind) DO UPDATE SET mime=EXCLUDED.mime,content=EXCLUDED.content,sha256=EXCLUDED.sha256,review_status='pending',review_note='',reviewed_by=NULL,reviewed_at=NULL,created_at=NOW()`,[crypto.randomUUID(),req.agency.id,kind,mime,bytes,hash]);
 await auditOwner("showroom_agency_owner_document_upload",req.agency.id,{kind,sha256:hash});
 res.json({ok:true});
});
app.post("/api/owner-agency/correction",ownerAgency,async(req,res)=>{
 const note=short(req.body?.note,1000);if(!note)return res.status(400).json({error:"توضیح اصلاح لازم است"});
 const result=await q("UPDATE showroom_agencies SET owner_correction=$2,status='revision_requested' WHERE id=$1 AND status IN ('draft','revision_requested') RETURNING id",[req.agency.id,note]);
 if(!result.rowCount)return res.status(409).json({error:"این درخواست قبلاً ثبت شده است"});
 await auditOwner("showroom_agency_owner_correction",req.agency.id);res.json({ok:true});
});
app.post("/api/owner-agency/submit",ownerAgency,async(req,res)=>{
 if(req.agency.status==="owner_submitted")return res.status(409).json({error:"قبلاً ثبت شده است"});
 if(req.agency.owner_correction)return res.status(409).json({error:"برای این درخواست اصلاح ثبت شده است؛ منتظر نسخهٔ جدید باشید"});
 const {name,phone,nationalId,hasPowerOfAttorney,accepted}=req.body||{};
 if(accepted!==true||!short(name,120)||!/^09[0-9]{9}$/.test(String(phone||""))||!/^[0-9]{10}$/.test(String(nationalId||"")))return res.status(400).json({error:"اطلاعات و پذیرش شرایط را کامل کنید"});
 if(phone!==req.agency.owner_phone||nationalId!==req.agency.owner_national_id)return res.status(400).json({error:"کد ملی و شماره همراه با مشخصات ثبت‌شدهٔ مالک مطابقت ندارد"});
 const docs=await q("SELECT kind,sha256 FROM showroom_agency_documents WHERE agency_id=$1",[req.agency.id]);
 const map=new Map(docs.rows.map(x=>[x.kind,x.sha256]));
 if(["vehicle","national_front","national_back","contract_page_1","contract_page_2",...(hasPowerOfAttorney?["power_of_attorney"]:[])].some(k=>!map.has(k)))return res.status(409).json({error:"مدارک الزامی و دو صفحهٔ نیابت‌نامه باید کامل باشند"});
 const digest=crypto.createHash("sha256").update(JSON.stringify({version:req.agency.version,car:req.agency.car_snapshot,price:String(req.agency.net_price),commission:req.agency.commission,settlement:req.agency.settlement,authority:req.agency.authority,terms:req.agency.terms,documents:[...map.entries()].sort()})).digest("hex");
 const r=await q("UPDATE showroom_agencies SET status='owner_submitted',owner_submitted_at=NOW(),owner_declared_name=$2,owner_declared_phone=$3,owner_declared_national_id=$4,accepted_digest=$5,owner_correction='' WHERE id=$1 AND status IN ('draft','revision_requested') RETURNING id,owner_submitted_at",[req.agency.id,short(name,120),phone,nationalId,digest]);
 if(!r.rowCount)return res.status(409).json({error:"وضعیت پرونده تغییر کرده است"});
 await auditOwner("showroom_agency_owner_submit",req.agency.id,{version:req.agency.version,digest});
 res.set("Cache-Control","no-store").json({reference:r.rows[0].id,submittedAt:r.rows[0].owner_submitted_at,version:req.agency.version,digest});
});
app.post("/api/showroom/agencies/:id/final-review",showroomWrite,async(req,res)=>{
 const status=req.body?.approved===true?"approved":"revision_requested",note=short(req.body?.note,1000);
 if(status==="revision_requested"&&!note)return res.status(400).json({error:"دلیل اصلاح لازم است"});
 const client=await pool.connect();
 try{await client.query("BEGIN");
  const a=await client.query("SELECT status FROM showroom_agencies WHERE id=$1 FOR UPDATE",[req.params.id]);
  if(a.rows[0]?.status!=="owner_submitted"){await client.query("ROLLBACK");return res.status(409).json({error:"تأیید مالک ثبت نشده است"})}
  if(status==="approved"){
   const docs=await client.query("SELECT kind,review_status FROM showroom_agency_documents WHERE agency_id=$1",[req.params.id]);
   const map=new Map(docs.rows.map(x=>[x.kind,x.review_status]));
   if(["vehicle","national_front","national_back"].some(k=>map.get(k)!=="approved")||[...map.entries()].some(([kind,s])=>kind==="power_of_attorney"&&s!=="approved")){await client.query("ROLLBACK");return res.status(409).json({error:"ابتدا مدارک هویتی و مالکیت را تأیید کنید"})}
  }
  await client.query("UPDATE showroom_agencies SET status=$2,revision_note=$3,reviewed_by=$4,reviewed_at=NOW(),token_hash=CASE WHEN $2='approved' THEN $5 ELSE token_hash END WHERE id=$1",[req.params.id,status,note,req.user.sub,agencyTokenHash(crypto.randomBytes(32).toString("hex"))]);
  await client.query("COMMIT");
 }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}
 await audit(req.user,"showroom_agency_final_review",req.params.id,{status});res.json({ok:true,status});
});
function validDocumentBytes(mime,bytes){
 if(mime==="image/jpeg")return bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff;
 if(mime==="image/png")return bytes.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex"));
 if(mime==="image/webp")return bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP";
 if(mime==="application/pdf")return bytes.toString("ascii",0,5)==="%PDF-";
 return false;
}
app.get("/api/showroom/agencies/:id/documents",async(req,res)=>{
 const agency=await q("SELECT id FROM showroom_agencies WHERE id=$1",[req.params.id]);
 if(!agency.rowCount)return res.sendStatus(404);
 const rows=await q('SELECT id,kind,mime,sha256,review_status AS "reviewStatus",review_note AS "reviewNote",created_at AS "createdAt",reviewed_at AS "reviewedAt" FROM showroom_agency_documents WHERE agency_id=$1 ORDER BY created_at',[req.params.id]);
 res.set("Cache-Control","no-store").json(rows.rows);
});
app.get("/api/showroom/agencies/:id/documents/:kind",async(req,res)=>{
 if(!agencyDocumentKinds.has(req.params.kind))return res.sendStatus(404);
 const row=await q("SELECT mime,content FROM showroom_agency_documents WHERE agency_id=$1 AND kind=$2",[req.params.id,req.params.kind]);
 if(!row.rowCount)return res.sendStatus(404);
 res.set({"Content-Type":row.rows[0].mime,"Content-Disposition":"attachment; filename=document."+({"image/jpeg":"jpg","image/png":"png","image/webp":"webp","application/pdf":"pdf"}[row.rows[0].mime]),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}).send(row.rows[0].content);
});
app.put("/api/showroom/agencies/:id/documents/:kind",showroomWrite,async(req,res)=>{
 const {kind,id}=req.params,{mime,data}=req.body||{};
 if(!agencyDocumentKinds.has(kind)||!agencyDocumentMimes.has(mime)||typeof data!=="string"||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))return res.status(400).json({error:"فایل یا نوع مدرک معتبر نیست"});
 const bytes=Buffer.from(data,"base64");
 if(!bytes.length||bytes.length>2*1024*1024||!validDocumentBytes(mime,bytes))return res.status(400).json({error:"فایل باید تصویر یا PDF معتبر، حداکثر ۲ مگابایت باشد"});
 const agency=await q("SELECT status FROM showroom_agencies WHERE id=$1",[id]);
 if(!agency.rowCount)return res.sendStatus(404);
 if(!["draft","revision_requested"].includes(agency.rows[0].status))return res.status(409).json({error:"مدارک این نسخه قابل تغییر نیست"});
 if(kind.startsWith("contract_page_")){
  const issued=await q("SELECT link_issued_at FROM showroom_agencies WHERE id=$1",[id]);
  if(issued.rows[0].link_issued_at)return res.status(409).json({error:"متن نیابت‌نامه پس از صدور لینک قفل است؛ نسخهٔ تازه بسازید"});
 }
 const hash=crypto.createHash("sha256").update(bytes).digest("hex");
 await q(`INSERT INTO showroom_agency_documents(id,agency_id,kind,mime,content,sha256) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(agency_id,kind) DO UPDATE SET mime=EXCLUDED.mime,content=EXCLUDED.content,sha256=EXCLUDED.sha256,review_status='pending',review_note='',reviewed_by=NULL,reviewed_at=NULL,created_at=NOW()`,[crypto.randomUUID(),id,kind,mime,bytes,hash]);
 await audit(req.user,"showroom_agency_document_upload",id,{kind,sha256:hash});res.json({ok:true});
});
app.patch("/api/showroom/agencies/:id/documents/:kind/review",showroomWrite,async(req,res)=>{
 const {kind,id}=req.params,{status,note}=req.body||{};
 if(!agencyDocumentKinds.has(kind)||!["approved","revision_requested"].includes(status)||status==="revision_requested"&&!String(note||"").trim())return res.status(400).json({error:"نتیجه و توضیح بررسی را وارد کنید"});
 const result=await q("UPDATE showroom_agency_documents SET review_status=$3,review_note=$4,reviewed_by=$5,reviewed_at=NOW() WHERE agency_id=$1 AND kind=$2 AND EXISTS(SELECT 1 FROM showroom_agencies WHERE id=$1 AND status IN ('draft','owner_submitted','revision_requested')) RETURNING id",[id,kind,status,String(note||"").trim().slice(0,500),req.user.sub]);
 if(!result.rowCount)return res.status(404).json({error:"مدرک قابل بررسی پیدا نشد"});
 await audit(req.user,"showroom_agency_document_review",id,{kind,status});res.json({ok:true});
});
app.get("/api/showroom/cars",async(req,res)=>{
 const r=await q('SELECT id,title,year,mileage::text,paint,ownership,status,asking_price::text AS "askingPrice",owner_name AS "ownerName",notes,created_at AS "createdAt" FROM showroom_cars ORDER BY created_at DESC');
 res.json(r.rows.map(x=>({...x,mileage:Number(x.mileage),askingPrice:Number(x.askingPrice)})));
});
app.post("/api/showroom/cars",showroomWrite,async(req,res)=>{
 const c=carFields(req.body);if(!carValid(c))return res.status(400).json({error:"اطلاعات خودرو کامل یا معتبر نیست"});
 const id=crypto.randomUUID();await q("INSERT INTO showroom_cars(id,title,year,mileage,paint,ownership,status,asking_price,owner_name,notes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,c.title,c.year,c.mileage,c.paint,c.ownership,c.status,c.askingPrice,c.ownerName,c.notes]);
 await audit(req.user,"showroom_car_create",id);res.status(201).json({id});
});
app.put("/api/showroom/cars/:id",showroomWrite,async(req,res)=>{
 const c=carFields(req.body);if(!carValid(c))return res.status(400).json({error:"اطلاعات خودرو معتبر نیست"});
 const r=await q("UPDATE showroom_cars SET title=$1,year=$2,mileage=$3,paint=$4,ownership=$5,status=$6,asking_price=$7,owner_name=$8,notes=$9,updated_at=NOW() WHERE id=$10 RETURNING id",[c.title,c.year,c.mileage,c.paint,c.ownership,c.status,c.askingPrice,c.ownerName,c.notes,req.params.id]);
 if(!r.rowCount)return res.status(404).json({error:"خودرو پیدا نشد"});await audit(req.user,"showroom_car_update",req.params.id);res.json({ok:true});
});
app.get("/api/showroom/photos",async(req,res)=>{
 const r=await q("SELECT id,car_id AS \"carId\" FROM showroom_photos ORDER BY created_at");res.json(r.rows);
});
app.get("/api/showroom/photos/:id",async(req,res)=>{
 const r=await q("SELECT mime,image FROM showroom_photos WHERE id=$1",[req.params.id]);if(!r.rowCount)return res.sendStatus(404);
 res.set("Cache-Control","private, no-store").type(r.rows[0].mime).send(r.rows[0].image);
});
app.post("/api/showroom/cars/:id/photos",showroomWrite,async(req,res)=>{
 const mime=String(req.body.mime||""),raw=String(req.body.data||"");
 if(!["image/jpeg","image/png","image/webp"].includes(mime)||!raw||raw.length>2800000||!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))return res.status(400).json({error:"عکس معتبر نیست یا بیش از حد بزرگ است"});
 const image=Buffer.from(raw,"base64");
 const valid=mime==="image/jpeg"?image[0]===255&&image[1]===216:mime==="image/png"?image.subarray(0,8).equals(Buffer.from("89504e470d0a1a0a","hex")):image.toString("ascii",0,4)==="RIFF"&&image.toString("ascii",8,12)==="WEBP";
 if(!valid||image.length>2*1024*1024)return res.status(400).json({error:"فقط عکس JPG، PNG یا WebP تا ۲ مگابایت پذیرفته می‌شود"});
 const client=await pool.connect();try{
  await client.query("BEGIN");const car=await client.query("SELECT id FROM showroom_cars WHERE id=$1 FOR UPDATE",[req.params.id]);
  if(!car.rowCount){await client.query("ROLLBACK");return res.sendStatus(404)}
  const count=await client.query("SELECT count(*)::int AS n FROM showroom_photos WHERE car_id=$1",[req.params.id]);
  if(count.rows[0].n>=5){await client.query("ROLLBACK");return res.status(400).json({error:"برای هر خودرو حداکثر ۵ عکس ثبت می‌شود"})}
  const id=crypto.randomUUID();await client.query("INSERT INTO showroom_photos(id,car_id,mime,image) VALUES($1,$2,$3,$4)",[id,req.params.id,mime,image]);await client.query("COMMIT");
  await audit(req.user,"showroom_photo_create",id,{carId:req.params.id});res.status(201).json({id});
 }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e}finally{client.release()}
});
app.delete("/api/showroom/photos/:id",showroomWrite,async(req,res)=>{
 const r=await q("DELETE FROM showroom_photos WHERE id=$1 RETURNING car_id",[req.params.id]);if(!r.rowCount)return res.sendStatus(404);
 await audit(req.user,"showroom_photo_delete",req.params.id,{carId:r.rows[0].car_id});res.json({ok:true});
});
app.get("/api/showroom/withdrawals",async(req,res)=>{
 const r=await q('SELECT id,amount::text,description,happened_at AS "happenedAt" FROM showroom_withdrawals ORDER BY happened_at DESC,created_at DESC');
 res.json(r.rows.map(x=>({...x,amount:Number(x.amount)})));
});
app.post("/api/showroom/withdrawals",showroomWrite,async(req,res)=>{
 const amount=money(req.body.amount),description=short(req.body.description,1000),date=new Date(req.body.happenedAt);
 if(!amount||!description||Number.isNaN(date.getTime()))return res.status(400).json({error:"مبلغ، تاریخ و توضیح برداشت لازم است"});
 const id=crypto.randomUUID();await q("INSERT INTO showroom_withdrawals(id,amount,description,happened_at,actor_id) VALUES($1,$2,$3,$4,$5)",[id,amount,description,date.toISOString(),req.user.sub]);
 await audit(req.user,"showroom_withdrawal_create",id,{amount,description});res.status(201).json({id});
});
app.put("/api/showroom/withdrawals/:id",showroomWrite,async(req,res)=>{
 const amount=money(req.body.amount),description=short(req.body.description,1000),date=new Date(req.body.happenedAt);
 if(!amount||!description||Number.isNaN(date.getTime()))return res.status(400).json({error:"مبلغ، تاریخ و توضیح برداشت لازم است"});
 const r=await q("UPDATE showroom_withdrawals SET amount=$1,description=$2,happened_at=$3 WHERE id=$4 RETURNING id",[amount,description,date.toISOString(),req.params.id]);
 if(!r.rowCount)return res.sendStatus(404);await audit(req.user,"showroom_withdrawal_update",req.params.id,{amount,description});res.json({ok:true});
});
app.get("/api/showroom/leads",async(req,res)=>{
 const r=await q('SELECT l.id,l.car_id AS "carId",c.title AS "carTitle",l.customer_name AS "customerName",l.phone,l.status,l.next_followup AS "nextFollowup",l.notes,l.created_at AS "createdAt" FROM showroom_leads l LEFT JOIN showroom_cars c ON c.id=l.car_id ORDER BY l.created_at DESC');res.json(r.rows);
});
app.post("/api/showroom/leads",showroomWrite,async(req,res)=>{
 const name=short(req.body.customerName,120),phone=short(req.body.phone,40),status=req.body.status,carId=req.body.carId||null,notes=short(req.body.notes,1000),next=req.body.nextFollowup?new Date(req.body.nextFollowup):null;
 if(!name||!["followup","visit","negotiation","won","lost"].includes(status)||next&&Number.isNaN(next.getTime()))return res.status(400).json({error:"اطلاعات مشتری معتبر نیست"});
 if(carId){const car=await q("SELECT id FROM showroom_cars WHERE id=$1",[carId]);if(!car.rowCount)return res.status(400).json({error:"خودرو پیدا نشد"})}
 const id=crypto.randomUUID();await q("INSERT INTO showroom_leads(id,car_id,customer_name,phone,status,next_followup,notes) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,carId,name,phone,status,next,notes]);await audit(req.user,"showroom_lead_create",id);res.status(201).json({id});
});
app.put("/api/showroom/leads/:id",showroomWrite,async(req,res)=>{
 const name=short(req.body.customerName,120),phone=short(req.body.phone,40),status=req.body.status,carId=req.body.carId||null,notes=short(req.body.notes,1000),next=req.body.nextFollowup?new Date(req.body.nextFollowup):null;
 if(!name||!["followup","visit","negotiation","won","lost"].includes(status)||next&&Number.isNaN(next.getTime()))return res.status(400).json({error:"اطلاعات مشتری معتبر نیست"});
 if(carId){const car=await q("SELECT id FROM showroom_cars WHERE id=$1",[carId]);if(!car.rowCount)return res.status(400).json({error:"خودرو پیدا نشد"})}
 const r=await q("UPDATE showroom_leads SET car_id=$1,customer_name=$2,phone=$3,status=$4,next_followup=$5,notes=$6,updated_at=NOW() WHERE id=$7 RETURNING id",[carId,name,phone,status,next,notes,req.params.id]);if(!r.rowCount)return res.status(404).json({error:"مشتری پیدا نشد"});await audit(req.user,"showroom_lead_update",req.params.id);res.json({ok:true});
});
app.get("/api/showroom/deals",async(req,res)=>{
 const r=await q('SELECT d.id,d.car_id AS "carId",c.title AS "carTitle",d.sale_amount::text AS "saleAmount",d.acquisition_amount::text AS "acquisitionAmount",d.expense_amount::text AS "expenseAmount",d.commission_amount::text AS "commissionAmount",d.notes,d.happened_at AS "happenedAt" FROM showroom_deals d JOIN showroom_cars c ON c.id=d.car_id ORDER BY d.happened_at DESC');
 res.json(r.rows.map(x=>({...x,saleAmount:Number(x.saleAmount),acquisitionAmount:Number(x.acquisitionAmount),expenseAmount:Number(x.expenseAmount),commissionAmount:Number(x.commissionAmount)})));
});
app.post("/api/showroom/deals",showroomWrite,async(req,res)=>{
 const carId=req.body.carId,sale=money(req.body.saleAmount),acquisition=money(req.body.acquisitionAmount),expense=money(req.body.expenseAmount),commission=money(req.body.commissionAmount),notes=short(req.body.notes,1000);
 if(!carId||[sale,acquisition,expense,commission].some(x=>x===null))return res.status(400).json({error:"مبلغ‌های معامله معتبر نیست"});
 const car=await q("SELECT id FROM showroom_cars WHERE id=$1",[carId]);if(!car.rowCount)return res.status(400).json({error:"خودرو پیدا نشد"});
 const id=crypto.randomUUID();await q("INSERT INTO showroom_deals(id,car_id,sale_amount,acquisition_amount,expense_amount,commission_amount,notes) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,carId,sale,acquisition,expense,commission,notes]);await audit(req.user,"showroom_deal_create",id);res.status(201).json({id});
});
app.put("/api/showroom/deals/:id",showroomWrite,async(req,res)=>{
 const carId=req.body.carId,sale=money(req.body.saleAmount),acquisition=money(req.body.acquisitionAmount),expense=money(req.body.expenseAmount),commission=money(req.body.commissionAmount),notes=short(req.body.notes,1000);
 if(!carId||[sale,acquisition,expense,commission].some(x=>x===null))return res.status(400).json({error:"مبلغ‌های معامله معتبر نیست"});
 const car=await q("SELECT id FROM showroom_cars WHERE id=$1",[carId]);if(!car.rowCount)return res.status(400).json({error:"خودرو پیدا نشد"});
 const old=await q("SELECT * FROM showroom_deals WHERE id=$1",[req.params.id]);if(!old.rowCount)return res.status(404).json({error:"معامله پیدا نشد"});
 await q("UPDATE showroom_deals SET car_id=$1,sale_amount=$2,acquisition_amount=$3,expense_amount=$4,commission_amount=$5,notes=$6 WHERE id=$7",[carId,sale,acquisition,expense,commission,notes,req.params.id]);
 await audit(req.user,"showroom_deal_update",req.params.id,{before:old.rows[0],after:{carId,sale,acquisition,expense,commission,notes}});res.json({ok:true});
});
// Serve only browser assets. Never expose server source, archives or local files.
for(const asset of ["index.html","agency.html","app.js","showroom.js"]){
 app.get("/"+asset,(req,res)=>res.sendFile(path.join(__dirname,asset)));
}
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,"0.0.0.0",()=>console.log("Sheen Finance ready on",PORT));
async function connectDatabase(){
 try{await init();dbReady=true;dbErrorCode="";console.log("Database ready")}
 catch(e){dbReady=false;dbErrorCode=e.code||"DB_UNAVAILABLE";console.error("Database unavailable",dbErrorCode);setTimeout(connectDatabase,10000)}
}
connectDatabase();
