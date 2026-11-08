(()=>{
 const root=document.getElementById('receptionArea');if(!root)return;
 const $r=id=>document.getElementById(id),labels={received:'پذیرش‌شده',working:'در حال انجام',ready:'آماده تحویل',delivered:'تحویل‌شده'},next={received:'working',working:'ready',ready:'delivered'};
 const num=v=>new Intl.NumberFormat('fa-IR',{useGrouping:false}).format(v),writable=()=>!!currentUser?.receptionEdit;
 let data=null,page=0,epoch=0,detailVersion=0,detail=null,formState=null,searchTimer,photoUrls=[];
 root.innerHTML=`<header class="rc-head"><div><div class="rc-eyebrow">SHEEN · RECEPTION</div><h1>پذیرش خودرو</h1><p>از ورود خودرو تا تحویل به مشتری، همه‌چیز در یک پرونده.</p></div><button class="primary" id="rcNew">＋ پذیرش جدید</button></header><div id="rcError" role="alert"></div><div class="rc-stats" id="rcStats"></div><div class="rc-list-panel"><div class="rc-toolbar"><label class="rc-search">جست‌وجوی پذیرش<input id="rcSearch" placeholder="نام مشتری، تماس، مدل، پلاک یا شماره پذیرش"></label><label>وضعیت<select id="rcFilter"><option value="">همه پذیرش‌ها</option><option value="deleted">حذف‌شده‌ها</option>${Object.entries(labels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><button class="ghost" id="rcRefresh" aria-label="بروزرسانی پذیرش‌ها">↻</button></div><div id="rcList" aria-live="polite"></div><div class="rc-paging" id="rcPaging"></div></div>`;
 document.body.insertAdjacentHTML('beforeend',`<dialog id="receptionFormModal" class="rc-modal"><div class="modal-head"><div><div class="rc-eyebrow">پذیرش خودرو</div><h2 id="rcFormTitle"></h2></div><button class="x" id="rcFormClose" aria-label="بستن فرم پذیرش">×</button></div><form id="rcForm"><div class="rc-form-grid" id="rcFields"></div><div class="rc-error" id="rcFormError" role="alert"></div><div class="rc-footer"><button type="button" class="ghost" id="rcCancel">انصراف</button><button type="submit" class="primary" id="rcSave">ذخیره پذیرش</button></div></form></dialog><dialog id="receptionDetailModal" class="rc-modal"><div class="modal-head"><h2 id="rcDetailTitle"></h2><button class="x" id="rcDetailClose" aria-label="بستن پرونده پذیرش">×</button></div><div id="rcDetail"></div><div class="rc-error" id="rcDetailError" role="alert"></div></dialog>`);
 const textField=(name,label,value='',extra='')=>`<label>${label}<input name="${name}" value="${esc(value??'')}" ${extra}></label>`;
 const paragraph=(label,value)=>`<div class="rc-info"><span>${label}</span><strong>${esc(value||'ثبت نشده')}</strong></div>`;
 document.body.insertAdjacentHTML('beforeend',`
  <dialog id="rcSignatureModal" aria-labelledby="rcSignatureTitle">
   <header><h2 id="rcSignatureTitle">امضای مشتری</h2><p>لطفاً در فضای سفید با انگشت امضا کنید.</p></header>
   <div class="rc-signature-sheet"><canvas id="rcSignatureCanvas" width="1000" height="600" aria-label="محل امضای مشتری"></canvas></div>
   <div id="rcSignatureError" role="alert"></div>
   <footer>
    <button id="rcSignatureCancel" type="button">انصراف</button>
    <button id="rcSignatureClear" type="button">پاک کردن</button>
    <button id="rcSignatureSave" type="button">ثبت امضا</button>
   </footer>
  </dialog>`);
 const signatureModal=$r('rcSignatureModal'),signatureCanvas=$r('rcSignatureCanvas');
 let signatureState=null,activePointer=null;

 function signatureImage(signature){
  const paths=signature.strokes.map(stroke=>{
   const path=stroke.map(([x,y],i)=>(i?'L':'M')+Number(x)+' '+Number(y)).join(' ');
   return `<path d="${esc(path)}"/>`;
  }).join('');
  return `<svg class="rc-signature-image" viewBox="0 0 1000 600" role="img" aria-label="امضای ثبت‌شده" fill="none" stroke="#16191e" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
 }
 function clearSignatureInk(){
  if(!signatureState)return;
  signatureState.strokes=[];
  signatureState.points=0;
  activePointer=null;
  const context=signatureCanvas.getContext('2d');
  context.clearRect(0,0,signatureCanvas.width,signatureCanvas.height);
  $r('rcSignatureError').textContent='';
 }
 function openSignature(record){
  if(!writable()||record.deletedAt||record.signature)return;
  signatureState={record,requestId:crypto.randomUUID(),session:epoch,saving:false,strokes:[],points:0};
  clearSignatureInk();
  signatureModal.showModal();
 }
 function signaturePoint(event){
  const bounds=signatureCanvas.getBoundingClientRect();
  const x=Math.round((event.clientX-bounds.left)*signatureCanvas.width/bounds.width);
  const y=Math.round((event.clientY-bounds.top)*signatureCanvas.height/bounds.height);
  return [Math.max(0,Math.min(x,1000)),Math.max(0,Math.min(y,600))];
 }
 signatureCanvas.onpointerdown=event=>{
  if(!signatureState||signatureState.saving||activePointer!==null||event.button!==0)return;
  if(signatureState.strokes.length>=200||signatureState.points>=10000)return;
  event.preventDefault();
  signatureCanvas.setPointerCapture(event.pointerId);
  activePointer=event.pointerId;
  signatureState.strokes.push([signaturePoint(event)]);
  signatureState.points++;
 };
 signatureCanvas.onpointermove=event=>{
  if(!signatureState||signatureState.saving||event.pointerId!==activePointer||signatureState.points>=10000)return;
  const stroke=signatureState.strokes.at(-1);
  const [lastX,lastY]=stroke.at(-1),[x,y]=signaturePoint(event);
  if(x===lastX&&y===lastY)return;
  stroke.push([x,y]);
  signatureState.points++;
  const context=signatureCanvas.getContext('2d');
  context.beginPath();
  context.lineWidth=5;
  context.lineCap='round';
  context.strokeStyle='#16191e';
  context.moveTo(lastX,lastY);
  context.lineTo(x,y);
  context.stroke();
 };
 signatureCanvas.onpointerup=signatureCanvas.onpointercancel=signatureCanvas.onlostpointercapture=event=>{
  if(event.pointerId===activePointer)activePointer=null;
 };
 $r('rcSignatureClear').onclick=clearSignatureInk;
 $r('rcSignatureCancel').onclick=()=>signatureModal.close();
 signatureModal.addEventListener('cancel',event=>{if(signatureState?.saving)event.preventDefault()});
 signatureModal.addEventListener('close',()=>{signatureState=null;activePointer=null});
 $r('rcSignatureSave').onclick=async()=>{
  const state=signatureState;
  if(!state||state.saving||!writable())return;
  const strokes=state.strokes.filter(stroke=>stroke.length>1);
  if(!strokes.length){$r('rcSignatureError').textContent='ابتدا در فضای سفید امضا کنید';return}
  state.saving=true;
  for(const id of ['rcSignatureSave','rcSignatureClear','rcSignatureCancel'])$r(id).disabled=true;
  try{
   const {id,version}=state.record;
   await api('/reception/'+id+'/signature',{
    method:'PUT',body:JSON.stringify({id:state.requestId,version,strokes})
   });
   if(signatureState!==state||state.session!==epoch)return;
   signatureModal.close();
   await loadReception();
   await showDetail(id);
   toast('امضای مشتری ثبت شد');
  }catch(error){
   if(signatureState===state)$r('rcSignatureError').textContent=error.message;
  }finally{
   state.saving=false;
   for(const id of ['rcSignatureSave','rcSignatureClear','rcSignatureCancel'])$r(id).disabled=false;
  }
 };

 async function changeDeleted(record){
  const restoring=!!record.deletedAt;
  if(!restoring&&!confirm('این پذیرش به «حذف‌شده‌ها» منتقل شود؟'))return;
  const button=$r(restoring?'rcRestore':'rcDelete');
  const session=epoch;
  button.disabled=true;
  $r('rcDetailError').textContent='';
  try{
   await api('/reception/'+record.id+(restoring?'/restore':''),{
    method:restoring?'POST':'DELETE',body:JSON.stringify({version:record.version})
   });
   if(epoch!==session||!currentUser?.receptionAccess)return;
   $r('receptionDetailModal').close();
   page=0;
   await loadReception();
   toast(restoring?'پذیرش بازگردانده شد':'پذیرش به حذف‌شده‌ها منتقل شد');
  }catch(error){
   if(epoch===session)$r('rcDetailError').textContent=error.message;
  }finally{button.disabled=false}
 }
 function releasePhotos(){for(const url of photoUrls)URL.revokeObjectURL(url);photoUrls=[]}
 function render(){if(!data)return;$r('rcNew').hidden=!writable();$r('rcStats').innerHTML=Object.entries(labels).map(([k,v])=>`<button data-rc-filter="${k}" class="rc-stat ${$r('rcFilter').value===k?'selected':''}"><strong>${num(data.counts[k]||0)}</strong><span>${v}</span></button>`).join('');
  $r('rcList').innerHTML=data.items.length?`<div class="rc-cards">${data.items.map(r=>`<article class="rc-card"><div class="rc-card-top"><span class="rc-number">پذیرش ${num(r.number)}</span><span class="rc-badge rc-${r.status}">${r.deletedAt?'حذف‌شده':labels[r.status]}</span></div><h2>${esc(r.model)} <small>${esc(r.color)}</small></h2><div class="rc-plate">${esc(r.plate)}</div><p>${esc(r.customerName)} <span dir="ltr">${esc(r.phone)}</span></p><p class="rc-service">${esc(r.services)}</p><div class="rc-card-bottom"><span>پذیرش: ${fmtDate(r.acceptedAt)}<br>${r.dueAt?'تحویل پیشنهادی: '+fmtDate(r.dueAt):'زمان تحویل تعیین نشده'}${r.photoCount?' · '+num(r.photoCount)+' عکس':''}</span><button class="ghost" data-rc-detail="${r.id}">باز کردن پرونده ←</button></div></article>`).join('')}</div>`:`<div class="rc-empty"><span>◇</span><h2>${$r('rcSearch').value||$r('rcFilter').value?'پذیرشی پیدا نشد':'اولین خودرو را پذیرش کن'}</h2><p>${$r('rcSearch').value||$r('rcFilter').value?'جست‌وجو یا فیلتر وضعیت را تغییر بده.':'اطلاعات مشتری، خودرو و خدمات را ثبت کن؛ شماره پذیرش خودکار ساخته می‌شود.'}</p></div>`;
  $r('rcPaging').innerHTML=`<button class="ghost" id="rcPrev" ${page===0?'disabled':''}>صفحه قبل</button><span>${num(data.total)} پذیرش · صفحه ${num(page+1)}</span><button class="ghost" id="rcNext" ${(page+1)*30>=data.total?'disabled':''}>صفحه بعد</button>`;
  root.querySelectorAll('[data-rc-detail]').forEach(b=>b.onclick=()=>showDetail(b.dataset.rcDetail));root.querySelectorAll('[data-rc-filter]').forEach(b=>b.onclick=()=>{$r('rcFilter').value=$r('rcFilter').value===b.dataset.rcFilter?'':b.dataset.rcFilter;page=0;loadReception()});
  $r('rcPrev').onclick=()=>{page--;loadReception()};$r('rcNext').onclick=()=>{page++;loadReception()};
 }
 async function loadReception(){if(!currentUser?.receptionAccess)return;const version=++epoch;$r('rcError').textContent='';$r('rcNew').hidden=!writable();try{const result=await api('/reception?'+new URLSearchParams({page,q:$r('rcSearch').value,status:$r('rcFilter').value}));if(epoch!==version||!currentUser?.receptionAccess)return;data=result;render()}catch(e){if(epoch===version)$r('rcError').textContent=e.message}}
 window.loadReception=loadReception;
 window.clearReception=()=>{epoch++;detailVersion++;clearTimeout(searchTimer);data=null;detail=null;formState=null;signatureState=null;activePointer=null;signatureModal.close();page=0;releasePhotos();$r('rcSearch').value='';$r('rcFilter').value='';$r('rcList').innerHTML='';$r('rcStats').innerHTML='';$r('rcDetail').innerHTML='';$r('rcFields').innerHTML='';$r('receptionFormModal').close();$r('receptionDetailModal').close()};
 function dueParts(value){if(!value)return ['',''];const p=persianDateParts(value);return [`${p.year}/${p.month}/${p.day}`,`${p.hour}:${p.minute}`]}
 function dueValue(date,time){
  if(!date&&!time)return null;
  const value=readPersianDate(date,time||'18:00');
  if(!value)throw Error('تاریخ و ساعت تحویل را درست وارد کنید');
  return value;
 }
 function openForm(r=null){if(!writable())return;formState={id:r?.id||crypto.randomUUID(),version:r?.version,isNew:!r};const [date,time]=dueParts(r?.dueAt);const [acceptedDate,acceptedTime]=dueParts(r?.acceptedAt||new Date());$r('rcFormTitle').textContent=r?'ویرایش پذیرش '+num(r.number):'پذیرش جدید';$r('rcFormError').textContent='';$r('rcSave').disabled=false;
  $r('rcFields').innerHTML=`<div class="rc-section-title">تاریخ و ساعت پذیرش</div>${textField('acceptedDate','تاریخ پذیرش (شمسی)',acceptedDate,'dir="ltr" required')}${textField('acceptedTime','ساعت پذیرش (تهران)',acceptedTime,'dir="ltr" required')}<div class="rc-section-title">مشتری و خودرو</div>${textField('customerName','نام مشتری',r?.customerName,'required maxlength="120" autocomplete="name"')}${textField('phone','شماره تماس',r?.phone,'type="tel" required maxlength="30" dir="ltr" autocomplete="tel"')}${textField('model','مدل خودرو',r?.model,'required maxlength="120" placeholder="مثلاً پژو ۲۰۷"')}${textField('plate','پلاک خودرو',r?.plate,'required maxlength="30" placeholder="مثلاً ۱۲ ب ۳۴۵ ـ ۶۷"')}<label class="rc-full">خدمات درخواستی مشتری<textarea name="services" required maxlength="3000" placeholder="مثلاً پولیش بدنه و صفرشویی داخل">${esc(r?.services||'')}</textarea></label><details class="rc-full rc-more" ${(r?.condition||r?.dueAt||r?.color||r?.mileage!=null)?'open':''}><summary>جزئیات خودرو و زمان تحویل (اختیاری)</summary><div class="rc-form-grid">${textField('color','رنگ خودرو',r?.color,'maxlength="60"')}${textField('mileage','کیلومتر خودرو',r?.mileage,'inputmode="numeric"')}${textField('dueDate','تاریخ پیشنهادی تحویل (شمسی)',date,'dir="ltr" placeholder="۱۴۰۵/۰۸/۱۰"')}${textField('dueTime','ساعت تحویل (تهران)',time,'dir="ltr" placeholder="۱۸:۰۰"')}<label class="rc-full">وضعیت بدنه، آسیب‌ها و وسایل همراه<textarea name="condition" maxlength="3000" placeholder="مثلاً خط روی در عقب؛ یک عدد کلید تحویل گرفته شد">${esc(r?.condition||'')}</textarea></label></div></details><p class="rc-hint rc-full">${r?.signature?'با ذخیرهٔ ویرایش، برای اطلاعات جدید باید امضای تازه بگیرید.':r?'اطلاعات این پرونده بروزرسانی می‌شود.':'شماره پذیرش خودکار است. بعد از ذخیره می‌توانی عکس‌های خودرو را به پرونده اضافه کنی.'}</p>`;
  $r('receptionDetailModal').close();$r('receptionFormModal').showModal();
 }
 $r('rcForm').onsubmit=async e=>{e.preventDefault();if(!formState||!writable())return;const saved=formState,f=Object.fromEntries(new FormData(e.target)),session=epoch;$r('rcSave').disabled=true;$r('rcFormError').textContent='';try{const acceptedAt=readPersianDate(f.acceptedDate,f.acceptedTime);
  if(!acceptedAt)throw Error('تاریخ و ساعت پذیرش را درست وارد کنید');
  const dueAt=dueValue(f.dueDate,f.dueTime);await api('/reception'+(saved.isNew?'':'/'+saved.id),{method:saved.isNew?'POST':'PUT',body:JSON.stringify({...f,acceptedAt,dueAt,id:saved.id,version:saved.version})});if(epoch!==session||!currentUser?.receptionAccess)return;$r('receptionFormModal').close();formState=null;await loadReception();await showDetail(saved.id);toast('پذیرش ذخیره شد')}catch(error){if(epoch===session)$r('rcFormError').textContent=error.message}finally{$r('rcSave').disabled=false}};
 async function showDetail(id){const session=epoch,version=++detailVersion;try{const r=await api('/reception/'+id);if(epoch!==session||version!==detailVersion||!currentUser?.receptionAccess)return;detail=r;releasePhotos();$r('rcDetailTitle').textContent='پذیرش '+num(r.number);$r('rcDetailError').textContent='';const editable=writable()&&!r.deletedAt,photoEditable=editable&&r.status!=='delivered';
  $r('rcDetail').innerHTML=`<div class="rc-detail-head"><div><h2>${esc(r.model)}</h2><div class="rc-plate">${esc(r.plate)}</div></div><span class="rc-badge rc-${r.status}">${r.deletedAt?'حذف‌شده':labels[r.status]}</span></div><div class="rc-info-grid">${paragraph('مشتری',r.customerName)}${paragraph('تماس',r.phone)}${paragraph('رنگ',r.color)}${paragraph('کیلومتر',r.mileage==null?'':num(r.mileage))}${paragraph('تاریخ پذیرش',fmtDate(r.acceptedAt))}${paragraph('تحویل پیشنهادی',r.dueAt?fmtDate(r.dueAt):'')}${r.deliveredAt?paragraph('زمان تحویل واقعی',fmtDate(r.deliveredAt)):''}</div><section class="rc-detail-section"><h3>خدمات درخواستی</h3><p>${esc(r.services)}</p><h3>وضعیت خودرو هنگام پذیرش</h3><p>${esc(r.condition||'توضیحی ثبت نشده است.')}</p></section>${editable?`<section class="rc-detail-section rc-controls"><label>وضعیت پذیرش<select id="rcStatus">${Object.entries(labels).map(([k,v])=>`<option value="${k}" ${k===r.status?'selected':''}>${v}</option>`).join('')}</select></label><button class="primary" id="rcStatusSave">ثبت وضعیت</button>${next[r.status]?`<button class="ghost" id="rcAdvance">${labels[next[r.status]]} ←</button>`:''}<button class="ghost" id="rcEdit">ویرایش پذیرش</button></section>`:''}<section class="rc-detail-section"><div class="between"><h3>عکس‌های خودرو <small>(${num(r.photos.length)} از ۵)</small></h3></div><div id="rcPhotos" class="rc-photos">${r.photos.length?'در حال دریافت عکس‌ها…':'هنوز عکسی ثبت نشده است.'}</div>${photoEditable?'<label class="rc-upload">＋ افزودن عکس خودرو<input id="rcPhotoInput" type="file" accept="image/jpeg,image/png,image/webp" multiple></label><p class="rc-hint">تا ۵ عکس از بدنه و آسیب‌های قبلی؛ هر عکس حداکثر ۲ مگابایت.</p>':''}</section><section class="rc-detail-section rc-signature-section"><h3>امضای مشتری</h3>${r.signature?signatureImage(r.signature)+'<p>تاریخ امضا: '+fmtDate(r.signature.signedAt)+'</p>':editable?'<button class="ghost rc-signature-action" id="rcSign">گرفتن امضای مشتری</button>':'<p>امضا ثبت نشده است.</p>'}</section><details class="rc-more"><summary>تاریخچه پذیرش</summary><ol class="rc-history">${r.events.map(ev=>`<li><strong>${esc(({created:'ثبت پذیرش',edited:'ویرایش اطلاعات',photo_added:'افزودن عکس',signed:'ثبت امضای مشتری',signature_invalidated:'نیاز به امضای تازه پس از ویرایش',deleted:'انتقال به حذف‌شده‌ها',restored:'بازگرداندن پذیرش',status:'تغییر وضعیت به '+labels[ev.toStatus]})[ev.action]||ev.action)}</strong><span>${esc(ev.actorName)} · ${fmtDate(ev.createdAt)}</span></li>`).join('')}</ol></details><div class="rc-footer">${currentUser?.invoiceAccess&&!r.deletedAt?'<button class="ghost" id="rcInvoices">فاکتورهای این پذیرش</button>':''}<button class="ghost" id="rcPrint">چاپ برگه پذیرش / PDF</button>${writable()?(r.deletedAt?'<button class="primary" id="rcRestore">بازگرداندن پذیرش</button>':'<button class="danger" id="rcDelete">حذف پذیرش</button>'):''}</div>`;
  if(!$r('receptionDetailModal').open)$r('receptionDetailModal').showModal();
  if($r('rcEdit'))$r('rcEdit').onclick=()=>openForm(r);if($r('rcStatusSave'))$r('rcStatusSave').onclick=()=>changeStatus($r('rcStatus').value);if($r('rcAdvance'))$r('rcAdvance').onclick=()=>changeStatus(next[r.status]);if($r('rcPhotoInput'))$r('rcPhotoInput').onchange=e=>uploadPhotos(e.target.files,r.id);
  if($r('rcSign'))$r('rcSign').onclick=()=>openSignature(r);
  if($r('rcDelete'))$r('rcDelete').onclick=()=>changeDeleted(r);
  if($r('rcRestore'))$r('rcRestore').onclick=()=>changeDeleted(r);
  if($r('rcInvoices'))$r('rcInvoices').onclick=()=>window.openInvoicesForReception?.(r);
  $r('rcPrint').onclick=()=>{document.body.classList.add('print-reception');window.print()};
  const photoResults=await Promise.allSettled(r.photos.map(async p=>{const response=await fetch('/api/reception/'+r.id+'/photos/'+p.id,{headers:{Authorization:'Bearer '+token},cache:'no-store'});if(!response.ok)throw Error('دریافت عکس ناموفق بود');return URL.createObjectURL(await response.blob())}));
  const urls=photoResults.filter(p=>p.status==='fulfilled').map(p=>p.value);if(photoResults.some(p=>p.status==='rejected')){urls.forEach(url=>URL.revokeObjectURL(url));throw Error('دریافت بعضی عکس‌ها ناموفق بود؛ پرونده را دوباره باز کنید')}
  if(epoch!==session||version!==detailVersion||detail?.id!==id||!$r('receptionDetailModal').open){urls.forEach(url=>URL.revokeObjectURL(url));return}photoUrls=urls;$r('rcPhotos').innerHTML=urls.map((url,i)=>`<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="عکس ${num(i+1)} خودرو" loading="lazy"></a>`).join('')||'هنوز عکسی ثبت نشده است.';
 }catch(e){if(epoch===session&&version===detailVersion){if($r('receptionDetailModal').open)$r('rcDetailError').textContent=e.message;else toast(e.message)}}}
 async function changeStatus(status){if(!detail||!writable()||status===detail.status)return;const r=detail;if(status==='delivered'&&!confirm('خودرو به مشتری تحویل داده شد؟'))return;if(r.status==='delivered'&&!confirm('پذیرش تحویل‌شده دوباره باز شود؟'))return;$r('rcStatusSave').disabled=true;if($r('rcAdvance'))$r('rcAdvance').disabled=true;$r('rcDetailError').textContent='';try{await api('/reception/'+r.id+'/status',{method:'PATCH',body:JSON.stringify({status,version:r.version})});await loadReception();await showDetail(r.id)}catch(e){$r('rcDetailError').textContent=e.message;$r('rcStatusSave').disabled=false;if($r('rcAdvance'))$r('rcAdvance').disabled=false}}
 async function uploadPhotos(files,id){const input=$r('rcPhotoInput'),chosen=[...files],userId=currentUser?.id,session=epoch;if(!chosen.length)return;input.disabled=true;let count=detail.photos.length,uploaded=0,error='';try{if(chosen.length+count>5)throw Error('برای هر پذیرش حداکثر ۵ عکس مجاز است');for(const file of chosen){if(currentUser?.id!==userId||epoch!==session||detail?.id!==id)throw Error('بارگذاری متوقف شد');if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024)throw Error('عکس JPG، PNG یا WebP تا ۲ مگابایت انتخاب کنید');const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('عکس خوانده نشد'));reader.readAsDataURL(file)});if(currentUser?.id!==userId||epoch!==session||detail?.id!==id)throw Error('بارگذاری متوقف شد');await api('/reception/'+id+'/photos',{method:'POST',body:JSON.stringify({id:crypto.randomUUID(),mime:file.type,data:base64})});uploaded++}}catch(e){error=e.message}finally{if(currentUser?.id===userId&&epoch===session&&currentUser?.receptionAccess&&detail?.id===id&&$r('receptionDetailModal').open){await loadReception();await showDetail(id);$r('rcDetailError').textContent=error+(error&&uploaded?' · '+num(uploaded)+' عکس ذخیره شد.':'')}input.disabled=false}}
 $r('rcNew').onclick=()=>openForm();$r('rcRefresh').onclick=loadReception;$r('rcFilter').onchange=()=>{page=0;loadReception()};$r('rcSearch').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{page=0;loadReception()},300)};
 $r('rcFormClose').onclick=$r('rcCancel').onclick=()=>{$r('receptionFormModal').close();formState=null};$r('rcDetailClose').onclick=()=>{detailVersion++;$r('receptionDetailModal').close();detail=null;releasePhotos()};$r('receptionDetailModal').addEventListener('close',()=>{detailVersion++;releasePhotos()});window.addEventListener('afterprint',()=>document.body.classList.remove('print-reception'));
 $r('receptionModule').onclick=()=>showModule('reception');
})();
