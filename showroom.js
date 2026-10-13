let showroomCars=[],showroomLeads=[],showroomDeals=[],showroomTab="cars",showroomEditing=null;
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
 [showroomCars,showroomLeads,showroomDeals]=await Promise.all([api("/showroom/cars"),api("/showroom/leads"),api("/showroom/deals")]);
 renderShowroom();
}
window.loadShowroom=loadShowroom;
function renderShowroom(){
 const available=showroomCars.filter(c=>c.status==="available").length;
 $("#showroomMetrics").innerHTML=[["خودروهای موجود",available],["مشتری‌ها",showroomLeads.length],["معامله‌ها",showroomDeals.length]].map(([label,value])=>`<div class="metric"><div class="label">${label}</div><div class="value">${new Intl.NumberFormat("fa-IR").format(value)}</div></div>`).join("");
 const titles={cars:"پروندهٔ خودروها",leads:"مشتری‌ها و پیگیری‌ها",deals:"معامله‌ها و سود نمایشگاه"};
 $("#showroomTitle").textContent=titles[showroomTab];
 $("#showroomAdd").style.display=currentUser?.showroomEdit?"":"none";
 $$(".showroom-tab").forEach(b=>b.classList.toggle("primary",b.dataset.showroom===showroomTab));
 let html="";
 if(showroomTab==="cars")html=showroomCars.map(c=>`<div class="showroom-row"><div><strong>${esc(c.title)} ${esc(c.year)}</strong><small>${esc(ownerType[c.ownership])} · ${esc(carStatus[c.status])} · ${esc(c.paint||"وضعیت بدنه ثبت نشده")}<br>کارکرد ${new Intl.NumberFormat("fa-IR").format(c.mileage)} · قیمت پیشنهادی ${toman(c.askingPrice)}</small></div>${currentUser.showroomEdit?`<button class="edit" data-car="${c.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="leads")html=showroomLeads.map(l=>`<div class="showroom-row"><div><strong>${esc(l.customerName)}</strong><small>${esc(l.carTitle||"بدون خودرو")} · ${esc(leadStatus[l.status])}<br>${l.nextFollowup?"پیگیری: "+fmtDate(l.nextFollowup):"زمان پیگیری تعیین نشده"} ${l.phone?" · "+esc(l.phone):""}</small></div>${currentUser.showroomEdit?`<button class="edit" data-lead="${l.id}">ویرایش</button>`:""}</div>`).join("");
 if(showroomTab==="deals")html=showroomDeals.map(d=>`<div class="showroom-row"><div><strong>${esc(d.carTitle)}</strong><small>فروش ${toman(d.saleAmount)} · خرید/تسویه ${toman(d.acquisitionAmount)}<br>هزینه ${toman(d.expenseAmount)} · کمیسیون جداگانه ${toman(d.commissionAmount)}<br>سود نمایشگاه: ${toman(d.saleAmount-d.acquisitionAmount-d.expenseAmount+d.commissionAmount)}</small></div>${currentUser.showroomEdit?`<button class="edit" data-deal="${d.id}">ویرایش</button>`:""}</div>`).join("");
 $("#showroomRows").innerHTML=html||'<div class="empty">هنوز موردی ثبت نشده است.</div>';
 $$("[data-car]").forEach(b=>b.onclick=()=>openShowroom("cars",showroomCars.find(c=>c.id===b.dataset.car)));
 $$("[data-lead]").forEach(b=>b.onclick=()=>openShowroom("leads",showroomLeads.find(l=>l.id===b.dataset.lead)));
 $$("[data-deal]").forEach(b=>b.onclick=()=>openShowroom("deals",showroomDeals.find(d=>d.id===b.dataset.deal)));
}
function fld(name,label,value="",type="text",extra=""){return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`}
function sel(name,label,options,value){return `<label class="field">${label}<select name="${name}">${options.map(([key,text])=>`<option value="${esc(key)}" ${key===value?"selected":""}>${esc(text)}</option>`).join("")}</select></label>`}
function carOptions(value){return [["","انتخاب خودرو"],...showroomCars.map(c=>[c.id,c.title+" "+c.year])].map(([key,label])=>`<option value="${esc(key)}" ${key===value?"selected":""}>${esc(label)}</option>`).join("")}
function openShowroom(type,item=null){
 if(!currentUser?.showroomEdit)return;
 showroomEditing=item;showroomTab=type;
 $("#showroomModalTitle").textContent=(item?"ویرایش ":"ثبت ")+({cars:"خودرو",leads:"مشتری",deals:"معامله"}[type]);
 let fields="";
 if(type==="cars")fields=fld("title","نام خودرو",item?.title,"text","required maxlength=120")+fld("year","مدل سال",item?.year)+fld("mileage","کارکرد کیلومتر",item?.mileage||0,"number","required min=0")+fld("paint","وضعیت رنگ و بدنه",item?.paint)+sel("ownership","نوع مالکیت",Object.entries(ownerType),item?.ownership||"consignment")+sel("status","وضعیت",Object.entries(carStatus),item?.status||"available")+fld("askingPrice","قیمت پیشنهادی (تومان)",item?.askingPrice||0,"number","required min=0")+fld("ownerName","نام مالک خودرو",item?.ownerName)+fld("notes","توضیحات",item?.notes);
 if(type==="leads")fields=fld("customerName","نام مشتری",item?.customerName,"text","required")+fld("phone","شماره تماس",item?.phone,"tel")+ `<label class="field">خودروی موردنظر<select name="carId">${carOptions(item?.carId||"")}</select></label>`+sel("status","وضعیت پیگیری",Object.entries(leadStatus),item?.status||"followup")+fld("nextFollowup","زمان پیگیری بعدی",item?.nextFollowup?localDT(item.nextFollowup):"","datetime-local")+fld("notes","توضیحات",item?.notes);
 if(type==="deals")fields=`<label class="field">خودرو<select name="carId" required>${carOptions(item?.carId||"")}</select></label>`+fld("saleAmount","مبلغ فروش (تومان)",item?.saleAmount||0,"number","required min=0")+fld("acquisitionAmount","قیمت خرید یا تسویه با مالک (تومان)",item?.acquisitionAmount||0,"number","required min=0")+fld("expenseAmount","هزینه‌ها (تومان)",item?.expenseAmount||0,"number","required min=0")+fld("commissionAmount","کمیسیون دریافتی جداگانه (تومان)",item?.commissionAmount||0,"number","required min=0")+fld("notes","توضیحات",item?.notes||"");
 $("#showroomForm").innerHTML=fields+'<button class="primary save" type="submit">ذخیره</button>';
 $("#showroomModal").showModal();
}
$("#showroomForm").onsubmit=async e=>{
 e.preventDefault();const data=Object.fromEntries(new FormData(e.target));
 for(const key of ["mileage","askingPrice","saleAmount","acquisitionAmount","expenseAmount","commissionAmount"])if(key in data)data[key]=Number(data[key]);
 if(data.nextFollowup)data.nextFollowup=new Date(data.nextFollowup).toISOString();
 try{await api("/showroom/"+showroomTab+(showroomEditing?"/"+showroomEditing.id:""),{method:showroomEditing?"PUT":"POST",body:JSON.stringify(data)});$("#showroomModal").close();await loadShowroom();toast("اطلاعات نمایشگاه ذخیره شد")}catch(error){toast(error.message)}
};
$("#closeShowroom").onclick=()=>$("#showroomModal").close();
$("#showroomAdd").onclick=()=>openShowroom(showroomTab);
$$(".showroom-tab").forEach(b=>b.onclick=()=>{showroomTab=b.dataset.showroom;renderShowroom()});
$("#financeModule").onclick=()=>showModule("finance");
$("#showroomModule").onclick=()=>showModule("showroom");
