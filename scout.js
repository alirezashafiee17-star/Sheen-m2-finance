let scoutWatches=[],scoutListings=[],scoutScans=[],scoutTab='listings';
async function loadScout(){
 if(!currentUser?.scoutAccess)return;
 const data=await api('/scout');scoutWatches=data.watches;scoutListings=data.listings;scoutScans=data.scans;renderScout();
}
window.loadScout=loadScout;
const scoutNum=n=>new Intl.NumberFormat('fa-IR').format(Number(n)||0);
const scoutStatus={new:'جدید',saved:'ذخیره‌شده',contacted:'تماس گرفته شد',dismissed:'کنار گذاشته شد'};
function renderScout(){
 const active=scoutWatches.filter(w=>w.active),newCount=scoutListings.filter(l=>l.status==='new').length;
 $('#scoutMetrics').innerHTML=[['جست‌وجوی فعال',active.length],['آگهی جدید',newCount],['کل آگهی‌ها',scoutListings.length]].map(([label,n])=>`<div class="metric"><div class="label">${label}</div><div class="value">${scoutNum(n)}</div></div>`).join('');
 $$('.scout-tab').forEach(b=>b.classList.toggle('primary',b.dataset.scout===scoutTab));
 $('#scoutAdd').hidden=scoutTab!=='watches'||currentRole!=='owner';
 const list=$('#scoutRows');
 if(scoutTab==='watches')list.innerHTML=scoutWatches.map(w=>`<div class="showroom-row"><div><strong>${esc(w.name)}</strong><small>${esc(w.model)}${w.year?' · مدل '+scoutNum(w.year):''}${w.maxPrice?' · سقف '+toman(w.maxPrice):''}${w.maxMileage?' · کارکرد تا '+scoutNum(w.maxMileage):''}<br>${esc(w.city||'کل ایران')}${w.requiredFeatures?' · '+esc(w.requiredFeatures):''} · ${w.active?'فعال':'متوقف'}</small></div>${currentRole==='owner'&&w.active?`<button class="danger" data-scout-stop="${esc(w.id)}">توقف</button>`:''}</div>`).join('')||'<div class="empty">جست‌وجویی ثبت نشده است.</div>';
 else if(scoutTab==='listings')list.innerHTML=scoutListings.map(l=>`<div class="scout-listing"><div class="between"><strong>${esc(l.title)}</strong><span class="role-badge">${esc(scoutStatus[l.status]||l.status)}</span></div><div class="meta">${esc(l.source)} · ${esc(l.city||'شهر نامشخص')} · ${l.year?scoutNum(l.year)+' · ':''}${l.mileage?scoutNum(l.mileage)+' کیلومتر · ':''}${l.price?toman(l.price):'قیمت نامشخص'} · ${fmtDate(l.foundAt)}</div>${l.note?`<p class="scout-note">${esc(l.note)}</p>`:''}<div class="scout-actions"><a class="primary" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">آگهی اصلی ↗</a><select data-scout-status="${esc(l.id)}"><option value="new" ${l.status==='new'?'selected':''}>جدید</option><option value="saved" ${l.status==='saved'?'selected':''}>ذخیره</option><option value="contacted" ${l.status==='contacted'?'selected':''}>تماس گرفته شد</option><option value="dismissed" ${l.status==='dismissed'?'selected':''}>کنار گذاشته شد</option></select></div></div>`).join('')||'<div class="empty">هنوز آگهی مطابق ثبت نشده است.</div>';
 else list.innerHTML=scoutScans.map(s=>`<div class="showroom-row"><div><strong>${esc(scoutWatches.find(w=>w.id===s.watchId)?.name||'جست‌وجو')} · ${fmtDate(s.finishedAt)}</strong><small>${s.status==='partial'?'بررسی ناقص':s.status==='complete'?'کامل':'ناموفق'} · ${scoutNum(s.checkedCount)} مورد بررسی · ${scoutNum(s.savedCount)} مورد ذخیره<br>${esc(s.detail)}</small></div></div>`).join('')||'<div class="empty">هنوز گزارشی ثبت نشده است.</div>';
 $$('[data-scout-stop]').forEach(b=>b.onclick=async()=>{if(!confirm('این جست‌وجو متوقف شود؟'))return;try{await api('/scout/watches/'+encodeURIComponent(b.dataset.scoutStop),{method:'DELETE'});await loadScout()}catch(e){toast(e.message)}});
 $$('[data-scout-status]').forEach(s=>s.onchange=async()=>{try{await api('/scout/listings/'+encodeURIComponent(s.dataset.scoutStatus),{method:'PATCH',body:JSON.stringify({status:s.value})});await loadScout()}catch(e){toast(e.message)}});
}
$$('.scout-tab').forEach(b=>b.onclick=()=>{scoutTab=b.dataset.scout;renderScout()});
$('#scoutAdd').onclick=()=>$('#scoutModal').showModal();
$('#closeScout').onclick=()=>$('#scoutModal').close();
$('#scoutSave').onclick=async()=>{
 const name=$('#scoutName').value.trim(),model=$('#scoutModel').value.trim();if(!name||!model)return toast('نام و مدل را وارد کن');
 const payload={name,model,year:normalizeDigits($('#scoutYear').value),maxPrice:parseMoney($('#scoutPrice').value),maxMileage:parseMoney($('#scoutMileage').value),city:$('#scoutCity').value.trim(),requiredFeatures:$('#scoutFeatures').value.trim()};
 try{await api('/scout/watches',{method:'POST',body:JSON.stringify(payload)});$('#scoutModal').close();$('#scoutModal').querySelectorAll('input').forEach(x=>x.value='');await loadScout();toast('جست‌وجو ثبت شد')}catch(e){toast(e.message)}
};
