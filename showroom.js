let showroomCars=[],showroomLeads=[],showroomDeals=[],showroomWithdrawals=[],showroomPhotos=[],showroomPhotoUrls=new Map(),showroomTab="cars",showroomEditing=null;
const carStatus={available:"موجود",reserved:"رزرو",inspection:"در حال کارشناسی",sold:"فروخته‌شده",settled:"تسویه‌شده"};
const leadStatus={followup:"پیگیری",visit:"هماهنگی بازدید",negotiation:"مذاکره",won:"خرید انجام شد",lost:"انصراف"};
const ownerType={owned:"خرید نمایشگاه",consignment:"امانی"};
function showModule(module){
 if(!currentUser)return;
 if(module==="finance"&&!currentUser.financeAccess||module==="showroom"&&!currentUser.showroomAccess)return;
 $("#modulePicker").hidden=!(currentUser.financeAccess&&currentUser.showroomAccess);
 $("#financeArea").hidden=module!=="finance";
 $("#showroomArea").hidden=module!=="showroom";
 $("#financeNav").hidden=module!=="finance";
 $("#add").hidden=module!=="finance";
 $(".header .brand span").textContent=module==="finance"?"FINANCE":"GALLERY";
 document.title=module==="finance"?"Sheen Finance":"Sheen Gallery";
 $("#financeModule").className=module==="finance"?"primary":"ghost";
 $("#showroomModule").className=module==="showroom"?"primary":"ghost";
}
window.showModule=showModule;
async function loadShowroom(){
 [showroomCars,showroomLeads,showroomDeals,showroomWithdrawals,showroomPhotos]=await Promise.all([api("/showroom/cars"),api("/showroom/leads"),api("/showroom/deals"),api("/showroom/withdrawals"),api("/showroom/photos")]);
 renderShowroom();await loadShowroomPhotos();
}
window.loadShowroom=loadShowroom;
function renderShowroom(){
 const available=showroomCars.filter(c=>c.status==="available").length;
 $("#showroomMetrics").innerHTML=[["خودروهای موجود",available],["مشتری‌ها",showroomLeads.length],["معامله‌ها",showroomDeals.length]].map(([label,value])=>`<div class="metric"><div class="label">${label}</div><div class="value">${new Intl.NumberFormat("fa-IR").format(value)}</div></div>`).join("");
 const titles={cars:"پروندهٔ خودروها",leads:"مشتری‌ها و پیگیری‌ها",deals:"معامله‌ها و سود نمایشگاه",withdrawals:"برداشت‌های نمایشگاه",report:"سند مالی نمایشگاه"};
 $("#showroomTitle").textContent=titles[showroomTab];
 $("#showroomAdd").style.display=currentUser?.showroomEdit&&showroomTab!=="report"?"":"none";
 $("#showroomListPanel").hidden=showroomTab==="report";$("#showroomReport").hidden=showroomTab!=="report";$("#showroomPrintActions").hidden=showroomTab!=="report";
 $$(".showroom-tab").forEach(b=>b.classList.toggle("primary",b.dataset.showroom===showroomTab));
 let html="";
 if(showroomTab==="cars")html=showroomCars.map(c=>`<div class="showroom-row"><div><strong>${esc(c.title)} ${esc(c.year)}</strong><small>${esc(ownerType[c.ownership])} · ${esc(carStatus[c.status])} · ${esc(c.paint||"وضعیت بدنه ثبت نشده")}<br>کارکرد ${new Intl.NumberFormat("fa-IR").format(c.mileage)} · قیمت پیشنهادی ${toman(c.askingPrice)}</small>${carPhotoHTML(c.id)}</div>${currentUser.showroomEdit?`<button class="edit" data-car="${c.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="leads")html=showroomLeads.map(l=>`<div class="showroom-row"><div><strong>${esc(l.customerName)}</strong><small>${esc(l.carTitle||"بدون خودرو")} · ${esc(leadStatus[l.status])}<br>${l.nextFollowup?"پیگیری: "+fmtDate(l.nextFollowup):"زمان پیگیری تعیین نشده"} ${l.phone?" · "+esc(l.phone):""}</small></div>${currentUser.showroomEdit?`<button class="edit" data-lead="${l.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="deals")html=showroomDeals.map(d=>`<div class="showroom-row"><div><strong>${esc(d.carTitle)}</strong><small>فروش ${toman(d.saleAmount)} · خرید/تسویه ${toman(d.acquisitionAmount)}<br>هزینه ${toman(d.expenseAmount)} · کمیسیون جداگانه ${toman(d.commissionAmount)}<br>سود نمایشگاه: ${toman(d.saleAmount-d.acquisitionAmount-d.expenseAmount+d.commissionAmount)}</small></div>${currentUser.showroomEdit?`<button class="edit" data-deal="${d.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="withdrawals")html=showroomWithdrawals.map(w=>`<div class="showroom-row"><div><strong>${toman(w.amount)}</strong><small>${fmtDate(w.happenedAt)} · ${esc(w.description)}</small></div>${currentUser.showroomEdit?`<button class="edit" data-withdrawal="${w.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="report")renderShowroomReport();
 $("#showroomRows").innerHTML=html||'<div class="empty">هنوز موردی ثبت نشده است.</div>';
 $$("[data-car]").forEach(b=>b.onclick=()=>openShowroom("cars",showroomCars.find(c=>c.id===b.dataset.car)));
 $$("[data-lead]").forEach(b=>b.onclick=()=>openShowroom("leads",showroomLeads.find(l=>l.id===b.dataset.lead)));
 $$("[data-deal]").forEach(b=>b.onclick=()=>openShowroom("deals",showroomDeals.find(d=>d.id===b.dataset.deal)));
 $$("[data-withdrawal]").forEach(b=>b.onclick=()=>openShowroom("withdrawals",showroomWithdrawals.find(w=>w.id===b.dataset.withdrawal)));
}
function fld(name,label,value="",type="text",extra=""){return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`}
function sel(name,label,options,value){return `<label class="field">${label}<select name="${name}">${options.map(([key,text])=>`<option value="${esc(key)}" ${key===value?"selected":""}>${esc(text)}</option>`).join("")}</select></label>`}
function carOptions(value){return [["","انتخاب خودرو"],...showroomCars.map(c=>[c.id,c.title+" "+c.year])].map(([key,label])=>`<option value="${esc(key)}" ${key===value?"selected":""}>${esc(label)}</option>`).join("")}
function openShowroom(type,item=null){
 if(!currentUser?.showroomEdit)return;
 showroomEditing=item;showroomTab=type;
 $("#showroomModalTitle").textContent=(item?"ویرایش ":"ثبت ")+({cars:"خودرو",leads:"مشتری",deals:"معامله",withdrawals:"برداشت"}[type]);
 let fields="";
 if(type==="cars")fields=fld("title","نام خودرو",item?.title,"text","required maxlength=120")+fld("year","مدل سال",item?.year)+fld("mileage","کارکرد کیلومتر",item?.mileage||0,"number","required min=0")+fld("paint","وضعیت رنگ و بدنه",item?.paint)+sel("ownership","نوع مالکیت",Object.entries(ownerType),item?.ownership||"consignment")+sel("status","وضعیت",Object.entries(carStatus),item?.status||"available")+fld("askingPrice","قیمت پیشنهادی (تومان)",item?.askingPrice||0,"number","required min=0")+fld("ownerName","نام مالک خودرو",item?.ownerName)+fld("notes","توضیحات",item?.notes);
 if(type==="leads")fields=fld("customerName","نام مشتری",item?.customerName,"text","required")+fld("phone","شماره تماس",item?.phone,"tel")+ `<label class="field">خودروی موردنظر<select name="carId">${carOptions(item?.carId||"")}</select></label>`+sel("status","وضعیت پیگیری",Object.entries(leadStatus),item?.status||"followup")+fld("nextFollowup","زمان پیگیری بعدی",item?.nextFollowup?localDT(item.nextFollowup):"","datetime-local")+fld("notes","توضیحات",item?.notes);
 if(type==="withdrawals")fields=fld("amount","مبلغ برداشت (تومان)",item?.amount||"","number","required min=1")+fld("happenedAt","تاریخ و ساعت",item?.happenedAt?localDT(item.happenedAt):localDT(),"datetime-local","required")+fld("description","توضیح برداشت",item?.description||"","text","required maxlength=1000");
 if(type==="deals")fields=`<label class="field">خودرو<select name="carId" required>${carOptions(item?.carId||"")}</select></label>`+fld("saleAmount","مبلغ فروش (تومان)",item?.saleAmount||0,"number","required min=0")+fld("acquisitionAmount","قیمت خرید یا تسویه با مالک (تومان)",item?.acquisitionAmount||0,"number","required min=0")+fld("expenseAmount","هزینه‌ها (تومان)",item?.expenseAmount||0,"number","required min=0")+fld("commissionAmount","کمیسیون دریافتی جداگانه (تومان)",item?.commissionAmount||0,"number","required min=0")+fld("notes","توضیحات",item?.notes||"");
 $("#showroomForm").innerHTML=fields+(type==="cars"&&item?`<label class="field">افزودن عکس (تا ۵ عکس، هر کدام حداکثر ۲ مگابایت)<input id="carPhotoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><div id="photoManager" class="photo-manager"></div>`:type==="cars"?'<small class="money-hint">پس از ذخیرهٔ خودرو می‌توانید عکس‌های آن را اضافه کنید.</small>':"")+'<button class="primary save" type="submit">ذخیره</button>';
 $("#showroomModal").showModal();
 if(type==="cars"&&item){renderPhotoManager(item.id);$("#carPhotoInput").onchange=e=>uploadCarPhotos(item.id,e.target.files)}
}
$("#showroomForm").onsubmit=async e=>{
 e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
 for(const key of ["mileage","askingPrice","saleAmount","acquisitionAmount","expenseAmount","commissionAmount","amount"])if(key in data)data[key]=Number(data[key]);
 if(data.nextFollowup)data.nextFollowup=new Date(data.nextFollowup).toISOString();
 if(data.happenedAt)data.happenedAt=new Date(data.happenedAt).toISOString();
 try{const type=showroomTab,wasNew=!showroomEditing,result=await api("/showroom/"+type+(showroomEditing?"/"+showroomEditing.id:""),{method:showroomEditing?"PUT":"POST",body:JSON.stringify(data)});$("#showroomModal").close();await loadShowroom();if(type==="cars"&&wasNew)openShowroom("cars",showroomCars.find(c=>c.id===result.id));toast(wasNew&&type==="cars"?"خودرو ذخیره شد؛ عکس‌های آن را اضافه کنید":"اطلاعات نمایشگاه ذخیره شد")}catch(error){toast(error.message)}
};
$("#closeShowroom").onclick=()=>$("#showroomModal").close();
$("#showroomAdd").onclick=()=>openShowroom(showroomTab);
$$(".showroom-tab").forEach(b=>b.onclick=()=>{showroomTab=b.dataset.showroom;renderShowroom()});
$("#financeModule").onclick=()=>showModule("finance");
$("#showroomModule").onclick=()=>showModule("showroom");
$("#printShowroom").onclick=()=>{document.body.classList.add("print-showroom");window.print()};
window.addEventListener("afterprint",()=>document.body.classList.remove("print-showroom"));
function carPhotoHTML(carId){
 const photos=showroomPhotos.filter(p=>p.carId===carId&&showroomPhotoUrls.has(p.id));
 return photos.length?`<div class="car-photos">${photos.map(p=>`<img src="${showroomPhotoUrls.get(p.id)}" alt="عکس خودرو" loading="lazy">`).join("")}</div>`:"";
}
async function loadShowroomPhotos(){
 for(const url of showroomPhotoUrls.values())URL.revokeObjectURL(url);
 showroomPhotoUrls.clear();
 await Promise.all(showroomPhotos.map(async p=>{
  try{const r=await fetch("/api/showroom/photos/"+p.id,{headers:{Authorization:"Bearer "+token}});
   if(r.ok)showroomPhotoUrls.set(p.id,URL.createObjectURL(await r.blob()));
  }catch{}
 }));
 renderShowroom();
 if($("#showroomModal").open&&showroomTab==="cars"&&showroomEditing)renderPhotoManager(showroomEditing.id);
}
window.clearShowroomPhotos=()=>{for(const url of showroomPhotoUrls.values())URL.revokeObjectURL(url);showroomPhotoUrls.clear();showroomPhotos=[]};
function renderPhotoManager(carId){
 const box=$("#photoManager");if(!box)return;
 box.innerHTML=showroomPhotos.filter(p=>p.carId===carId).map(p=>`<div><img src="${showroomPhotoUrls.get(p.id)||""}" alt="عکس خودرو"><button type="button" class="danger" data-delete-photo="${p.id}">حذف عکس</button></div>`).join("");
 box.querySelectorAll("[data-delete-photo]").forEach(b=>b.onclick=async()=>{
  if(!confirm("این عکس حذف شود؟"))return;
  try{await api("/showroom/photos/"+b.dataset.deletePhoto,{method:"DELETE"});await loadShowroom();renderPhotoManager(carId);toast("عکس حذف شد")}catch(e){toast(e.message)}
 });
}
async function compressPhoto(file){
 if(!["image/jpeg","image/png","image/webp"].includes(file.type))throw Error("فرمت عکس پذیرفته نمی‌شود");
 const bitmap=await createImageBitmap(file),scale=Math.min(1,1500/Math.max(bitmap.width,bitmap.height));
 const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
 canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/jpeg",.82));
 if(!blob||blob.size>2*1024*1024)throw Error("عکس بیش از ۲ مگابایت است");
 return {mime:"image/jpeg",data:(await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(blob)})).split(",")[1]};
}
async function uploadCarPhotos(carId,files){
 const selected=[...files];if(selected.length+showroomPhotos.filter(p=>p.carId===carId).length>5)return toast("برای هر خودرو حداکثر ۵ عکس مجاز است");
 const input=$("#carPhotoInput");input.disabled=true;
 try{for(const file of selected){const photo=await compressPhoto(file);await api("/showroom/cars/"+carId+"/photos",{method:"POST",body:JSON.stringify(photo)})}await loadShowroom();renderPhotoManager(carId);toast("عکس‌ها ذخیره شدند")}
 catch(e){await loadShowroom();renderPhotoManager(carId);toast(e.message)}
 finally{input.disabled=false;input.value=""}
}
function renderShowroomReport(){
 const profit=d=>d.saleAmount-d.acquisitionAmount-d.expenseAmount+d.commissionAmount;
 const sumProfit=showroomDeals.reduce((s,d)=>s+profit(d),0),withdrawn=showroomWithdrawals.reduce((s,w)=>s+w.amount,0);
 $("#showroomReportRows").innerHTML=`<div class="meta">تاریخ صدور: ${fmtDate(new Date())}</div>`+
  showroomDeals.map(d=>`<div class="report-row"><span>معاملهٔ ${esc(d.carTitle)}<br><small>${fmtDate(d.happenedAt)} · فروش ${toman(d.saleAmount)} · خرید/تسویه ${toman(d.acquisitionAmount)} · هزینه ${toman(d.expenseAmount)} · کمیسیون ${toman(d.commissionAmount)}</small></span><strong>${toman(profit(d))}</strong></div>`).join("")+
  showroomWithdrawals.map(w=>`<div class="report-row"><span>برداشت · ${esc(w.description)}<br><small>${fmtDate(w.happenedAt)}</small></span><strong>− ${toman(w.amount)}</strong></div>`).join("")+
  `<div class="goldline"></div><div class="report-row"><span>جمع سود معامله‌ها</span><strong>${toman(sumProfit)}</strong></div><div class="report-row"><span>جمع برداشت‌ها</span><strong>${toman(withdrawn)}</strong></div><div class="report-row"><span>مانده پس از برداشت</span><strong>${toman(sumProfit-withdrawn)}</strong></div>`;
}
