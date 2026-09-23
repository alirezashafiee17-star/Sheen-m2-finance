const express=require("express");
const path=require("path");
const crypto=require("crypto");
const bcrypt=require("bcryptjs");
const jwt=require("jsonwebtoken");
const {Pool}=require("pg");
const helmet=require("helmet");
const compression=require("compression");
const rateLimit=require("express-rate-limit");

const app=express();
app.set("trust proxy",1);
app.use(helmet({contentSecurityPolicy:false}));
app.use(compression());
app.use(express.json({limit:"2mb"}));
app.use("/api/auth",rateLimit({windowMs:15*60*1000,max:30,standardHeaders:true,legacyHeaders:false}));

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
const q=(text,params=[])=>pool.query(text,params);\nlet dbReady=false;\nlet dbErrorCode="STARTING";
const cleanEmail=v=>String(v||"").trim().toLowerCase();
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
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
 );`);
 const existing=await q("SELECT id FROM users WHERE email=$1",[OWNER_EMAIL]);
 const hash=await bcrypt.hash(OWNER_PASSWORD,12);
 if(!existing.rowCount) await q("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,'owner')",[crypto.randomUUID(),"علیرضا شفیعی",OWNER_EMAIL,hash]);
 else await q("UPDATE users SET role='owner',active=true WHERE email=$1",[OWNER_EMAIL]);
}
function auth(req,res,next){
 const token=(req.headers.authorization||"").replace(/^Bearer\s+/i,"");
 try{req.user=jwt.verify(token,JWT_SECRET);next()}catch{return res.status(401).json({error:"نیاز به ورود مجدد"})}
}
const allow=(...roles)=>(req,res,next)=>roles.includes(req.user.role)?next():res.status(403).json({error:"دسترسی کافی ندارید"});
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
app.get("/api/health",async(req,res)=>{try{await q("SELECT 1");dbReady=true;dbErrorCode="";res.json({ok:true})}catch(e){dbReady=false;dbErrorCode=e.code||"DB_UNAVAILABLE";res.status(503).json({ok:false,code:dbErrorCode})}});\napp.use("/api",(req,res,next)=>dbReady?next():res.status(503).json({error:"پایگاه داده در حال اتصال است",code:dbErrorCode}));
app.post("/api/auth/login",async(req,res)=>{
 const email=cleanEmail(req.body.email),password=String(req.body.password||"");
 const r=await q("SELECT * FROM users WHERE email=$1 AND active=true",[email]);
 if(!r.rowCount||!await bcrypt.compare(password,r.rows[0].password_hash)) return res.status(401).json({error:"ایمیل یا رمز عبور اشتباه است"});
 res.json({token:sign(r.rows[0]),user:publicUser(r.rows[0])});
});
app.get("/api/me",auth,async(req,res)=>{const r=await q("SELECT * FROM users WHERE id=$1 AND active=true",[req.user.sub]);if(!r.rowCount)return res.status(401).json({error:"حساب غیرفعال است"});res.json(publicUser(r.rows[0]))});
app.get("/api/transactions",auth,async(req,res)=>{
 await closePastPeriods();
 const r=await q("SELECT id,kind,amount::text,description AS desc,happened_at AS date,period,actor_name AS \"actorName\",actor_email AS \"actorEmail\" FROM transactions ORDER BY happened_at DESC");
 res.json(r.rows.map(x=>({...x,amount:Number(x.amount)})));
});
app.post("/api/transactions",auth,allow("owner","admin"),async(req,res)=>{
 const amount=Math.trunc(Number(req.body.amount)),kind=req.body.kind,desc=String(req.body.desc||"").trim(),date=new Date(req.body.date),period=periodOf(req.body.date);
 if(!amount||amount<1||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))return res.status(400).json({error:"اطلاعات تراکنش کامل نیست"});
 const pr=await q("SELECT closed FROM periods WHERE period=$1",[period]);if(req.user.role!=="owner"&&period!==currentPeriod()&&pr.rows[0]?.closed!==false)return res.status(403).json({error:"این ماه بسته شده است"});
 const u=await q("SELECT name,email FROM users WHERE id=$1",[req.user.sub]),id=crypto.randomUUID();
 await q("INSERT INTO transactions(id,kind,amount,description,happened_at,period,actor_id,actor_name,actor_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[id,kind,amount,desc,date.toISOString(),period,req.user.sub,u.rows[0].name,u.rows[0].email]);
 await audit(req.user,"create_transaction",id,{amount,kind,desc,date:req.body.date});res.status(201).json({id});
});
app.put("/api/transactions/:id",auth,allow("owner","admin"),async(req,res)=>{
 const old=await q("SELECT * FROM transactions WHERE id=$1",[req.params.id]);if(!old.rowCount)return res.status(404).json({error:"تراکنش پیدا نشد"});
 if(req.user.role!=="owner"&&(old.rows[0].period!==currentPeriod()||(await q("SELECT closed FROM periods WHERE period=$1",[old.rows[0].period])).rows[0]?.closed))return res.status(403).json({error:"ماه بسته شده است"});
 const amount=Math.trunc(Number(req.body.amount)),kind=req.body.kind,desc=String(req.body.desc||"").trim(),date=new Date(req.body.date),period=periodOf(req.body.date);
 if(!amount||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))return res.status(400).json({error:"اطلاعات نامعتبر"});
 await q("UPDATE transactions SET kind=$1,amount=$2,description=$3,happened_at=$4,period=$5,updated_at=NOW() WHERE id=$6",[kind,amount,desc,date.toISOString(),period,req.params.id]);
 await audit(req.user,"update_transaction",req.params.id,{amount,kind,desc,date:req.body.date});res.json({ok:true});
});
app.get("/api/periods",auth,async(req,res)=>{await closePastPeriods();const r=await q("SELECT period,closed FROM periods");res.json(Object.fromEntries(r.rows.map(x=>[x.period,x])))});
app.get("/api/members",auth,allow("owner"),async(req,res)=>{const r=await q("SELECT id,name,email,role,active FROM users WHERE role<>'owner' ORDER BY created_at");res.json(r.rows)});
app.post("/api/members",auth,allow("owner"),async(req,res)=>{
 const name=String(req.body.name||"").trim(),email=cleanEmail(req.body.email),role=req.body.role,password=String(req.body.password||"");
 if(!name||!/^\S+@\S+\.\S+$/.test(email)||!["admin","viewer"].includes(role)||password.length<8)return res.status(400).json({error:"نام، ایمیل و رمز حداقل ۸ حرف لازم است"});
 const hash=await bcrypt.hash(password,12),id=crypto.randomUUID();
 try{await q("INSERT INTO users(id,name,email,password_hash,role) VALUES($1,$2,$3,$4,$5)",[id,name,email,hash,role])}catch(e){if(e.code==="23505")return res.status(409).json({error:"این ایمیل قبلاً ثبت شده"});throw e}
 await audit(req.user,"add_member",email,{name,role});res.status(201).json({id});
});
app.put("/api/members/:id",auth,allow("owner"),async(req,res)=>{
 const name=String(req.body.name||"").trim(),role=req.body.role,password=String(req.body.password||"");
 if(!name||!["admin","viewer"].includes(role))return res.status(400).json({error:"اطلاعات عضو نامعتبر است"});
 if(password){if(password.length<8)return res.status(400).json({error:"رمز باید حداقل ۸ حرف باشد"});await q("UPDATE users SET name=$1,role=$2,password_hash=$3,updated_at=NOW() WHERE id=$4 AND role<>'owner'",[name,role,await bcrypt.hash(password,12),req.params.id])}
 else await q("UPDATE users SET name=$1,role=$2,updated_at=NOW() WHERE id=$3 AND role<>'owner'",[name,role,req.params.id]);
 await audit(req.user,"update_member",req.params.id,{name,role});res.json({ok:true});
});
app.delete("/api/members/:id",auth,allow("owner"),async(req,res)=>{await q("UPDATE users SET active=false,updated_at=NOW() WHERE id=$1 AND role<>'owner'",[req.params.id]);await audit(req.user,"disable_member",req.params.id);res.json({ok:true})});
app.post("/api/import",auth,allow("owner"),async(req,res)=>{
 const items=Array.isArray(req.body)?req.body.slice(0,5000):[];let count=0;
 for(const x of items){const amount=Math.trunc(Number(x.amount)),kind=x.kind,desc=String(x.desc||"").trim(),date=new Date(x.date),period=periodOf(x.date);if(!amount||!["income","expense","withdrawal"].includes(kind)||!desc||!period||Number.isNaN(date.getTime()))continue;const id=String(x.id||crypto.randomUUID()).replace(/[^a-f0-9-]/gi,"").slice(0,36);const safeId=/^[0-9a-f]{8}-/.test(id)?id:crypto.randomUUID();await q("INSERT INTO transactions(id,kind,amount,description,happened_at,period,actor_id,actor_name,actor_email) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING",[safeId,kind,amount,desc,date.toISOString(),period,req.user.sub,"مالک",OWNER_EMAIL]);count++}
 await audit(req.user,"import_transactions","bulk",{count});res.json({count});
});
app.use(express.static(path.join(__dirname)));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.listen(PORT,"0.0.0.0",()=>console.log("Sheen Finance ready on",PORT));\nasync function connectDatabase(){\n try{await init();dbReady=true;dbErrorCode="";console.log("Database ready")}\n catch(e){dbReady=false;dbErrorCode=e.code||"DB_UNAVAILABLE";console.error("Database unavailable",dbErrorCode);setTimeout(connectDatabase,10000)}\n}\nconnectDatabase();
