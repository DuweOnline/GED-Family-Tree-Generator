'use strict';
// ── Constants ──
const EVT_LABEL={BIRT:'Birth',DEAT:'Death',BURI:'Burial',CHR:'Christening',BAPM:'Baptism',CONF:'Confirmation',EMIG:'Emigration',IMMI:'Immigration',CENS:'Census',RESI:'Residence',OCCU:'Occupation',EDUC:'Education',RELI:'Religion',NATI:'Nationality',TITL:'Title',WILL:'Will',PROB:'Probate',GRAD:'Graduation',EVEN:'Event',ORDN:'Ordination',MARR:'Marriage',DIV:'Divorce',ENGA:'Engagement'};
const EVENT_TAGS=new Set(Object.keys(EVT_LABEL));
const TAB_IDS=['listtree','ancestors','chart','timeline','places','surnames','stats','fan','map','hourglass','fam-view'];

// ── State ──
let persons={},families={},sources={};
let extraRecords=[]; // top-level GEDCOM records the app doesn't model (REPO, SUBM, OBJE…), kept verbatim
let selectedId=null,currentTab='listtree';
let fanMaxGen=4,ancestorMaxGen=4;
let leafletLoaded=false,leafletLoading=false,mapInstance=null,geoAbort=null;
let timelineBuilt=false;
let currentTreeId=null,currentTreeName='Family Tree';
let editingId=null,editSpouses=[],editParent={father:null,mother:null},editRemovedFams=new Set();
let editChildren=[],editRemovedChildren=new Map(); // Map<personId, famId>
let editAddedSiblings=[]; // personIds queued to be linked as siblings on save
let editPhotos=[]; // [{url}] working copy for edit modal
let editSources=[]; // [{title}] working copy for edit modal
let editTasks=[]; // [{text,done}] working copy for edit modal
let editResi=[]; // [{place,from,to}] working copy for edit modal
let editDirty=false; // unsaved changes in the edit modal
let editCreatedIds=[]; // people made via "Create new" that are only kept if the edit is saved
let batchMode=false,batchSelected=new Set();
let currentSort='alpha'; // 'alpha' | 'birth' | 'birth-desc'
let relToAllMode=false;
let relToAllCache={}; // id -> relationship label
let undoStack=[]; // snapshots for Ctrl+Z
const geoCache=(()=>{try{return JSON.parse(localStorage.getItem('geoCache')||'{}')}catch(e){return{}}})();

// ── Cookie helpers ──
const AUTH_COOKIE='ft_auth';
const AUTH_DAYS=10;
function setCookie(name,val,days){
  const exp=new Date(Date.now()+days*864e5).toUTCString();
  const secure=location.protocol==='https:'?';Secure':'';
  document.cookie=`${name}=${encodeURIComponent(val)};expires=${exp};path=/;SameSite=Strict${secure}`;
}
function getCookie(name){
  const m=document.cookie.match(new RegExp('(?:^|; )'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'=([^;]*)'));
  return m?decodeURIComponent(m[1]):'';
}
function delCookie(name){
  document.cookie=`${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/`;
}

// ── API Client ──
// Cookie is the primary auth store (10-day expiry). localStorage kept for
// backward-compatibility and is migrated to cookie on first load.
let authToken=getCookie(AUTH_COOKIE)||localStorage.getItem('authToken')||'';
if(authToken&&!getCookie(AUTH_COOKIE)){setCookie(AUTH_COOKIE,authToken,AUTH_DAYS)} // migrate old localStorage token

async function apiFetch(url,opts={}){
  try{
    const res=await fetch(url,{
      method:opts.method||'GET',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},
      body:opts.body!==undefined?JSON.stringify(opts.body):undefined,
    });
    if(res.status===401){logout(true);return null}
    if(res.status===409&&opts.conflictOk)return{conflict:true};
    if(!res.ok){let msg=`${res.status} ${res.statusText}`;try{msg=(await res.json()).error||msg}catch(e){}throw new Error(msg)}
    return res.json();
  }catch(e){
    if(!opts.quiet)showToast('⚠️ Server problem: '+e.message,4000);
    return null;
  }
}
async function apiGetTrees(){return apiFetch('api.php?action=trees')}
async function apiGetTree(id,opts={}){return apiFetch(`api.php?action=tree&id=${id}`,opts)}
async function apiCreateTree(rec){return apiFetch('api.php?action=create',{method:'POST',body:rec})}
async function apiUpdateTree(id,rec,opts={}){return apiFetch(`api.php?action=update&id=${id}`,{method:'POST',body:rec,...opts})}
async function apiDeleteTree(id){return apiFetch(`api.php?action=delete&id=${id}`,{method:'POST'})}

// ── Auth ──
function showLogin(){
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('home-screen').style.display='none';
  document.getElementById('app').classList.remove('visible');
  document.getElementById('login-password').value='';
  document.getElementById('login-error').textContent='';
  setTimeout(()=>document.getElementById('login-password').focus(),60);
}
async function submitLogin(){
  const pw=document.getElementById('login-password').value;
  const errEl=document.getElementById('login-error');
  errEl.textContent='';
  try{
    const res=await fetch('api.php?action=auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});
    if(!res.ok){errEl.textContent='Wrong password';return}
    const{token}=await res.json();
    authToken=token;
    setCookie(AUTH_COOKIE,token,AUTH_DAYS);
    localStorage.removeItem('authToken'); // cookie is the single source of truth now
    document.getElementById('login-overlay').classList.add('hidden');
    const loc=readLocation();
    if(loc.tree&&await loadTreeById(loc.tree,loc,true))return;
    await renderHomeScreen();
  }catch(e){errEl.textContent='Could not reach server'}
}
function logout(expired=false){
  clearTimeout(saveTimer);saveTimer=null;pendingGed=null; // anything unsent stays in the local backup
  authToken='';localStorage.removeItem('authToken');delCookie(AUTH_COOKIE);
  destroyMap();
  persons={};families={};sources={};extraRecords=[];selectedId=null;currentTreeId=null;timelineBuilt=false;undoStack=[];
  if(!expired)history.replaceState(null,'',location.pathname+location.search);
  else showToast('🔒 Your session expired — log in again to carry on where you were',5000);
  showLogin();
}

function openGuide(){
  // Works from both the login screen and inside the app
  document.getElementById('guide-modal').classList.remove('hidden');
  // Scroll the guide body back to the top each time it's opened
  const body=document.querySelector('.guide-body');
  if(body)body.scrollTop=0;
}
function scrollGuide(id){
  const el=document.getElementById(id);
  if(el)el.scrollIntoView({behavior:'smooth',block:'start'});
}

// ── GEDCOM Parser (supports GEDCOM 5.5.1 and FamilySearch GEDCOM 7.0) ──
// Record IDs end up inside inline onclick="...('${id}')" attributes, so they
// must never contain quotes/angle brackets — strip anything unsafe on import.
function safeId(s){return String(s).replace(/[^A-Za-z0-9_.:+@-]/g,'')}
function parseGedcom(text){
  // Strip UTF-8 BOM — present in some Windows/FamilySearch exports
  if(text.charCodeAt(0)===0xFEFF)text=text.slice(1);
  persons={};families={};sources={};extraRecords=[];timelineBuilt=false;
  const lines=text.split(/\r?\n/);

  // ── Pre-pass A: collect GEDCOM 7 SNOTE records and legacy level-0 NOTE records ──
  // These are referenced later as  1 NOTE @N1@  or  1 SNOTE @N1@
  const noteRecs=new Map(); // '@id@' → resolved text
  {
    let nId=null;
    for(const raw of lines){
      const line=raw.trim();if(!line)continue;
      const m=line.match(/^(\d+)\s+(@[^@]+@|\S+)\s*(.*)?$/);if(!m)continue;
      const lv=+m[1],tg=m[2],rest=(m[3]||'').trim();
      if(lv===0){
        nId=null;
        if(tg.startsWith('@')){const rt=rest.split(/\s+/)[0];if(rt==='NOTE'||rt==='SNOTE'){const key=safeId(tg);noteRecs.set(key,rest.slice(rt.length).trim());nId=key;}}
      }else if(nId){
        if(tg==='CONT')noteRecs.set(nId,(noteRecs.get(nId)||'')+'\n'+rest);
        else if(tg==='CONC')noteRecs.set(nId,(noteRecs.get(nId)||'')+rest);        // kept for 5.5.1 back-compat
        else if(tg==='TEXT'&&lv===1)noteRecs.set(nId,noteRecs.get(nId)?noteRecs.get(nId)+'\n'+rest:rest); // GEDCOM 7 TEXT sub-tag
        else if(tg!=='MIME'&&tg!=='LANG'&&tg!=='TRAN'&&tg!=='CONT')nId=null;    // stop at unrecognised sub-tags
      }
    }
  }

  // ── Pre-pass B: collect OBJE (media) records — resolves  1 OBJE @O1@  to a URL ──
  const objRecs=new Map(); // '@id@' → first http image URL
  {
    let oId=null;
    for(const raw of lines){
      const line=raw.trim();if(!line)continue;
      const m=line.match(/^(\d+)\s+(@[^@]+@|\S+)\s*(.*)?$/);if(!m)continue;
      const lv=+m[1],tg=m[2],rest=(m[3]||'').trim();
      if(lv===0){oId=null;if(tg.startsWith('@')&&rest.split(/\s+/)[0]==='OBJE')oId=safeId(tg);}
      else if(oId&&lv===1&&tg==='FILE'&&rest.startsWith('http')){objRecs.set(oId,rest);oId=null;}
    }
  }

  // ── Main parse ──
  // Anything the app doesn't model is copied verbatim (with its whole subtree)
  // onto the record it belongs to and written back on save, so opening and
  // editing a tree never silently drops data from other programs.
  //   cap    — currently copying an unmodelled subtree: {arr, level}
  //   anchor — where unmodelled children of the current level-1 line go
  //   sub    — where unmodelled children of the current DATE/PLAC line go
  let cur=null,curTag=null,curEvt=null,inNote=false,noteTgt=null,noteProp=null,curInName=false;
  let cap=null,anchor=null,sub=null,seen=new Set();
  const keep=(arr,level,line)=>{arr.push(line);cap={arr,level}};
  const bag=(o,k)=>o[k]||(o[k]=[]);
  const bagOf=(o,k,key)=>{const m=o[k]||(o[k]={});return m[key]||(m[key]=[])};
  function newP(id){return{id,name:'Unknown',nameGiven:'',nameSur:'',nickname:'',sex:'U',birth:{},death:{},events:[],notes:[],fams:[],famc:[],sources:[],images:[],tasks:[],residences:[]}}
  function newF(id){return{id,husb:null,wife:null,children:[],marr:{},events:[],notes:[]}}
  // Level-2 fields of an event (shared by person and family events)
  function eventField(evt,tag,val,line){
    if(tag==='DATE'){evt.date=val;sub=()=>bag(evt,'_x_DATE')}
    else if(tag==='PLAC'){evt.plac=val;sub=()=>bag(evt,'_x_PLAC')}
    else if(tag==='TYPE')evt.type=val;                                       // GEDCOM 7: event type qualifier
    else if(tag==='NOTE'){evt.note=val;inNote=true;noteTgt=evt;noteProp='note'}
    else if(tag==='CAUS')evt.caus=val;
    else if(tag==='QUAY'){const c=['estimated','estimated','probable','proven'];evt.conf=c[+val]||undefined}
    else keep(bag(evt,'_extra'),2,line);                                     // SOUR, ADDR, AGE, OBJE…
  }

  for(let li=0;li<lines.length;li++){
    const line=lines[li].trim();if(!line)continue;
    const m=line.match(/^(\d+)\s+(@[^@]+@|\S+)\s*(.*)?$/);if(!m)continue;
    const level=+m[1];let tag=m[2];
    if(cap){if(level>cap.level){cap.arr.push(line);continue}cap=null}
    if(tag.startsWith('@'))tag=safeId(tag); // record definition ID
    // Unescape leading @@ → @ (GEDCOM 7 value escaping rule)
    const val=(m[3]||'').trim().replace(/^@@/,'@');

    if(level===0){
      inNote=false;curEvt=null;curInName=false;anchor=null;sub=null;seen=new Set();
      // Use first word of val as record type (handles "INDI", "FAM", "SOUR", "NOTE text", "SNOTE text" etc.)
      const rt=tag.startsWith('@')?val.split(/\s+/)[0]:null;
      if(rt==='INDI'){cur=newP(tag);persons[tag]=cur;curTag='INDI'}
      else if(rt==='FAM'){cur=newF(tag);families[tag]=cur;curTag='FAM'}
      else if(rt==='SOUR'){cur={id:tag,title:''};sources[tag]=cur;curTag='SOUR'}
      else{cur=null;curTag=null;if(tag!=='HEAD'&&tag!=='TRLR'){const blk=[line];extraRecords.push(blk);cap={arr:blk,level:0}}}
      continue;
    }
    if(!cur)continue; // header lines — we write our own header

    // CONT/CONC continuation for inline notes (CONC removed in GEDCOM 7 but kept for import compat)
    if((tag==='CONT'||tag==='CONC')&&inNote&&noteTgt){
      noteTgt[noteProp]=(noteTgt[noteProp]||'')+(tag==='CONT'?'\n':'')+val;continue;
    }

    if(curTag==='INDI'){
      if(level===1){
        // A new level-1 line ends the previous inline note — file it now (before
        // this line), so its CONT lines stay part of the same note
        if(cur._lastNote!==undefined){cur.notes.push(cur._lastNote);delete cur._lastNote}
        inNote=false;curEvt=null;curInName=false;anchor=null;sub=null;
        const first=!seen.has(tag);seen.add(tag);
        if(tag==='NAME'&&first){
          cur.name=val.replace(/\//g,'').replace(/\s+/g,' ').trim()||'Unknown';
          const s=val.match(/\/([^/]*)\//);cur.nameSur=s?s[1].trim():'';cur.nameGiven=val.replace(/\/[^/]*\//,'').replace(/\s+/g,' ').trim();
          curInName=true; // allow GEDCOM 7 sub-tags (GIVN, SURN, NICK) to refine the name
        }
        else if(tag==='NICK')cur.nickname=cur.nickname||val;                    // GEDCOM 5.5.1: 1 NICK
        else if(tag==='SEX'&&first)cur.sex=val||'U';                             // GEDCOM 7 adds X (intersex)
        else if(tag==='FAMC'){const id=safeId(val);cur.famc.push(id);anchor=()=>bagOf(cur,'_famcExtra',id)} // PEDI (adopted…) etc.
        else if(tag==='FAMS'){const id=safeId(val);cur.fams.push(id);anchor=()=>bagOf(cur,'_famsExtra',id)}
        else if(tag==='RESN'&&/privacy|confidential/i.test(val))cur.living=true; // GEDCOM 7: RESN privacy → treat as living
        else if(tag==='NOTE'||tag==='SNOTE'){                                    // SNOTE = GEDCOM 7 shared note ref
          const ref=safeId(val);
          const txt=val.startsWith('@')&&noteRecs.has(ref)?noteRecs.get(ref):val;
          cur._lastNote=txt;
          if(!val.startsWith('@')){inNote=true;noteTgt=cur;noteProp='_lastNote'} // only continue inline notes
        }
        else if(tag==='SOUR'){const sid=val.startsWith('@')?safeId(val):val;cur.sources.push(sid);anchor=()=>bagOf(cur,'_srcExtra',sid)} // PAGE, QUAY…
        else if(tag==='OBJE'){                                                   // media: keep web images, everything else verbatim
          let u=val.startsWith('@')&&objRecs.has(safeId(val))?objRecs.get(safeId(val)):(val.startsWith('http')?val:null);
          if(!val){for(let j=li+1;j<lines.length;j++){const mm=lines[j].trim().match(/^(\d+)\s+(\S+)\s*(.*)$/);if(!mm||+mm[1]<=1)break;if(mm[2]==='FILE'){if(mm[3].startsWith('http'))u=mm[3].trim();break}}}
          if(u){cur.images.push(u);if(!val)cap={arr:[],level:1}} // inline web image: modelled, skip its sub-lines
          else keep(bag(cur,'_extra'),1,line);
        }
        else if(EVENT_TAGS.has(tag)&&!((tag==='BIRT'||tag==='DEAT')&&!first)){
          if(tag==='BIRT'){curEvt=cur.birth;curEvt._tag='BIRT'}
          else if(tag==='DEAT'){curEvt=cur.death;curEvt._tag='DEAT';if(val==='Y')cur.death.confirmed=true;}
          else{curEvt={_tag:tag};cur.events.push(curEvt)}
          if(val&&val!=='Y')curEvt.val=val;
        }
        else keep(bag(cur,'_extra'),1,line);                                     // ALIA, ASSO, second NAME, _UID, custom tags…
      }
      else if(level===2&&curInName){                                             // GEDCOM 7 structured name sub-tags
        if(tag==='GIVN'){cur.nameGiven=val;if(val)cur.name=(val+(cur.nameSur?' '+cur.nameSur:'')).trim();}
        else if(tag==='SURN'){cur.nameSur=val;if(val)cur.name=((cur.nameGiven?cur.nameGiven+' ':'')+val).trim();}
        else if(tag==='NICK')cur.nickname=cur.nickname||val;                    // GEDCOM 7: 2 NICK under NAME
        else keep(bag(cur,'_nameExtra'),2,line);                                 // NPFX, NSFX, SPFX, TYPE, TRAN…
      }
      else if(level===2&&curEvt)eventField(curEvt,tag,val,line);
      else if(level===2&&anchor)keep(anchor(),2,line);
      else if(level===3&&sub)keep(sub(),3,line);                                 // e.g. MAP/LATI/LONG under PLAC, TIME under DATE
    }
    else if(curTag==='FAM'){
      if(level===1){
        inNote=false;curEvt=null;anchor=null;sub=null;
        const first=!seen.has(tag);seen.add(tag);
        if(tag==='HUSB'&&first){cur.husb=safeId(val);anchor=()=>bagOf(cur,'_linkExtra','HUSB')}
        else if(tag==='WIFE'&&first){cur.wife=safeId(val);anchor=()=>bagOf(cur,'_linkExtra','WIFE')}
        else if(tag==='CHIL'){const id=safeId(val);cur.children.push(id);anchor=()=>bagOf(cur,'_linkExtra','CHIL '+id)}
        else if(tag==='MARR'&&first)curEvt=cur.marr;
        else if(tag==='NOTE'||tag==='SNOTE'){
          const ref=safeId(val);
          if(val.startsWith('@')){const txt=noteRecs.has(ref)?noteRecs.get(ref):val;if(txt)cur.notes.push(txt)}
          else{cur.notes.push(val);inNote=true;noteTgt=cur.notes;noteProp=cur.notes.length-1} // CONT lines continue it
        }
        else if(EVENT_TAGS.has(tag)&&tag!=='MARR'){curEvt={_tag:tag};if(val&&val!=='Y')curEvt.val=val;cur.events.push(curEvt)}
        else keep(bag(cur,'_extra'),1,line);                                     // SOUR, NCHI, second MARR, _UID…
      }
      else if(level===2&&curEvt)eventField(curEvt,tag,val,line);
      else if(level===2&&anchor)keep(anchor(),2,line);
      else if(level===3&&sub)keep(sub(),3,line);
    }
    else if(curTag==='SOUR'){
      if(level===1){
        inNote=false;
        if(tag==='TITL'||tag==='AUTH'||tag==='PUBL'){const k={TITL:'title',AUTH:'auth',PUBL:'publ'}[tag];cur[k]=val;inNote=true;noteTgt=cur;noteProp=k}
        else keep(bag(cur,'_extra'),1,line);                                     // REPO, TEXT, DATA, NOTE…
      }
    }
  }

  for(const p of Object.values(persons)){
    if(p._lastNote!==undefined){p.notes.push(p._lastNote);delete p._lastNote}
    p.notes=[...new Set(p.notes.filter(Boolean))];
    // Extract task notes
    if(!p.tasks)p.tasks=[];
    if(!p.residences)p.residences=[];
    const taskNotes=p.notes.filter(n=>n.startsWith('[TASK:done]')||n.startsWith('[TASK]'));
    p.notes=p.notes.filter(n=>!n.startsWith('[TASK:done]')&&!n.startsWith('[TASK]'));
    for(const n of taskNotes){
      if(n.startsWith('[TASK:done]'))p.tasks.push({text:n.slice(11),done:true});
      else if(n.startsWith('[TASK]'))p.tasks.push({text:n.slice(6),done:false});
    }
    // Extract RESI events into residences (keeping the original event for anything we don't edit)
    const resiEvts=p.events.filter(e=>e._tag==='RESI');
    p.events=p.events.filter(e=>e._tag!=='RESI');
    for(const e of resiEvts)p.residences.push({place:e.plac||'',...splitResiDate(e.date),_evt:e});
  }
  for(const f of Object.values(families))f.notes=f.notes.filter(Boolean);
  // Older versions of the edit form had no Details box, so things like an
  // occupation were typed into Date ("Engineer"). A date with letters but no
  // digits can't be a date — move it to the event's details.
  const fixVal=e=>{if(e.date&&!e.val&&/\p{L}/u.test(e.date)&&!/\d/.test(e.date)){e.val=e.date;delete e.date;delete e._x_DATE}};
  for(const p of Object.values(persons))p.events.forEach(fixVal);
  for(const f of Object.values(families))(f.events||[]).forEach(e=>{if(e._tag!=='DIV')fixVal(e)});
  // Back-fill FAMC from FAM CHIL (handles files where FAMC is missing on INDI)
  const bestFam=new Map();
  for(const[famId,fam]of Object.entries(families)){
    for(const cId of fam.children){
      const c=persons[cId];if(!c||c.famc.length>0)continue;
      const prev=bestFam.get(cId);
      if(!prev||fam.children.length>prev.count)bestFam.set(cId,{famId,count:fam.children.length});
    }
  }
  for(const[cId,{famId}]of bestFam)persons[cId].famc.push(famId);
}
// Residence dates: GEDCOM periods are "FROM x TO y" / "FROM x" / "TO y".
// Older saves of this app wrote "x–y", which is read back too.
function splitResiDate(d){
  d=(d||'').trim();let m;
  if((m=d.match(/^FROM\s+(.+?)(?:\s+TO\s+(.+))?$/i)))return{from:m[1],to:m[2]||''};
  if((m=d.match(/^TO\s+(.+)$/i)))return{from:'',to:m[1]};
  if((m=d.match(/^(.+?)\s*–\s*(.+)$/)))return{from:m[1],to:m[2]};
  return{from:d,to:''};
}
function joinResiDate(r){
  if(r.from&&r.to)return`FROM ${r.from} TO ${r.to}`;
  if(r.to)return`TO ${r.to}`;
  return r.from||'';
}

// ── GEDCOM Generator ──
// forExport:true applies privacy rules for files leaving the app (living
// people's dates are withheld). The copy saved to the server is always complete.
function generateGedcom({forExport=false}={}){
  const L=[];
  // ── GEDCOM 7.0 header ──
  L.push('0 HEAD');
  L.push('1 GEDC');
  L.push('2 VERS 7.0');
  L.push('1 SOUR FamilyTreeApp');
  L.push('2 NAME Family Tree');
  L.push('1 LANG en');

  // Helper: escape @ in values (GEDCOM 7 rule: literal @ → @@)
  const escAt=v=>String(v||'').replace(/@/g,'@@');
  // Helper: emit a possibly-multi-line value with CONT continuations
  function pushNote(level,tag,text){
    const lines=String(text||'').split('\n');
    L.push(`${level} ${tag}${lines[0]?' '+escAt(lines[0]):''}`);
    for(let i=1;i<lines.length;i++)L.push(`${level+1} CONT${lines[i]?' '+escAt(lines[i]):''}`);
  }
  const raw=arr=>{if(arr)for(const l of arr)L.push(l)}; // verbatim lines kept from the original file
  const QUAY={proven:3,probable:2,estimated:1};
  // One event at level 1 with its fields at level 2
  function pushEvent(e,{tag=e._tag,val=e.val,date=e.date,plac=e.plac}={}){
    L.push(`1 ${tag}${val?' '+escAt(val):''}`);
    if(e.type)L.push(`2 TYPE ${escAt(e.type)}`);
    if(date){L.push(`2 DATE ${date}`);raw(e._x_DATE)}
    if(plac){L.push(`2 PLAC ${escAt(plac)}`);raw(e._x_PLAC)}
    if(e.caus)L.push(`2 CAUS ${escAt(e.caus)}`);
    if(e.conf)L.push(`2 QUAY ${QUAY[e.conf]||2}`);
    if(e.note)pushNote(2,'NOTE',e.note);
    raw(e._extra);
  }
  const hasData=e=>e&&(e.date||e.plac||e.caus||e.note||e.type||e.conf||e._extra?.length);

  for(const p of Object.values(persons)){
    L.push(`0 ${p.id} INDI`);
    // ── Name ── GEDCOM 7: GIVN / SURN / NICK are sub-tags of NAME
    const g=p.nameGiven||'',s=p.nameSur||'';
    L.push(`1 NAME ${s?`${escAt(g)} /${escAt(s)}/`.trim():escAt(p.name)}`);
    if(g)L.push(`2 GIVN ${escAt(g)}`);
    if(s)L.push(`2 SURN ${escAt(s)}`);
    if(p.nickname)L.push(`2 NICK ${escAt(p.nickname)}`); // GEDCOM 7: NICK under NAME, not sibling
    raw(p._nameExtra);
    // ── Sex ── GEDCOM 7 allows X
    if(p.sex&&p.sex!=='U')L.push(`1 SEX ${p.sex}`);
    // ── Privacy ──
    if(p.living)L.push('1 RESN privacy');
    const hideDates=forExport&&p.living;
    // ── Birth ── (exports keep the place but drop the date for living people)
    if(hasData(p.birth))pushEvent(p.birth,{tag:'BIRT',val:'',date:hideDates?'':p.birth.date});
    // ── Death ── DEAT Y when confirmed but no details
    if(!hideDates&&(hasData(p.death)||p.death.confirmed))pushEvent(p.death,{tag:'DEAT',val:!p.death.date&&!p.death.plac?'Y':''});
    // ── Other individual events ──
    for(const e of p.events)pushEvent(e);
    // ── Residences ──
    for(const r of(p.residences||[])){
      const o=r._evt||{},date=joinResiDate(r);
      const e={...o,_tag:'RESI',plac:r.place,date};
      if(o.plac!==r.place)delete e._x_PLAC;if(o.date!==date)delete e._x_DATE; // edited: drop stale map coordinates etc.
      pushEvent(e);
    }
    // ── Family links ──
    for(const fid of p.fams){L.push(`1 FAMS ${fid}`);raw(p._famsExtra?.[fid])}
    for(const fid of p.famc){L.push(`1 FAMC ${fid}`);raw(p._famcExtra?.[fid])}
    // ── Notes (multi-line via CONT) ──
    for(const n of p.notes)pushNote(1,'NOTE',n);
    // ── Research tasks (stored as NOTE records with prefix) ──
    for(const t of(p.tasks||[]))pushNote(1,'NOTE',(t.done?'[TASK:done]':'[TASK]')+t.text);
    // ── Source citations ──
    if(p.sources)for(const sid of new Set(p.sources)){L.push(`1 SOUR ${sid.startsWith('@')?sid:escAt(sid)}`);raw(p._srcExtra?.[sid])}
    // ── Media (photo URLs stored as OBJE FILE) ──
    if(p.images)for(const imgUrl of p.images){
      if(imgUrl){L.push('1 OBJE');L.push(`2 FILE ${escAt(imgUrl)}`)}
    }
    raw(p._extra);
  }

  for(const f of Object.values(families)){
    L.push(`0 ${f.id} FAM`);
    if(f.husb){L.push(`1 HUSB ${f.husb}`);raw(f._linkExtra?.HUSB)}
    if(f.wife){L.push(`1 WIFE ${f.wife}`);raw(f._linkExtra?.WIFE)}
    for(const c of f.children){L.push(`1 CHIL ${c}`);raw(f._linkExtra?.['CHIL '+c])}
    // ── Marriage event ──
    if(hasData(f.marr))pushEvent(f.marr,{tag:'MARR',val:''});
    // ── Other family events ──
    for(const e of(f.events||[]))pushEvent(e);
    // ── Family notes (multi-line via CONT) ──
    for(const n of(f.notes||[]))pushNote(1,'NOTE',n);
    raw(f._extra);
  }

  // ── Source records ──
  for(const s of Object.values(sources)){
    L.push(`0 ${s.id} SOUR`);
    if(s.title)pushNote(1,'TITL',s.title);
    if(s.auth)pushNote(1,'AUTH',s.auth);
    if(s.publ)pushNote(1,'PUBL',s.publ);
    raw(s._extra);
  }
  // ── Records the app doesn't model (repositories, media, submitters…) ──
  for(const blk of extraRecords)raw(blk);

  L.push('0 TRLR');
  return L.join('\r\n'); // GEDCOM 7 recommends CRLF line endings
}

// ── ID generators ──
function newPersonId(){let n=Object.keys(persons).length+1;while(persons[`@I${n}@`])n++;return`@I${n}@`}
function newFamilyId(){let n=Object.keys(families).length+1;while(families[`@F${n}@`])n++;return`@F${n}@`}

// ── Auto-save ──
// Every change is written to a local backup immediately, then sent to the
// server 1.5s later. The backup is only cleared once the server confirms, so a
// closed tab, dropped connection or expired login never loses work. Saves carry
// the tree's last-known `modified` stamp; if someone else saved in between the
// server answers 409 and we ask instead of silently overwriting them.
let saveTimer=null,saveInFlight=null,pendingGed=null,saveFailToastShown=false;
const treeMod=new Map(); // treeId → server `modified` we last loaded or saved
function setSaveStatus(state,txt){
  const ind=document.getElementById('save-indicator');if(!ind)return;
  ind.className=state?'save-indicator '+state:'save-indicator';ind.title=txt;
  document.getElementById('save-status-text').textContent=txt;
}
const backupKey=id=>'ft_unsaved_'+id;
function writeBackup(id,ged){try{localStorage.setItem(backupKey(id),JSON.stringify({ged,base:treeMod.get(id)||0,at:Date.now()}))}catch(e){}}
function readBackup(id){try{return JSON.parse(localStorage.getItem(backupKey(id))||'null')}catch(e){return null}}
function clearBackup(id){try{localStorage.removeItem(backupKey(id))}catch(e){}}
function downloadGed(ged,name){
  const blob=new Blob([ged],{type:'text/plain;charset=utf-8'});
  _download(URL.createObjectURL(blob),`${String(name).replace(/[^a-z0-9 ()-]/gi,'-')}.ged`);
}
function scheduleSave(){
  timelineBuilt=false; // data changed — timeline must re-render on next visit
  if(!currentTreeId)return;
  setSaveStatus('saving','Saving…');
  pendingGed=generateGedcom();writeBackup(currentTreeId,pendingGed);
  clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,1500);
}
// Send the pending change now. Captures the tree synchronously, so callers may
// clear the globals straight afterwards (leaving a tree, logging out).
function saveNow(opts={}){
  clearTimeout(saveTimer);saveTimer=null;
  if(!currentTreeId||pendingGed===null)return saveInFlight||Promise.resolve(true);
  const id=currentTreeId,job={name:currentTreeName,gedcom:pendingGed,person_count:Object.keys(persons).length};
  pendingGed=null;
  const prev=saveInFlight;
  const run=(async()=>{
    if(prev)await prev.catch(()=>{}); // one save at a time, in order
    const modified=Math.max(Date.now(),(treeMod.get(id)||0)+1);
    const body={...job,modified};if(!opts.force)body.base_modified=treeMod.get(id)||0;
    const res=await apiUpdateTree(id,body,{conflictOk:true,quiet:true});
    const here=currentTreeId===id;
    if(res&&!res.conflict){
      treeMod.set(id,modified);saveFailToastShown=false;
      if(here&&pendingGed!==null)writeBackup(id,pendingGed);else clearBackup(id); // newer edits still queued keep their backup
      if(here&&!saveTimer&&pendingGed===null){setSaveStatus('saved','All changes saved');setTimeout(()=>{if(document.getElementById('save-indicator').classList.contains('saved'))setSaveStatus('','All changes saved')},2000)}
      return true;
    }
    if(res?.conflict){if(here)resolveConflict(id,job.gedcom);return false}
    if(here&&authToken){ // network/server error: keep the backup and retry
      if(pendingGed===null)pendingGed=job.gedcom;
      setSaveStatus('failed','Not saved yet — retrying…');
      if(!saveFailToastShown){showToast('⚠️ Couldn’t reach the server — your changes are kept on this device and will be retried',5000);saveFailToastShown=true}
      clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,15000);
    }
    return false;
  })();
  saveInFlight=run;run.finally(()=>{if(saveInFlight===run)saveInFlight=null});
  return run;
}
function resolveConflict(id,ged){
  const mine=pendingGed??ged;pendingGed=null;clearTimeout(saveTimer);saveTimer=null;
  setSaveStatus('failed','Someone else changed this tree');
  if(confirm('Someone else has saved changes to this tree since you opened it (perhaps on another device).\n\nOK: keep YOUR version (replaces their changes)\nCancel: load THEIR version (a copy of yours is downloaded first, so nothing is lost)')){
    pendingGed=mine;saveNow({force:true});
  }else{
    downloadGed(mine,currentTreeName+' (my version)');clearBackup(id);
    loadTreeById(id,{tab:currentTab,person:selectedId},true);
  }
}
// Leaving the page: try to deliver the last edit (keepalive requests are
// limited to ~64KB; anything bigger is recovered from the backup next visit).
addEventListener('pagehide',e=>{
  if(e.persisted||!currentTreeId||pendingGed===null)return; // bfcache: the page may come back and save normally
  const id=currentTreeId;
  const body=JSON.stringify({name:currentTreeName,gedcom:pendingGed,person_count:Object.keys(persons).length,modified:Math.max(Date.now(),(treeMod.get(id)||0)+1),base_modified:treeMod.get(id)||0});
  if(body.length<60000)try{fetch(`api.php?action=update&id=${id}`,{method:'POST',keepalive:true,headers:{'Content-Type':'application/json','Authorization':`Bearer ${authToken}`},body})}catch(e){}
});

// ── Celebration ──
// A short confetti burst for happy moments. Purely decorative: hidden from
// assistive tech and skipped entirely when the user prefers reduced motion.
function celebrate(){
  if(matchMedia('(prefers-reduced-motion: reduce)').matches)return;
  const box=document.createElement('div');box.className='confetti';box.setAttribute('aria-hidden','true');
  const cols=['#a78bfa','#f472b6','#fbbf24','#34d399','#60a5fa','#fb7185'];
  for(let i=0;i<36;i++){const c=document.createElement('i');c.style.cssText=`left:${50+(Math.random()-.5)*30}%;background:${cols[i%cols.length]};--dx:${(Math.random()-.5)*520}px;--dy:${-180-Math.random()*260}px;--r:${Math.random()*720-360}deg;animation-delay:${Math.random()*.12}s`;box.appendChild(c)}
  document.body.appendChild(box);setTimeout(()=>box.remove(),1800);
}

// ── Utilities ──
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function truncate(s,n=28){return s.length>n?s.slice(0,n-1)+'…':s}
function extractYear(d){if(!d)return null;const m=d.match(/\b(\d{4})\b/);return m?+m[1]:null}
function lifespan(p){
  const b=extractYear(p.birth.date),d=extractYear(p.death.date);
  if(b&&d)return`${b}–${d}`;
  if(b&&p.death.confirmed)return`${b}–†`;
  if(b)return`b. ${b}`;
  if(d)return`d. ${d}`;
  if(p.death.confirmed)return`† deceased`;
  return'';
}
function sexClass(p){if(!p)return'unknown';return p.sex==='M'?'male':p.sex==='F'?'female':'unknown'}
function sexColor(p){if(!p)return'#555';return p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8'}
function hasExtraData(p){return p.events.length>0||p.notes.length>0||p.images.length>0}
function getSortedPersons(){
  const arr=Object.values(persons);
  if(currentSort==='birth'){return arr.sort((a,b)=>{const ay=extractYear(a.birth.date)||9999,by=extractYear(b.birth.date)||9999;return ay-by||(a.name.localeCompare(b.name))})}
  if(currentSort==='birth-desc'){return arr.sort((a,b)=>{const ay=extractYear(a.birth.date)||0,by=extractYear(b.birth.date)||0;return by-ay||(a.name.localeCompare(b.name))})}
  return arr.sort((a,b)=>(a.nameSur||a.name).toLowerCase().localeCompare((b.nameSur||b.name).toLowerCase()));
}
function showToast(msg,dur=2000){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),dur)}
function relTs(ts){if(!ts)return'never';const d=new Date(ts),n=new Date(),df=n-d;if(df<60000)return'just now';if(df<3600000)return Math.round(df/60000)+'m ago';if(df<86400000)return Math.round(df/3600000)+'h ago';return d.toLocaleDateString()}

// ── Date normalisation ──
const MON_NAMES=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function normaliseDate(s){
  if(!s)return s;s=s.trim();
  if(!s)return s;
  // Already GEDCOM-ish (DD MON YYYY, MON YYYY, YYYY, or prefixes like BEF/AFT/ABT/CIR)
  if(/^(BEF|AFT|ABT|CIR|EST|CAL|BET)?\s*\d{1,2}\s+[A-Z]{3}\s+\d{4}$/i.test(s)||/^(BEF|AFT|ABT|CIR|EST|CAL)?\s*[A-Z]{3}\s+\d{4}$/i.test(s)||/^\d{4}$/.test(s))return s.toUpperCase();
  // ISO: YYYY-MM-DD
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(m){const mn=+m[2]-1;if(mn>=0&&mn<12)return`${+m[3]} ${MON_NAMES[mn]} ${m[1]}`}
  // DD/MM/YYYY
  m=s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if(m){const day=+m[1],mon=+m[2]-1;if(mon>=0&&mon<12&&day>=1&&day<=31)return`${day} ${MON_NAMES[mon]} ${m[3]}`}
  // Month names written out: "30 june 1973", "June 30, 1973", "abt June 1850", "Sept 1901"
  const FULL=['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
  const mon=w=>{w=w.replace('.','').toUpperCase();const i=FULL.findIndex(f=>w.length>=3&&f.startsWith(w));return i>=0?MON_NAMES[i]:null};
  m=s.match(/^(BEF|AFT|ABT|CIR|EST|CAL)?\.?\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+\.?),?\s+(\d{4})$/i);
  if(m&&mon(m[3]))return`${m[1]?m[1].toUpperCase()+' ':''}${+m[2]} ${mon(m[3])} ${m[4]}`;
  m=s.match(/^(BEF|AFT|ABT|CIR|EST|CAL)?\.?\s*([A-Za-z]+\.?)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i);
  if(m&&mon(m[2]))return`${m[1]?m[1].toUpperCase()+' ':''}${+m[3]} ${mon(m[2])} ${m[4]}`;
  m=s.match(/^(BEF|AFT|ABT|CIR|EST|CAL)?\.?\s*([A-Za-z]+\.?),?\s+(\d{4})$/i);
  if(m&&mon(m[2]))return`${m[1]?m[1].toUpperCase()+' ':''}${mon(m[2])} ${m[3]}`;
  return s; // return unchanged if unrecognised
}

// ── Undo ──
function snapshotState(){
  undoStack.push({p:JSON.stringify(persons),f:JSON.stringify(families),s:JSON.stringify(sources)});
  if(undoStack.length>15)undoStack.shift();
}
function undoLast(){
  if(!undoStack.length){showToast('Nothing to undo');return}
  const snap=undoStack.pop();
  persons=JSON.parse(snap.p);families=JSON.parse(snap.f);if(snap.s)sources=JSON.parse(snap.s);
  if(selectedId&&!persons[selectedId])selectedId=null;
  updateSidebar();renderCurrentTab();scheduleSave();showToast('Undone ↩');
}

// ── Validation ──
function validatePersonData(birthDate,deathDate,fatherId,motherId){
  const warns=[];const by=extractYear(birthDate),dy=extractYear(deathDate);
  if(by&&dy&&dy<by)warns.push('Death year is before birth year.');
  if(by&&dy&&dy-by>120)warns.push(`Lifespan of ${dy-by} years seems unusually long.`);
  if(by&&by>new Date().getFullYear())warns.push('Birth year is in the future.');
  const fa=fatherId?persons[fatherId]:null,mo=motherId?persons[motherId]:null;
  if(fa&&by){const fb=extractYear(fa.birth.date);if(fb&&fb>by)warns.push(`Father "${fa.name}" born after this person.`)}
  if(mo&&by){const mb=extractYear(mo.birth.date);if(mb&&mb>by)warns.push(`Mother "${mo.name}" born after this person.`)}
  return warns;
}
function findDuplicates(fullName,excludeId){
  return Object.values(persons).filter(p=>p.id!==excludeId&&p.name.toLowerCase()===fullName.toLowerCase());
}
function dupeContext(p){
  const parts=[];
  const ls=lifespan(p);if(ls)parts.push(ls);
  const parents=getParents(p.id);
  if(parents.length)parts.push('child of '+parents.map(r=>r.name).join(' & '));
  const spouses=getSpouses(p.id);
  if(spouses.length)parts.push('spouse of '+spouses.map(s=>s.person.name).join(' & '));
  const children=getChildren(p.id);
  if(children.length)parts.push(children.length===1?'parent of '+children[0].name:`parent of ${children.length} children`);
  return parts.length?parts.join('; '):'no relations recorded';
}

// ── Relate to all ──
function computeRelToAll(){
  if(!selectedId){relToAllCache={};return}
  relToAllCache={};
  for(const id of Object.keys(persons)){
    if(id===selectedId)continue;
    relToAllCache[id]=findRelationship(selectedId,id);
  }
}

// ── Merge GEDCOM ──
function mergeGedcomFile(text){
  snapshotState();
  const mine={p:persons,f:families,s:sources,x:extraRecords};
  parseGedcom(text); // clobbers the globals temporarily
  const inc={p:persons,f:families,s:sources,x:extraRecords};
  persons=mine.p;families=mine.f;sources=mine.s;extraRecords=mine.x;
  // Give every incoming record an ID that doesn't clash with this tree, then
  // rewrite all references (links, citations, kept raw lines) in a single pass
  const recId=blk=>{const m=blk[0].match(/^0\s+(@[^@]+@)/);return m?safeId(m[1]):null};
  const used=new Set([...Object.keys(persons),...Object.keys(families),...Object.keys(sources),...extraRecords.map(recId).filter(Boolean)]);
  const map={};
  const claim=(id,prefix)=>{if(!used.has(id)){used.add(id);return}let n=1;while(used.has(`@${prefix}${n}@`))n++;const nid=`@${prefix}${n}@`;used.add(nid);map[id]=nid};
  Object.keys(inc.p).forEach(id=>claim(id,'I'));Object.keys(inc.f).forEach(id=>claim(id,'F'));Object.keys(inc.s).forEach(id=>claim(id,'S'));
  inc.x.forEach(b=>{const id=recId(b);if(id)claim(id,'X')});
  const out=Object.keys(map).length?JSON.parse(JSON.stringify(inc).replace(/@[A-Za-z0-9_.:+-]+@/g,t=>map[t]||t)):inc;
  Object.assign(persons,out.p);Object.assign(families,out.f);Object.assign(sources,out.s);extraRecords.push(...out.x);
  const addedP=Object.keys(out.p).length,addedF=Object.keys(out.f).length;
  updateSidebar();renderCurrentTab();scheduleSave();
  showToast(`🔀 Merged: ${addedP} people, ${addedF} families added`,3000);
}

// ── Print ──
function exportPrint(){window.print()}

// ── Graph helpers ──
function getChildren(pid){const p=persons[pid];if(!p)return[];const k=new Set();for(const fid of p.fams){const f=families[fid];if(f)f.children.forEach(c=>k.add(c))}return[...k].map(id=>persons[id]).filter(Boolean).sort((a,b)=>{const ay=extractYear(a.birth.date),by=extractYear(b.birth.date);if(ay===null&&by===null)return 0;if(ay===null)return 1;if(by===null)return -1;return ay-by})}
function getSpouses(pid){const p=persons[pid];if(!p)return[];const r=[];for(const fid of p.fams){const f=families[fid];if(!f)continue;const sid=f.husb===pid?f.wife:f.husb;if(sid&&persons[sid])r.push({person:persons[sid],fam:f})}return r}
function getSiblings(pid){const p=persons[pid];if(!p)return[];const s=new Set();for(const fid of p.famc){const f=families[fid];if(f)f.children.forEach(c=>{if(c!==pid)s.add(c)})}return[...s].map(id=>persons[id]).filter(Boolean)}
function getParents(pid){const p=persons[pid];if(!p)return[];const r=[];for(const fid of p.famc){const f=families[fid];if(!f)continue;if(f.husb&&persons[f.husb])r.push(persons[f.husb]);if(f.wife&&persons[f.wife])r.push(persons[f.wife])}return r}
function getAllAncestors(pid,v=new Set()){if(v.has(pid))return v;v.add(pid);for(const p of getParents(pid))getAllAncestors(p.id,v);return v}
function getDescendants(pid,v=new Set()){if(v.has(pid))return v;v.add(pid);for(const c of getChildren(pid))getDescendants(c.id,v);return v}

// ── Display name (includes nickname in parens) ──
// e.g.  John (Jack) Smith  or  Mary (Polly)  when no surname
function displayName(p){
  if(!p)return'Unknown';
  if(!p.nickname)return p.name;
  const g=p.nameGiven||'',s=p.nameSur||'';
  if(g&&s)return`${g} (${p.nickname}) ${s}`;
  if(g)return`${g} (${p.nickname})`;
  return`${p.name} (${p.nickname})`;
}

// ── Relationship Finder ──
function buildAncMap(pid){const m=new Map();const q=[[pid,0]];while(q.length){const[id,d]=q.shift();if(m.has(id))continue;m.set(id,d);for(const p of getParents(id))q.push([p.id,d+1])}return m}
function findRelationship(a,b){
  if(a===b)return'Same person';
  const pA=persons[a],pB=persons[b];if(!pA||!pB)return'Unknown';
  for(const sp of getSpouses(a))if(sp.person.id===b)return'Spouse';
  // ── Blood relationship (ancestor BFS) ──
  const ancA=buildAncMap(a),ancB=buildAncMap(b);
  let best=null,bestD=Infinity;
  for(const[id,dA]of ancA){if(ancB.has(id)){const t=dA+ancB.get(id);if(t<bestD){bestD=t;best={id,dA,dB:ancB.get(id)}}}}
  if(best){
    const{dA,dB}=best;
    if(dA===0){if(dB===1)return'Parent';if(dB===2)return'Grandparent';return Array(dB-2).fill('Great-').join('')+'Grandparent'}
    if(dB===0){if(dA===1)return'Child';if(dA===2)return'Grandchild';return Array(dA-2).fill('Great-').join('')+'Grandchild'}
    if(dA===1&&dB===1)return'Sibling';
    if(dA===1&&dB===2)return'Niece/Nephew';
    if(dA===2&&dB===1)return'Aunt/Uncle';
    if(dA===2&&dB===2)return'1st Cousin';
    const cd=Math.min(dA,dB)-1,rm=Math.abs(dA-dB);
    const ords=['','1st','2nd','3rd','4th','5th','6th','7th'];
    const ord=ords[cd]||`${cd}th`;
    return`${ord} Cousin${rm?` ${rm}x removed`:''}`;
  }
  // ── Extended: full-graph BFS crossing spouse edges ──
  const extPath=findExtendedPath(a,b);
  if(!extPath)return'No known relationship';
  return describeExtendedRel(extPath);
}

// BFS through parents, children AND spouses — finds in-law / step paths
function findExtendedPath(startId,endId){
  if(startId===endId)return[{id:startId,edge:null}];
  const visited=new Set([startId]);
  const queue=[{id:startId,path:[{id:startId,edge:null}]}];
  while(queue.length){
    const{id,path}=queue.shift();
    if(path.length>12)continue; // depth cap keeps large trees fast
    const neighbors=[];
    for(const par of getParents(id))neighbors.push({id:par.id,edge:'P'}); // parent
    for(const ch of getChildren(id))neighbors.push({id:ch.id,edge:'C'});  // child
    for(const sp of getSpouses(id))neighbors.push({id:sp.person.id,edge:'S'}); // spouse
    for(const{id:nid,edge}of neighbors){
      if(visited.has(nid))continue;
      visited.add(nid);
      const newPath=[...path,{id:nid,edge}];
      if(nid===endId)return newPath;
      queue.push({id:nid,path:newPath});
    }
  }
  return null;
}

// Map edge-sequence keys to plain-English in-law labels
// P=parent, C=child, S=spouse; key is A's perspective looking at B
function describeExtendedRel(path){
  const key=path.slice(1).map(n=>n.edge).join('');
  // Named patterns (most common first)
  const named={
    'SP':  'Parent-in-law',
    'PS':  "Parent's spouse (step-parent)",
    'CS':  'Child-in-law',
    'SC':  "Spouse's child (step-child)",
    'PCS': "Sibling's spouse (in-law)",
    'SPC': "Spouse's sibling (in-law)",
    'SSP': 'Spouse\'s parent (grandparent-in-law?)',
    'SPP': 'Grandparent-in-law',
    'CCS': "Grandchild's spouse",
    'SCC': "Spouse's grandchild",
    'PCCS':"Niece/nephew's spouse",
    'SPCC':"Spouse's niece/nephew (aunt/uncle-in-law)",
    'PPCS':"Aunt/uncle's spouse",
    'SPPC':"Spouse's aunt/uncle",
    'CSPC':"Child's sibling-in-law",
    'PPS': "Grandparent's spouse",
    'CPS': "Child's parent-in-law",
    'PCSP':"Sibling-in-law's parent",
    'SPCS':"Spouse's sibling-in-law",
    'PPCCS': "1st Cousin's spouse",
    'SPPCC': "Spouse's 1st cousin",
  };
  if(named[key])return named[key];
  const spouseCount=(key.match(/S/g)||[]).length;
  const via=path[1]?persons[path[1].id]?.name:'';
  if(spouseCount===1)return`Related by marriage — via ${via||'...'}`;
  return`Connected by marriage (${path.length-1} steps)`;
}

function findRelPath(a,b){
  if(a===b)return[a];
  for(const sp of getSpouses(a))if(sp.person.id===b)return[a,b];
  // Blood path via LCA
  const ancA=buildAncMap(a),ancB=buildAncMap(b);
  let lca=null,minD=Infinity;
  for(const[id,dA]of ancA){if(ancB.has(id)){const t=dA+ancB.get(id);if(t<minD){minD=t;lca=id}}}
  if(lca){
    function pathUp(startId,anc){
      const pred=new Map([[startId,null]]);const q=[startId];
      while(q.length){const c=q.shift();if(c===anc)break;for(const p of getParents(c)){if(!pred.has(p.id)){pred.set(p.id,c);q.push(p.id)}}}
      const path=[];let node=anc;const seen=new Set();
      while(node!==null&&node!==undefined&&!seen.has(node)){seen.add(node);path.unshift(node);node=pred.get(node)}
      return path;
    }
    return[...pathUp(a,lca),...pathUp(b,lca).slice(0,-1).reverse()];
  }
  // Fall back to full-graph path (for in-law connections)
  const ext=findExtendedPath(a,b);
  return ext?ext.map(n=>n.id):[a,b];
}

// ── Person Info Modal ──
function showPersonModal(id){
  const p=persons[id];if(!p)return;
  const by=extractYear(p.birth.date);
  function ageAt(ds){const y=extractYear(ds);return(by&&y&&y>by)?` <span style="color:#777;font-size:11px">(age ${y-by})</span>`:''}
  let h=`<div class="modal-title">${esc(displayName(p))}</div>`;
  const ls=lifespan(p);if(ls)h+=`<div class="modal-sub">${esc(ls)}</div>`;
  if(p.birth.date||p.birth.plac){h+=`<div class="modal-section"><div class="modal-section-title">Birth</div>`;if(p.birth.date)h+=`<div class="modal-row"><span>Date:</span> ${esc(p.birth.date)}${p.birth.conf?`<span class="conf-badge conf-${p.birth.conf}">${esc(p.birth.conf)}</span>`:''}</div>`;if(p.birth.plac)h+=`<div class="modal-row"><span>Place:</span> ${esc(p.birth.plac)}</div>`;h+=`</div>`}
  if(p.death.date||p.death.plac||p.death.confirmed){
    h+=`<div class="modal-section"><div class="modal-section-title">Death</div>`;
    if(!p.death.date&&!p.death.plac)h+=`<div class="modal-row" style="color:#888;font-style:italic">† Deceased — date and place unknown</div>`;
    if(p.death.date)h+=`<div class="modal-row"><span>Date:</span> ${esc(p.death.date)}${ageAt(p.death.date)}${p.death.conf?`<span class="conf-badge conf-${p.death.conf}">${esc(p.death.conf)}</span>`:''}</div>`;
    if(p.death.plac)h+=`<div class="modal-row"><span>Place:</span> ${esc(p.death.plac)}</div>`;
    if(p.death.caus)h+=`<div class="modal-row"><span>Cause:</span> ${esc(p.death.caus)}</div>`;
    h+=`</div>`;
  }
  if(p.events.length){h+=`<div class="modal-section"><div class="modal-section-title">Events</div>`;for(const e of p.events){const lbl=EVT_LABEL[e._tag]||e._tag;let s=lbl;if(e.val)s+=`: ${e.val}`;if(e.date)s+=` — ${e.date}`;if(e.plac)s+=`, ${e.plac}`;h+=`<div class="modal-row">${esc(s)}${ageAt(e.date)}</div>`}h+=`</div>`}
  const parents=getParents(id);
  if(parents.length){h+=`<div class="modal-section"><div class="modal-section-title">Parents</div>`;for(const par of parents)h+=`<div class="modal-row"><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${par.id}" data-close="person-modal">${esc(displayName(par))}</a> <span>${esc(lifespan(par))}</span></div>`;h+=`</div>`}
  const spouses=getSpouses(id);
  if(spouses.length){h+=`<div class="modal-section"><div class="modal-section-title">Spouses</div>`;for(const{person:sp,fam}of spouses){let s=`<a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${sp.id}" data-close="person-modal">${esc(displayName(sp))}</a>`;if(fam.marr.date||fam.marr.plac){s+=` <span>(m.`;if(fam.marr.date)s+=` ${esc(fam.marr.date)}`;if(fam.marr.plac)s+=` ${esc(fam.marr.plac)}`;const marY=extractYear(fam.marr.date);if(by&&marY&&marY>=by)s+=`, age ${marY-by}`;s+=`)</span>`}h+=`<div class="modal-row">${s}</div>`}h+=`</div>`}
  const sibs=getSiblings(id);
  if(sibs.length){h+=`<div class="modal-section"><div class="modal-section-title">Siblings (${sibs.length})</div>`;for(const s of sibs)h+=`<div class="modal-row"><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${s.id}" data-close="person-modal">${esc(displayName(s))}</a> <span>${esc(lifespan(s))}</span></div>`;h+=`</div>`}
  const children=getChildren(id);
  if(children.length){h+=`<div class="modal-section"><div class="modal-section-title">Children (${children.length})</div>`;for(const c of children)h+=`<div class="modal-row"><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${c.id}" data-close="person-modal">${esc(displayName(c))}</a> <span>${esc(lifespan(c))}</span></div>`;h+=`</div>`}
  if(p.notes.length){h+=`<div class="modal-section"><div class="modal-section-title">Notes</div>`;for(const n of p.notes)h+=`<div class="modal-row" style="white-space:pre-wrap;font-size:12px;color:#999">${esc(n)}</div>`;h+=`</div>`}
  if(p.tasks&&p.tasks.length){h+=`<div class="modal-section"><div class="modal-section-title">Research Tasks</div>`;for(const t of p.tasks)h+=`<div class="modal-row" style="display:flex;align-items:center;gap:6px"><input type="checkbox" ${t.done?'checked':''} disabled><span class="${t.done?'task-done-text':''}">${esc(t.text)}</span></div>`;h+=`</div>`}
  for(const img of p.images)h+=`<img class="modal-img" src="${esc(img)}" alt="Photo" loading="lazy">`;
  h+=`<div class="modal-btn-row">
    <button class="modal-btn primary" data-act="edit" data-id="${id}" data-close="person-modal">Edit</button>
    <button class="modal-btn" data-act="rel" data-id="${id}">Find Relationship</button>
    <button class="modal-btn" data-act="copy-person" data-id="${id}">Copy</button>
    <button class="modal-btn" data-act="sheet" data-id="${id}">🖨 Family Sheet</button>
    <button class="modal-btn" data-act="bio" data-id="${id}">📝 Biography</button>
    <button class="modal-btn danger" data-act="del-person" data-id="${id}" style="margin-left:auto">Delete</button>
  </div>`;
  document.getElementById('person-modal-content').innerHTML=h;
  document.getElementById('person-modal').classList.remove('hidden');
  document.querySelector('#person-modal .modal-close').focus();
}
function closeModal(id){
  const el=document.getElementById(id);
  if(id==='edit-modal'&&!el.classList.contains('hidden')){
    if(editDirty&&!confirm('Discard your unsaved changes?'))return false;
    for(const pid of editCreatedIds)delete persons[pid]; // never linked, so don't leave orphans behind
    editCreatedIds=[];editDirty=false;
  }
  el.classList.add('hidden');return true;
}

// ── Dialog focus management ──
// Opening any overlay remembers what had focus, moves focus inside, and makes
// everything else inert (no tabbing or screen-reader browsing behind it).
// Closing hands focus back. Works for every dialog without touching callers.
const _dlgStack=[];
function _focusables(root){return[...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')].filter(el=>el.getClientRects().length)}
function _syncInert(){
  const top=_dlgStack[_dlgStack.length-1]||null;
  for(const el of document.body.children){if(el.id==='toast'||el.classList.contains('place-suggestions')||el.tagName==='SCRIPT')continue;el.inert=!!top&&el!==top}
}
{
  const obs=new MutationObserver(muts=>{
    for(const m of muts){
      const o=m.target,open=!o.classList.contains('hidden'),i=_dlgStack.indexOf(o);
      if(open&&i<0){
        o._returnFocus=document.activeElement;_dlgStack.push(o);_syncInert();
        requestAnimationFrame(()=>{if(!o.contains(document.activeElement)){const f=o.querySelector('[autofocus]')||_focusables(o)[0];f?.focus()}});
      }else if(!open&&i>=0){
        _dlgStack.splice(i,1);_syncInert();
        const r=o._returnFocus;o._returnFocus=null;
        if(r&&r.isConnected&&!r.closest('[inert]')&&r.getClientRects().length)r.focus();
        else if(!_dlgStack.length&&document.getElementById('app').classList.contains('visible'))document.getElementById('content').focus();
      }
    }
  });
  document.querySelectorAll('.modal-overlay,#kbd-overlay,#login-overlay').forEach(o=>obs.observe(o,{attributes:true,attributeFilter:['class']}));
}
// Clicking the dimmed backdrop closes a dialog (not the edit form — too easy to lose work)
document.addEventListener('mousedown',e=>{const o=e.target;if(o.classList?.contains('modal-overlay')&&o.id!=='edit-modal')o._downOnBackdrop=true});
document.addEventListener('click',e=>{const o=e.target;if(o._downOnBackdrop){o._downOnBackdrop=false;if(o===e.target)closeModal(o.id)}});
document.getElementById('kbd-overlay').addEventListener('click',e=>{if(e.target.id==='kbd-overlay')e.target.classList.add('hidden')});
{
  const em=document.getElementById('edit-modal');
  em.addEventListener('input',()=>{editDirty=true});em.addEventListener('change',()=>{editDirty=true});
}

// ── Header "More" menu (WAI-ARIA menu button) ──
function _menuItems(){return[...document.querySelectorAll('#more-menu [role=menuitem]')].filter(b=>b.style.display!=='none')}
function openMenu(focusLast){
  const m=document.getElementById('more-menu'),b=document.getElementById('btn-more');
  m.hidden=false;b.setAttribute('aria-expanded','true');
  const items=_menuItems();(focusLast?items[items.length-1]:items[0])?.focus();
}
function closeMenu(returnFocus){
  const m=document.getElementById('more-menu'),b=document.getElementById('btn-more');if(m.hidden)return;
  m.hidden=true;b.setAttribute('aria-expanded','false');if(returnFocus)b.focus();
}
document.getElementById('btn-more').addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();openMenu(e.key==='ArrowUp')}
});
document.getElementById('more-menu').addEventListener('keydown',e=>{
  const items=_menuItems(),i=items.indexOf(document.activeElement);
  const n=e.key==='ArrowDown'?(i+1)%items.length:e.key==='ArrowUp'?(i-1+items.length)%items.length:e.key==='Home'?0:e.key==='End'?items.length-1:null;
  if(n!==null){e.preventDefault();items[n].focus();return}
  if(e.key==='Escape'){e.preventDefault();closeMenu(true)}
  else if(e.key==='Tab')closeMenu(false);
  else if(e.key.length===1){
    // Type-ahead on the item's words, skipping the leading emoji
    const k=e.key.toLowerCase(),lbl=b=>b.textContent.replace(/^[^\p{L}\p{N}]+/u,'').toLowerCase();
    const hit=items.find((b,j)=>j>i&&lbl(b).startsWith(k))||items.find(b=>lbl(b).startsWith(k));if(hit){e.preventDefault();hit.focus()}
  }
});
document.addEventListener('click',e=>{if(!e.target.closest('.menu-wrap'))closeMenu(false)});

// ── Combobox keyboard support ──
// Shared by the parent/spouse/child/sibling pickers, relationship search and
// place autocomplete: ↑/↓ move through [role=option] items, Enter picks,
// Escape closes (without also closing the surrounding dialog).
function comboKeys(inp,box,isOpen,hide){
  inp.addEventListener('keydown',e=>{
    if(!isOpen())return;
    const items=[...box.querySelectorAll('[role=option]')];if(!items.length)return;
    const cur=box.querySelector('[role=option].act');let i=items.indexOf(cur);
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){
      e.preventDefault();i=e.key==='ArrowDown'?Math.min(i+1,items.length-1):Math.max(i-1,0);
      items.forEach(x=>{x.classList.remove('act');x.setAttribute('aria-selected','false')});
      items[i].classList.add('act');items[i].setAttribute('aria-selected','true');
      inp.setAttribute('aria-activedescendant',items[i].id);items[i].scrollIntoView({block:'nearest'});
    }else if(e.key==='Enter'&&cur){e.preventDefault();cur.click()}
    else if(e.key==='Escape'){e.preventDefault();hide()}
  });
}
function comboInit(inp,box,label){
  inp.setAttribute('role','combobox');inp.setAttribute('aria-autocomplete','list');inp.setAttribute('aria-expanded','false');inp.setAttribute('aria-controls',box.id);
  box.setAttribute('role','listbox');if(label)box.setAttribute('aria-label',label);
}
function comboSetOpen(inp,open){inp.setAttribute('aria-expanded',open?'true':'false');if(!open)inp.removeAttribute('aria-activedescendant')}
function copyPersonSummary(id){
  const p=persons[id];if(!p)return;
  let txt=p.name;const ls=lifespan(p);if(ls)txt+=` (${ls})`;
  if(p.birth.plac)txt+=`\nBorn: ${p.birth.plac}`;
  if(p.death.plac)txt+=`\nDied: ${p.death.plac}`;
  const sp=getSpouses(id);if(sp.length)txt+=`\nSpouse(s): ${sp.map(s=>s.person.name).join(', ')}`;
  const ch=getChildren(id);if(ch.length)txt+=`\nChildren: ${ch.length}`;
  navigator.clipboard.writeText(txt).catch(()=>{});
  showToast('Copied!');
}

// ── Relationship Modal ──
let relPersonA=null;
function openRelModal(id){
  closeModal('person-modal');relPersonA=id;const p=persons[id];
  document.getElementById('rel-person-a').textContent=`Person A: ${p?p.name:id}`;
  document.getElementById('rel-search').value='';
  document.getElementById('rel-matches').innerHTML='';
  document.getElementById('rel-result').style.display='none';
  document.getElementById('rel-modal').classList.remove('hidden');
  setTimeout(()=>document.getElementById('rel-search').focus(),50);
}
{
  const inp=document.getElementById('rel-search'),box=document.getElementById('rel-matches');
  comboInit(inp,box,'Matching people');
  inp.addEventListener('input',function(){
    const q=this.value.toLowerCase().trim();
    if(!q){box.innerHTML='';comboSetOpen(inp,false);return}
    const matches=Object.values(persons).filter(p=>p.id!==relPersonA&&p.name.toLowerCase().includes(q)).slice(0,12);
    box.innerHTML=matches.length?matches.map((p,i)=>`<div class="rel-match" id="rel-o${i}" role="option" aria-selected="false" data-act="compute-rel" data-id="${p.id}">${avatarHtml(p,'xs')}${esc(displayName(p))} <span class="sugg-years">${esc(lifespan(p))}</span></div>`).join(''):'<div class="rel-none" role="presentation">No one by that name — try another spelling.</div>';
    comboSetOpen(inp,matches.length>0);
  });
  comboKeys(inp,box,()=>!!box.querySelector('[role=option]'),()=>{box.innerHTML='';comboSetOpen(inp,false)});
}
function computeRel(idB){
  document.getElementById('rel-matches').innerHTML='';document.getElementById('rel-search').value='';comboSetOpen(document.getElementById('rel-search'),false);
  if(!relPersonA||!idB)return;
  const rel=findRelationship(relPersonA,idB);
  const pA=persons[relPersonA],pB=persons[idB];
  const resEl=document.getElementById('rel-result');resEl.style.display='block';
  const path=findRelPath(relPersonA,idB);
  let pathH='';
  if(path.length>1){
    const nodes=path.map((id,idx)=>{
      const nm=persons[id]?.name||id;
      const arrow=idx>0?`<span class="rel-path-arrow">→</span>`:'';
      return`${arrow}<span class="rel-path-node" role="button" tabindex="0" data-act="select" data-id="${id}" data-close="rel-modal" title="${esc(nm)}">${esc(nm.length>18?nm.slice(0,17)+'…':nm)}</span>`;
    }).join('');
    pathH=`<div class="rel-path">${nodes}</div>`;
  }
  resEl.setAttribute('role','status');
  resEl.innerHTML=`<div style="font-size:13px;margin-bottom:4px"><strong>${esc(pA?pA.name:relPersonA)}</strong> → <strong>${esc(pB?pB.name:idB)}</strong></div><div style="color:#a78bfa;font-weight:600;font-size:14px">${esc(rel)}</div>${pathH}`;
}
// (btn-shortcuts is wired via data-act="kbd" in the delegated dispatcher)

// ── Edit Person Modal ──
function openEditModal(id){
  editingId=id||null;const isNew=!id;const p=id?persons[id]:null;
  editDirty=false;editCreatedIds=[];
  // Init working state
  if(p){
    editSpouses=getSpouses(id).map(({person:sp,fam})=>{
      const divEvt=(fam.events||[]).find(e=>e._tag==='DIV');
      return{personId:sp.id,famId:fam.id,marrDate:fam.marr.date||'',marrPlace:fam.marr.plac||'',divDate:divEvt?.date||'',divPlace:divEvt?.plac||''};
    });
    if(p.famc.length>0){const fam=families[p.famc[0]];editParent={father:fam?fam.husb:null,mother:fam?fam.wife:null}}
    else editParent={father:null,mother:null};
    // Collect all children across all spouse families
    editChildren=[];
    for(const famId of p.fams){const fam=families[famId];if(fam)for(const cId of fam.children)editChildren.push({personId:cId,famId});}
  }else{editSpouses=[];editParent={father:null,mother:null};editChildren=[];}
  editRemovedFams=new Set();editRemovedChildren=new Map();editAddedSiblings=[];
  editPhotos=(p?.images||[]).map(url=>({url}));
  editSources=(p?.sources||[]).map(sid=>({sid,title:sources[sid]?.title||sid}));
  document.getElementById('edit-modal-title').textContent=isNew?'🌱 Add someone new':`✏️ Edit ${p.name}`;
  document.getElementById('ef-given').value=p?.nameGiven||'';
  document.getElementById('ef-surname').value=p?.nameSur||'';
  document.getElementById('ef-nickname').value=p?.nickname||'';
  document.getElementById('ef-sex').value=p?.sex||'U';
  document.getElementById('ef-living').checked=p?.living||false;
  document.getElementById('ef-birth-date').value=p?.birth.date||'';
  document.getElementById('ef-birth-place').value=p?.birth.plac||'';
  document.getElementById('ef-death-date').value=p?.death.date||'';
  document.getElementById('ef-death-place').value=p?.death.plac||'';
  document.getElementById('ef-death-confirmed').checked=p?.death.confirmed||false;
  document.getElementById('ef-cause-death').value=p?.death.caus||'';
  document.getElementById('ef-birth-conf').value=p?.birth.conf||'';
  document.getElementById('ef-death-conf').value=p?.death.conf||'';
  document.getElementById('ef-notes').value=(p?.notes||[]).join('\n');
  editTasks=(p?.tasks||[]).map(t=>({...t}));
  editResi=(p?.residences||[]).map(r=>({...r}));
  renderEditEvents(p?.events||[]);
  renderEditPhotos();renderEditSources();
  renderEditTasks();renderEditResi();
  renderEditSpouses();
  renderEditParents();
  renderEditChildren();
  renderEditSiblings();
  document.getElementById('btn-delete-person').style.display=isNew?'none':'';
  document.getElementById('edit-modal').classList.remove('hidden');
  setTimeout(()=>{document.getElementById('ef-given').focus();attachPlaceAC();document.querySelector('#edit-modal .modal-box').scrollTop=0},50);
}

// What the Details box means for each event type (shown as its placeholder)
const EVT_DETAIL_HINT={OCCU:'e.g. Engineer',EDUC:'e.g. Leeds University',RELI:'e.g. Methodist',NATI:'e.g. British',TITL:'e.g. Sir, Dr',EVEN:'What happened?',CENS:'e.g. Head of household',GRAD:'e.g. BSc Physics',ORDN:'e.g. Priest',EMIG:'e.g. To Australia',IMMI:'e.g. From Ireland',WILL:'e.g. Executor: John',PROB:'e.g. Effects £120'};
function renderEditEvents(events){
  const cont=document.getElementById('ef-events-list');cont.innerHTML='';
  (events||[]).forEach(evt=>cont.appendChild(eventRow(evt)));
}
function addEditEvent(){
  const row=eventRow(null);document.getElementById('ef-events-list').appendChild(row);
  row.querySelector('select').focus();
}
function eventRow(evt){
  const opts=Object.entries(EVT_LABEL).filter(([k])=>!['BIRT','DEAT'].includes(k)).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
  const row=document.createElement('div');row.className='event-row event-row-4';
  row.innerHTML=`<select class="form-input ev-type" aria-label="Event type">${opts}</select><input class="form-input ev-val" type="text" aria-label="Event details"><input class="form-input ev-date" type="text" placeholder="Date" aria-label="Event date"><input class="form-input ev-plac" type="text" placeholder="Place" aria-label="Event place"><button class="rm-btn" data-act="rm-row" type="button" aria-label="Remove event">✕</button>`;
  const sel=row.querySelector('.ev-type'),val=row.querySelector('.ev-val');
  if(evt){
    row._orig=evt; // keep note/type/conf/citations so saving doesn't wipe them
    sel.value=evt._tag;val.value=evt.val||'';row.querySelector('.ev-date').value=evt.date||'';row.querySelector('.ev-plac').value=evt.plac||'';
  }else sel.value='OCCU';
  const hint=()=>{val.placeholder=EVT_DETAIL_HINT[sel.value]||'Details (optional)'};
  sel.addEventListener('change',hint);hint();
  makePlaceDropdown(row.querySelector('.ev-plac'));
  return row;
}

function renderEditSpouses(){
  document.getElementById('ef-spouses-list').innerHTML=editSpouses.map((sp,i)=>{
    const p=persons[sp.personId];
    return`<div class="sp-block">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:5px">
        <span style="font-weight:600;color:#ccc;flex:1">${esc(p?p.name:'Unknown')}</span>
        <button class="rm-btn" data-act="rm-spouse" data-idx="${i}" type="button" title="Remove this marriage" aria-label="Remove this marriage">✕</button>
      </div>
      <div class="sp-row">
        <span class="sp-lbl">Married</span>
        <input class="form-input" type="text" placeholder="Date" aria-label="Marriage date" value="${esc(sp.marrDate)}" data-field="sp-marr-date" data-idx="${i}">
        <input class="form-input place-ac" type="text" placeholder="Place" aria-label="Marriage place" value="${esc(sp.marrPlace)}" data-field="sp-marr-place" data-idx="${i}">
      </div>
      <div class="sp-row">
        <span class="sp-lbl">Divorced</span>
        <input class="form-input" type="text" placeholder="Date" aria-label="Divorce date" value="${esc(sp.divDate||'')}" data-field="sp-div-date" data-idx="${i}">
        <input class="form-input place-ac" type="text" placeholder="Place" aria-label="Divorce place" value="${esc(sp.divPlace||'')}" data-field="sp-div-place" data-idx="${i}">
      </div>
    </div>`;
  }).join('');
  attachPlaceAC();
}
function removeEditSpouse(i){const sp=editSpouses[i];if(sp.famId)editRemovedFams.add(sp.famId);editSpouses.splice(i,1);renderEditSpouses()}

function renderEditChildren(){
  const list=document.getElementById('ef-children-list');
  const visible=editChildren.filter(c=>!editRemovedChildren.has(c.personId));
  if(!visible.length){list.innerHTML='<div style="font-size:12px;color:#9595b2;margin-bottom:5px">No children recorded.</div>';return}
  list.innerHTML=visible.map(c=>{
    const cp=persons[c.personId];
    const fam=families[c.famId];
    const coParentId=fam?(fam.husb===editingId?fam.wife:fam.husb):null;
    const coParent=coParentId?persons[coParentId]:null;
    const tag=coParent?`<span style="color:#9595b2;font-size:11px"> (with ${esc(truncate(coParent.name,16))})</span>`:'';
    return`<div class="rel-tag"><span>${esc(cp?cp.name:'Unknown')}${tag}</span><button class="rm-btn" data-act="rm-child" data-id="${c.personId}" type="button" title="Remove child link" aria-label="Remove child link">✕</button></div>`;
  }).join('');
}
function removeEditChild(personId){
  const entry=editChildren.find(c=>c.personId===personId);
  if(entry)editRemovedChildren.set(personId,entry.famId);
  renderEditChildren();
}

function removeEditSibling(personId){
  editAddedSiblings=editAddedSiblings.filter(s=>s.personId!==personId);
  renderEditSiblings();
}

// Create a new minimal person record and queue them as a child or sibling
function createAndLinkPerson(name,role){
  const parts=name.trim().split(/\s+/);
  const nameSur=parts.length>1?parts[parts.length-1]:'';
  const nameGiven=parts.length>1?parts.slice(0,-1).join(' '):parts[0];
  const fullName=name.trim()||'Unknown';
  const newId=newPersonId();editCreatedIds.push(newId);editDirty=true;
  persons[newId]={id:newId,name:fullName,nameGiven,nameSur,sex:'U',birth:{},death:{},events:[],notes:[],fams:[],famc:[],sources:[],images:[],tasks:[],residences:[]};
  if(role==='child'){
    let targetFamId=editSpouses.find(s=>s.famId)?.famId||null;
    editChildren.push({personId:newId,famId:targetFamId,isNew:true});
    editRemovedChildren.delete(newId);
    renderEditChildren();
  }else if(role==='sibling'){
    editAddedSiblings.push({personId:newId,isNew:true});
    renderEditSiblings();
  }
  showToast(`Created "${fullName}" — will be linked on save`);
}

function renderEditSiblings(){
  const list=document.getElementById('ef-siblings-list');
  const sibs=editingId?getSiblings(editingId):[];
  const added=editAddedSiblings.map(s=>persons[s.personId]).filter(Boolean);
  let html='';
  if(sibs.length){
    html+=`<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:5px">${sibs.map(s=>`<span style="background:#0c0c20;border:1px solid #1e1e42;border-radius:5px;padding:3px 9px;font-size:12px;color:#aaa">${esc(s.name)}</span>`).join('')}</div>`;
    if(sibs.length)html+=`<div style="font-size:11px;color:#9595b2;margin-bottom:6px">⚠ To remove an existing sibling link, clear this person's parents above.</div>`;
  }else if(!added.length){
    html='<div style="font-size:12px;color:#9595b2;margin-bottom:5px">No shared-parent siblings yet.</div>';
  }
  if(added.length){
    html+=`<div style="display:flex;flex-wrap:wrap;gap:5px">${added.map(s=>`<span style="background:#0a1a0a;border:1px solid #1e421e;border-radius:5px;padding:3px 9px;font-size:12px;color:#7ec87e;display:inline-flex;align-items:center;gap:5px">${esc(s.name)}<button class="rm-btn" data-act="rm-sib" data-id="${s.id}" type="button" title="Undo" aria-label="Undo adding sibling">✕</button></span>`).join('')}</div>`;
  }
  list.innerHTML=html;
}

// ── Edit Photos ──
function renderEditPhotos(){
  const list=document.getElementById('ef-photos-list');
  list.innerHTML=editPhotos.map((ph,i)=>`<div class="photo-row"><img class="photo-preview" src="${esc(ph.url)}" alt="" loading="lazy"><input class="form-input" type="url" placeholder="https://…" aria-label="Photo URL" value="${esc(ph.url)}" data-field="photo-url" data-idx="${i}"><button class="rm-btn" data-act="rm-photo" data-idx="${i}" type="button" aria-label="Remove photo">✕</button></div>`).join('');
  // 'error' doesn't bubble, so hide broken previews with per-image listeners
  list.querySelectorAll('img.photo-preview').forEach(img=>{
    img.addEventListener('error',()=>{img.style.display='none'});
    img.addEventListener('load',()=>{img.style.display=''});
  });
}
function addEditPhoto(){editPhotos.push({url:''});renderEditPhotos();const inputs=document.querySelectorAll('#ef-photos-list .form-input');if(inputs.length)inputs[inputs.length-1].focus()}
function removeEditPhoto(i){editPhotos.splice(i,1);renderEditPhotos()}

// ── Edit Sources ──
function renderEditSources(){
  const list=document.getElementById('ef-sources-list');
  list.innerHTML=editSources.map((s,i)=>`<div class="source-row"><input class="form-input" type="text" placeholder="Citation or title…" aria-label="Source citation" value="${esc(s.title)}" data-field="source-title" data-idx="${i}"><button class="rm-btn" data-act="rm-source" data-idx="${i}" type="button" aria-label="Remove source">✕</button></div>`).join('');
}
function addEditSource(){editSources.push({sid:null,title:''});renderEditSources();const inputs=document.querySelectorAll('#ef-sources-list .form-input');if(inputs.length)inputs[inputs.length-1].focus()}
function removeEditSource(i){editSources.splice(i,1);renderEditSources()}

// ── Edit Tasks ──
function renderEditTasks(){
  const list=document.getElementById('ef-tasks-list');
  if(!editTasks.length){list.innerHTML='<div style="font-size:12px;color:#9595b2;margin-bottom:5px">No tasks yet.</div>';return}
  list.innerHTML=editTasks.map((t,i)=>`<div class="task-row"><input type="checkbox" ${t.done?'checked':''} data-chk="task-done" data-idx="${i}" aria-label="Task done"><input type="text" class="form-input ${t.done?'task-done-text':''}" aria-label="Task description" value="${esc(t.text)}" data-field="task-text" data-idx="${i}"><button class="rm-btn" data-act="rm-task" data-idx="${i}" type="button" aria-label="Remove task">✕</button></div>`).join('');
}
function addEditTask(){editTasks.push({text:'',done:false});renderEditTasks();const inputs=document.querySelectorAll('#ef-tasks-list input[type=text]');if(inputs.length)inputs[inputs.length-1].focus()}
function removeEditTask(i){editTasks.splice(i,1);renderEditTasks()}

// ── Edit Residences ──
function renderEditResi(){
  const list=document.getElementById('ef-resi-list');
  if(!editResi.length){list.innerHTML='<div style="font-size:12px;color:#9595b2;margin-bottom:5px">No residences recorded.</div>';return}
  list.innerHTML=editResi.map((r,i)=>`<div class="event-row"><input class="form-input place-ac" type="text" placeholder="Place" aria-label="Residence place" value="${esc(r.place)}" data-field="resi-place" data-idx="${i}"><input class="form-input" type="text" placeholder="From date" aria-label="Residence from date" value="${esc(r.from)}" data-field="resi-from" data-idx="${i}"><input class="form-input" type="text" placeholder="To date" aria-label="Residence to date" value="${esc(r.to)}" data-field="resi-to" data-idx="${i}"><button class="rm-btn" data-act="rm-resi" data-idx="${i}" type="button" aria-label="Remove residence">✕</button></div>`).join('');
  attachPlaceAC();
}
function addEditResi(){editResi.push({place:'',from:'',to:''});renderEditResi();const inputs=document.querySelectorAll('#ef-resi-list .form-input');if(inputs.length)inputs[inputs.length-3].focus()}
function removeEditResi(i){editResi.splice(i,1);renderEditResi()}

function renderEditParents(){
  const f=editParent.father?persons[editParent.father]:null;
  const m=editParent.mother?persons[editParent.mother]:null;
  document.getElementById('ef-father-display').textContent=f?f.name:'— not set —';
  document.getElementById('ef-mother-display').textContent=m?m.name:'— not set —';
}
function clearEditFather(){editParent.father=null;renderEditParents();document.getElementById('ef-father-search').value=''}
function clearEditMother(){editParent.mother=null;renderEditParents();document.getElementById('ef-mother-search').value=''}

// Live search for parent/spouse/child/sibling fields
// onCreate(name) is an optional 4th param that adds a "✦ Create new" option.
// Uses DOM element creation + addEventListener instead of serialised function
// strings in onclick attributes — safer and works with any minifier.
function setupSearch(inputId,suggId,onSelect,onCreate){
  const inp=document.getElementById(inputId),sug=document.getElementById(suggId);
  comboInit(inp,sug,'Matching people');
  const hide=()=>{sug.style.display='none';comboSetOpen(inp,false)};
  const pick=fn=>{fn();inp.value='';hide();inp.focus()};
  inp.addEventListener('input',()=>{
    const q=inp.value.trim();
    if(!q){hide();sug.innerHTML='';return}
    const ql=q.toLowerCase();
    const ms=Object.values(persons).filter(p=>p.id!==editingId&&p.name.toLowerCase().includes(ql)).slice(0,10);
    sug.innerHTML='';
    ms.forEach((p,i)=>{
      const div=document.createElement('div');div.className='rel-suggestion';div.id=`${suggId}-o${i}`;div.setAttribute('role','option');div.setAttribute('aria-selected','false');
      // Use textContent for the name to avoid any embedded HTML
      div.append(avatarEl(p));
      const nameSpan=document.createElement('span');nameSpan.textContent=displayName(p);
      const yearSpan=document.createElement('span');yearSpan.className='sugg-years';yearSpan.textContent=' '+lifespan(p);
      div.appendChild(nameSpan);div.appendChild(yearSpan);
      div.addEventListener('click',()=>pick(()=>onSelect(p.id)));
      sug.appendChild(div);
    });
    if(onCreate){
      const div=document.createElement('div');div.className='rel-create';div.id=`${suggId}-new`;div.setAttribute('role','option');div.setAttribute('aria-selected','false');
      div.textContent=`✨ Create new person: "${q}"`;
      div.addEventListener('click',()=>pick(()=>onCreate(q)));
      sug.appendChild(div);
    }
    const open=!!(ms.length||onCreate);sug.style.display=open?'block':'none';comboSetOpen(inp,open);
  });
  comboKeys(inp,sug,()=>sug.style.display!=='none',hide);
  document.addEventListener('click',e=>{if(!inp.contains(e.target)&&!sug.contains(e.target))hide()});
}
function avatarEl(p){const t=document.createElement('template');t.innerHTML=avatarHtml(p,'xs');return t.content.firstChild}
setupSearch('ef-father-search','ef-father-sugg',pid=>{editParent.father=pid;renderEditParents()});
setupSearch('ef-mother-search','ef-mother-sugg',pid=>{editParent.mother=pid;renderEditParents()});
setupSearch('ef-spouse-search','ef-spouse-sugg',pid=>{
  if(!editSpouses.find(s=>s.personId===pid)){editSpouses.push({personId:pid,famId:null,marrDate:'',marrPlace:'',divDate:'',divPlace:''});renderEditSpouses()}
  document.getElementById('ef-spouse-search').value='';document.getElementById('ef-spouse-sugg').style.display='none';
});
setupSearch('ef-child-search','ef-child-sugg',pid=>{
  if(!editChildren.find(c=>c.personId===pid)){
    // Pick the FAM to assign to: prefer the only/first spouse FAM; create one if none
    let targetFamId=editSpouses.find(s=>s.famId)?.famId||null;
    editChildren.push({personId:pid,famId:targetFamId,isNew:true});
    editRemovedChildren.delete(pid);
    renderEditChildren();
  }
  document.getElementById('ef-child-search').value='';document.getElementById('ef-child-sugg').style.display='none';
},name=>createAndLinkPerson(name,'child'));

setupSearch('ef-sibling-search','ef-sibling-sugg',pid=>{
  if(!editAddedSiblings.find(s=>s.personId===pid)&&!getSiblings(editingId).find(s=>s.id===pid)){
    editAddedSiblings.push({personId:pid,isNew:false});
    renderEditSiblings();
  }
  document.getElementById('ef-sibling-search').value='';document.getElementById('ef-sibling-sugg').style.display='none';
},name=>createAndLinkPerson(name,'sibling'));

// ── Photon Place Autocomplete ─────────────────────────────────────────────────
// Single shared dropdown, positioned with fixed layout so it works in any DOM
// context (flex rows, grid columns, scrolling modal, etc.).
const _phDrop=(()=>{const d=document.createElement('div');d.className='place-suggestions';d.id='place-sugg';d.setAttribute('role','listbox');d.setAttribute('aria-label','Suggested places');d.style.cssText='position:fixed;display:none;z-index:9999';document.body.appendChild(d);return d})();
let _phActiveEl=null,_phTimer=null,_phAC=null;

function _phHide(){_phDrop.style.display='none';_phDrop.innerHTML='';if(_phActiveEl)comboSetOpen(_phActiveEl,false);_phActiveEl=null}
function _phPos(){if(!_phActiveEl)return;const r=_phActiveEl.getBoundingClientRect();_phDrop.style.top=r.bottom+'px';_phDrop.style.left=r.left+'px';_phDrop.style.width=r.width+'px'}

function _phName(p){
  const city=p.city||p.town||p.village||p.hamlet;
  const parts=[];
  if(p.name)parts.push(p.name);
  if(city&&city!==p.name)parts.push(city);
  if(p.county&&p.county!==p.state)parts.push(p.county);
  if(p.state)parts.push(p.state);
  if(p.country)parts.push(p.country);
  return[...new Set(parts)].join(', ');
}

async function _phFetch(q){
  if(_phAC)_phAC.abort();
  _phAC=new AbortController();
  try{
    const r=await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en`,{signal:_phAC.signal});
    if(!r.ok)return;
    const d=await r.json();
    _phRender(d.features||[]);
  }catch(e){if(e.name!=='AbortError')console.warn('Photon place lookup:',e)}
}

function _phRender(features){
  _phDrop.innerHTML='';
  if(!features.length){_phHide();return}
  _phPos();
  features.forEach((f,i)=>{
    const name=_phName(f.properties);
    if(!name)return;
    const div=document.createElement('div');
    div.className='pi';div.textContent=name;div.id='place-o'+i;div.setAttribute('role','option');div.setAttribute('aria-selected','false');
    // mousedown preventDefault keeps focus on the input so blur doesn't fire first
    div.addEventListener('mousedown',e=>e.preventDefault());
    div.addEventListener('click',()=>{
      if(_phActiveEl){_phActiveEl.value=name;_phActiveEl.dispatchEvent(new Event('input',{bubbles:true}));_phActiveEl.focus()}
      _phHide();
    });
    _phDrop.appendChild(div);
  });
  _phDrop.style.display='block';if(_phActiveEl)comboSetOpen(_phActiveEl,true);
}

function makePlaceDropdown(inputEl){
  if(!inputEl||inputEl._phAC)return;inputEl._phAC=true;
  comboInit(inputEl,_phDrop);inputEl.setAttribute('autocomplete','off');
  inputEl.addEventListener('focus',()=>{_phActiveEl=inputEl});
  inputEl.addEventListener('input',()=>{
    _phActiveEl=inputEl;clearTimeout(_phTimer);
    const q=inputEl.value.trim();
    if(q.length<2){_phHide();return}
    _phTimer=setTimeout(()=>_phFetch(q),350);
  });
  // 200ms delay lets a click on a dropdown item register before blur fires
  inputEl.addEventListener('blur',()=>setTimeout(()=>{if(_phActiveEl===inputEl)_phHide()},200));
  comboKeys(inputEl,_phDrop,()=>_phActiveEl===inputEl&&_phDrop.style.display!=='none',_phHide);
}

// Reposition if user scrolls within the modal while dropdown is open.
// The scrolling element is .modal-box (overflow-y:auto), not the overlay.
document.querySelector('#edit-modal .modal-box').addEventListener('scroll',()=>{if(_phDrop.style.display!=='none')_phPos()},{passive:true});
// Hide when clicking anywhere outside the dropdown
document.addEventListener('click',e=>{if(!_phDrop.contains(e.target)&&e.target!==_phActiveEl)_phHide()});

// Scan the edit modal for any input with class 'place-ac' and attach autocomplete
function attachPlaceAC(){document.querySelectorAll('#edit-modal .place-ac').forEach(makePlaceDropdown)}

function savePersonEdit(){
  const given=document.getElementById('ef-given').value.trim();
  const sur=document.getElementById('ef-surname').value.trim();
  if(!given&&!sur){alert('Please enter a name.');return}
  const fullName=sur?`${given} ${sur}`.trim():given;
  const sex=document.getElementById('ef-sex').value;
  const living=document.getElementById('ef-living').checked;
  const deathConfirmed=document.getElementById('ef-death-confirmed').checked;
  const birthDate=normaliseDate(document.getElementById('ef-birth-date').value.trim());
  const birthPlace=document.getElementById('ef-birth-place').value.trim();
  const deathDate=normaliseDate(document.getElementById('ef-death-date').value.trim());
  const deathPlace=document.getElementById('ef-death-place').value.trim();
  const notesText=document.getElementById('ef-notes').value.trim();
  // Validate dates
  const warns=validatePersonData(birthDate,deathDate,editParent.father,editParent.mother);
  if(warns.length){
    const msg=warns.map(w=>`• ${w}`).join('\n');
    if(!confirm(`Data warnings:\n${msg}\n\nSave anyway?`))return;
  }
  // Duplicate check
  const dupes=findDuplicates(fullName,editingId);
  if(dupes.length){
    const dupeLines=dupes.map(d=>`• ${d.name} — ${dupeContext(d)}`).join('\n');
    if(!confirm(`"${fullName}" already exists:\n\n${dupeLines}\n\nAdd as a different person anyway?`))return;
  }
  // Snapshot for undo
  snapshotState();
  const events=[];
  document.querySelectorAll('#ef-events-list .event-row').forEach(row=>{
    const tag=row.querySelector('.ev-type').value;
    const val=row.querySelector('.ev-val').value.trim();
    const date=normaliseDate(row.querySelector('.ev-date').value.trim());
    const plac=row.querySelector('.ev-plac').value.trim();
    if(!val&&!date&&!plac&&!row._orig)return; // an added row left empty
    // Spread the original event first so note/type/conf/citations survive the edit
    if(tag)events.push(editedEvent(row._orig,{_tag:tag,val:val||undefined,date:date||undefined,plac:plac||undefined}));
  });
  const isNew=!editingId;
  if(isNew){
    editingId=newPersonId();
    persons[editingId]={id:editingId,name:fullName,nameGiven:given,nameSur:sur,nickname:undefined,sex,birth:{},death:{},events:[],notes:[],fams:[],famc:[],sources:[],images:[],tasks:[],residences:[]};
  }
  const p=persons[editingId];
  const nickname=document.getElementById('ef-nickname').value.trim();
  p.name=fullName;p.nameGiven=given;p.nameSur=sur;p.nickname=nickname||undefined;p.sex=sex;p.living=living||undefined;
  const birthConf=document.getElementById('ef-birth-conf').value||undefined;
  const deathConf=document.getElementById('ef-death-conf').value||undefined;
  const causeDeath=document.getElementById('ef-cause-death').value.trim();
  p.birth=editedEvent(p.birth,{date:birthDate||undefined,plac:birthPlace||undefined,conf:birthConf});
  p.death=editedEvent(p.death,{date:deathDate||undefined,plac:deathPlace||undefined,caus:causeDeath||undefined,conf:deathConf,confirmed:deathConfirmed&&!living||undefined});
  p.events=events;p.notes=notesText?[notesText]:[];
  p.tasks=editTasks.filter(t=>t.text.trim()).map(t=>({text:t.text.trim(),done:t.done}));
  p.residences=editResi.filter(r=>r.place||r.from||r.to);
  p.images=editPhotos.map(ph=>ph.url).filter(Boolean);
  // Save inline sources (free-text citations stored as SOUR records)
  p.sources=[];
  for(const es of editSources){
    if(!es.title.trim())continue;
    if(es.sid&&sources[es.sid]){sources[es.sid].title=es.title;p.sources.push(es.sid)}
    else{let n=Object.keys(sources).length+1;while(sources[`@S${n}@`])n++;const sid=`@S${n}@`;sources[sid]={id:sid,title:es.title};p.sources.push(sid)}
  }
  // Apply removed spouse FAMs
  for(const famId of editRemovedFams){
    const fam=families[famId];if(!fam)continue;
    [fam.husb,fam.wife].filter(Boolean).forEach(pid=>{const per=persons[pid];if(per)per.fams=per.fams.filter(f=>f!==famId)});
    if(!fam.children.length)delete families[famId];
    else{if(fam.husb===editingId)fam.husb=null;if(fam.wife===editingId)fam.wife=null}
  }
  // Apply spouse changes
  for(const sp of editSpouses){
    if(sp.famId){
      const fam=families[sp.famId];
      if(fam){
        fam.marr=editedEvent(fam.marr,{date:sp.marrDate||undefined,plac:sp.marrPlace||undefined});
        // Divorce event on the FAM record (keeps any citations/notes it already had)
        const oldDiv=(fam.events||[]).find(e=>e._tag==='DIV');
        fam.events=(fam.events||[]).filter(e=>e._tag!=='DIV');
        if(sp.divDate||sp.divPlace)fam.events.push(editedEvent(oldDiv,{_tag:'DIV',date:sp.divDate||undefined,plac:sp.divPlace||undefined}));
      }
    }else{
      const famId=newFamilyId();const spP=persons[sp.personId];
      const fam={id:famId,husb:null,wife:null,children:[],marr:{},events:[],notes:[]};
      if(p.sex==='M'){fam.husb=editingId;fam.wife=sp.personId}
      else if(p.sex==='F'){fam.wife=editingId;fam.husb=sp.personId}
      else if(spP?.sex==='M'){fam.wife=editingId;fam.husb=sp.personId}
      else{fam.husb=editingId;fam.wife=sp.personId}
      if(sp.marrDate)fam.marr.date=sp.marrDate;if(sp.marrPlace)fam.marr.plac=sp.marrPlace;
      if(sp.divDate||sp.divPlace)fam.events.push({_tag:'DIV',date:sp.divDate||undefined,plac:sp.divPlace||undefined});
      families[famId]=fam;
      if(!p.fams.includes(famId))p.fams.push(famId);
      if(spP&&!spP.fams.includes(famId))spP.fams.push(famId);
      sp.famId=famId;
    }
  }
  // Remove children that were removed
  for(const[childId,famId]of editRemovedChildren){
    const child=persons[childId];const fam=families[famId];
    if(fam)fam.children=fam.children.filter(c=>c!==childId);
    if(child)child.famc=child.famc.filter(f=>f!==famId);
  }
  // Add newly linked children
  for(const c of editChildren){
    if(c.isNew){
      const child=persons[c.personId];if(!child)continue;
      let famId=c.famId;
      if(!famId){
        // Create a solo parent FAM (no other parent)
        famId=newFamilyId();
        const fam={id:famId,husb:p.sex==='M'?editingId:null,wife:p.sex==='F'?editingId:null,children:[],marr:{},events:[],notes:[]};
        families[famId]=fam;if(!p.fams.includes(famId))p.fams.push(famId);
      }
      const fam=families[famId];
      if(fam&&!fam.children.includes(c.personId))fam.children.push(c.personId);
      if(!child.famc.includes(famId))child.famc.push(famId);
    }
  }
  // Apply parent changes
  applyParentChanges(editingId,editParent.father,editParent.mother);
  // Link added siblings: put them into the same FAMC family as this person (or create one if needed)
  if(editAddedSiblings.length){
    const existFamId=p.famc.length>0?p.famc[0]:null;
    let sharedFamId=existFamId;
    if(!sharedFamId){
      // Create a parentless family solely for sibling grouping
      sharedFamId=newFamilyId();
      const sf={id:sharedFamId,husb:null,wife:null,children:[editingId],marr:{},events:[],notes:[]};
      families[sharedFamId]=sf;p.famc.push(sharedFamId);
    }
    const sharedFam=families[sharedFamId];
    for(const entry of editAddedSiblings){
      const sib=persons[entry.personId];if(!sib)continue;
      if(!sharedFam.children.includes(entry.personId))sharedFam.children.push(entry.personId);
      if(!sib.famc.includes(sharedFamId))sib.famc.push(sharedFamId);
    }
  }
  editCreatedIds=[];editDirty=false;closeModal('edit-modal');
  updateSidebar();
  selectPerson(editingId);
  scheduleSave();
  if(isNew){
    const cnt=Object.keys(persons).length;const ms=[10,25,50,100,150,200,250,500,750,1000].includes(cnt);
    celebrate();showToast(ms?`🏆 ${cnt} people in your tree — what a family!`:`🎉 Welcome to the family, ${given||fullName}!`,3000);
  }else showToast('✅ Changes saved');
}

// Apply edited fields to an event while keeping everything the form doesn't
// show (notes, type, citations…). Details attached to a date or place — map
// coordinates, times — are dropped when that date or place changes.
function editedEvent(orig,changes){
  const e={...(orig||{}),...changes};
  for(const k of Object.keys(changes))if(changes[k]===undefined)delete e[k];
  if((orig?.date||undefined)!==e.date)delete e._x_DATE;
  if((orig?.plac||undefined)!==e.plac)delete e._x_PLAC;
  return e;
}

function applyParentChanges(personId,fatherId,motherId){
  const p=persons[personId];if(!p)return;
  const existFamId=p.famc.length>0?p.famc[0]:null;
  if(!fatherId&&!motherId){
    if(existFamId){const fam=families[existFamId];if(fam){fam.children=fam.children.filter(c=>c!==personId);if(!fam.children.length&&!fam.husb&&!fam.wife)delete families[existFamId]}p.famc=p.famc.filter(f=>f!==existFamId)}
    return;
  }
  if(existFamId){
    const fam=families[existFamId];
    if(fam){
      if(fam.husb&&fam.husb!==fatherId){const old=persons[fam.husb];if(old)old.fams=old.fams.filter(f=>f!==existFamId)}
      if(fam.wife&&fam.wife!==motherId){const old=persons[fam.wife];if(old)old.fams=old.fams.filter(f=>f!==existFamId)}
      fam.husb=fatherId||null;fam.wife=motherId||null;
      if(fatherId&&persons[fatherId]&&!persons[fatherId].fams.includes(existFamId))persons[fatherId].fams.push(existFamId);
      if(motherId&&persons[motherId]&&!persons[motherId].fams.includes(existFamId))persons[motherId].fams.push(existFamId);
    }
  }else{
    let sharedFamId=null;
    for(const[fid,fam]of Object.entries(families)){
      if(fam.husb===(fatherId||null)&&fam.wife===(motherId||null)){sharedFamId=fid;break}
    }
    if(sharedFamId){
      const fam=families[sharedFamId];
      if(!fam.children.includes(personId))fam.children.push(personId);
      if(!p.famc.includes(sharedFamId))p.famc.push(sharedFamId);
    }else{
      const famId=newFamilyId();
      const fam={id:famId,husb:fatherId||null,wife:motherId||null,children:[personId],marr:{},events:[],notes:[]};
      families[famId]=fam;p.famc.push(famId);
      if(fatherId&&persons[fatherId]&&!persons[fatherId].fams.includes(famId))persons[fatherId].fams.push(famId);
      if(motherId&&persons[motherId]&&!persons[motherId].fams.includes(famId))persons[motherId].fams.push(famId);
    }
  }
}

function deletePersonConfirm(){deletePersonById(editingId)}

function deletePersonById(id){
  const p=persons[id];if(!p)return;
  if(!confirm(`Delete "${p.name}"?\n\nThis removes them from all family links. You can undo it straight away with Ctrl+Z (⌘Z).`))return;
  editDirty=false;snapshotState();
  // Remove from spouse families
  for(const famId of p.fams){const fam=families[famId];if(!fam)continue;if(fam.husb===id)fam.husb=null;if(fam.wife===id)fam.wife=null;if(!fam.husb&&!fam.wife&&!fam.children.length)delete families[famId]}
  // Remove from parent families as child
  for(const famId of p.famc){const fam=families[famId];if(fam)fam.children=fam.children.filter(c=>c!==id)}
  delete persons[id];
  if(selectedId===id){selectedId=null;document.getElementById('btn-edit-person').style.display='none';document.getElementById('btn-relationship').style.display='none';const first=getSortedPersons()[0];if(first)selectPerson(first.id)}
  closeModal('edit-modal');closeModal('person-modal');updateSidebar();renderCurrentTab();scheduleSave();showToast('Person deleted');
}

// ── Export ──
// Helper: trigger a file download and revoke the object URL when done.
function _download(url,filename,delay=30000){
  const a=document.createElement('a');a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),delay);
}
function exportGedcomFile(){
  const blob=new Blob([generateGedcom({forExport:true})],{type:'text/plain;charset=utf-8'});
  _download(URL.createObjectURL(blob),`${currentTreeName.replace(/[^a-z0-9]/gi,'-')}.ged`);
}
const EXPORT_WRAP={chart:'chart-wrap',timeline:'timeline-wrap',ancestors:'anc-svg-wrap'};
function getExportSvg(){const w=EXPORT_WRAP[currentTab];if(!w)return null;const el=document.getElementById(w);return el?el.querySelector('svg'):null}
function buildExportClone(svg){
  const w=+svg.getAttribute('width')||1200,h=+svg.getAttribute('height')||800;
  const clone=svg.cloneNode(true);clone.style.transform='';clone.setAttribute('width',w);clone.setAttribute('height',h);
  const st=document.createElementNS('http://www.w3.org/2000/svg','style');st.textContent=`text{font-family:-apple-system,sans-serif}`;clone.insertBefore(st,clone.firstChild);
  return{clone,w,h};
}
function exportSvg(){
  const svg=getExportSvg();if(!svg){alert('No chart on this tab.');return}
  const{clone}=buildExportClone(svg);
  const blob=new Blob([clone.outerHTML],{type:'image/svg+xml'});
  _download(URL.createObjectURL(blob),`family-${currentTab}.svg`);
}
function exportPng(){
  const svg=getExportSvg();if(!svg){alert('No chart.');return}
  const sc=2;const{clone,w,h}=buildExportClone(svg);
  const canvas=document.createElement('canvas');canvas.width=w*sc;canvas.height=h*sc;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#f4f4f0';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.scale(sc,sc);
  // Use a Blob URL instead of the deprecated btoa(unescape(encodeURIComponent(…))) pattern
  const svgBlob=new Blob(['<?xml version="1.0" encoding="UTF-8"?>'+clone.outerHTML],{type:'image/svg+xml;charset=utf-8'});
  const svgUrl=URL.createObjectURL(svgBlob);
  const img=new Image();
  img.onload=()=>{
    ctx.drawImage(img,0,0);
    URL.revokeObjectURL(svgUrl);
    const pngUrl=canvas.toDataURL('image/png');
    const a=document.createElement('a');a.href=pngUrl;a.download=`family-${currentTab}.png`;
    document.body.appendChild(a);a.click();document.body.removeChild(a);
  };
  img.onerror=()=>{URL.revokeObjectURL(svgUrl);alert('PNG failed — try SVG')};
  img.src=svgUrl;
}

// ── Pan/Zoom ──
// Single global drag state — one pair of window handlers shared by all pan-zoom
// instances. Previous approach added new window.addEventListener on every chart
// re-render (tab switch), accumulating handlers indefinitely.
let _pzActive=null;
window.addEventListener('mousemove',e=>{
  if(!_pzActive)return;
  _pzActive.tr.x+=e.clientX-_pzActive.lx;
  _pzActive.tr.y+=e.clientY-_pzActive.ly;
  _pzActive.lx=e.clientX;_pzActive.ly=e.clientY;
  _pzActive.fn();
},{passive:true});
window.addEventListener('mouseup',()=>{
  if(!_pzActive)return;
  _pzActive.wrap.classList.remove('panning');
  _pzActive=null;
},{passive:true});

function makePanZoom(wrapEl,svgEl,init){
  // Abort any lingering per-wrap listeners left from a previous render of this
  // same wrapper element (e.g. when switching back to an already-visited tab).
  if(wrapEl.__pzAC)wrapEl.__pzAC.abort();
  const ac=new AbortController();wrapEl.__pzAC=ac;const sig=ac.signal;

  let tr=init||{x:0,y:0,scale:1};
  function apply(){svgEl.style.transform=`translate(${tr.x}px,${tr.y}px) scale(${tr.scale})`;svgEl.style.transformOrigin='0 0'}
  apply();

  wrapEl.addEventListener('mousedown',e=>{
    if(e.button!==0)return;
    _pzActive={wrap:wrapEl,tr,lx:e.clientX,ly:e.clientY,fn:apply};
    wrapEl.classList.add('panning');
  },{signal:sig});

  wrapEl.addEventListener('wheel',e=>{
    e.preventDefault();
    const f=e.deltaY<0?1.1:.9;const r=wrapEl.getBoundingClientRect();
    const mx=e.clientX-r.left,my=e.clientY-r.top;
    tr.x=mx-f*(mx-tr.x);tr.y=my-f*(my-tr.y);tr.scale*=f;apply();
  },{passive:false,signal:sig});

  let lpd=null,tDrag=false,tlx=0,tly=0;
  wrapEl.addEventListener('touchstart',e=>{
    if(e.touches.length===1){tDrag=true;tlx=e.touches[0].clientX;tly=e.touches[0].clientY}
    if(e.touches.length===2){tDrag=false;lpd=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY)}
  },{passive:true,signal:sig});
  wrapEl.addEventListener('touchmove',e=>{
    if(e.touches.length===1&&tDrag){tr.x+=e.touches[0].clientX-tlx;tr.y+=e.touches[0].clientY-tly;tlx=e.touches[0].clientX;tly=e.touches[0].clientY;apply()}
    if(e.touches.length===2&&lpd){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);tr.scale*=d/lpd;lpd=d;apply()}
  },{passive:true,signal:sig});
  wrapEl.addEventListener('touchend',()=>{tDrag=false;lpd=null},{signal:sig});

  return{
    fitAll(sw,sh){const rw=wrapEl.clientWidth,rh=wrapEl.clientHeight;const s=Math.min(rw/sw,rh/sh,1)*.9;tr={x:(rw-sw*s)/2,y:(rh-sh*s)/2,scale:s};apply()},
    zoomIn(){tr.scale*=1.2;apply()},
    zoomOut(){tr.scale/=1.2;apply()}
  };
}
function svgControls(wrapEl,pz,sw,sh){
  const old=wrapEl.querySelector('.svg-controls');if(old)old.remove();
  const div=document.createElement('div');div.className='svg-controls';
  div.innerHTML='<button aria-label="Zoom in">+</button><button aria-label="Zoom out">−</button><button aria-label="Fit chart to view">⊞</button>';
  div.querySelectorAll('button').forEach((b,i)=>{b.onclick=[()=>pz.zoomIn(),()=>pz.zoomOut(),()=>pz.fitAll(sw,sh)][i]});
  wrapEl.appendChild(div);
}

// ── List Tree ──
function renderListTree(){
  const el=document.getElementById('tab-listtree');
  if(!Object.keys(persons).length){el.innerHTML=`<div class="empty-state"><div class="empty-state-icon">🌱</div><h2 class="empty-title">Your tree is just a seed</h2><p>Add the first person — usually yourself — and grow it from there.</p><button class="modal-btn primary empty-cta" data-act="new-person">＋ Add the first person</button></div>`;return}
  if(!selectedId){el.innerHTML=`<div class="empty-state"><div class="empty-state-icon">👋</div><h2 class="empty-title">Who shall we visit?</h2><p>Pick someone from the list to explore their family — or press <kbd>X</kbd> for a surprise.</p></div>`;return}
  const p=persons[selectedId];if(!p)return;
  const sc=completenessScore(p);
  let h=`<div class="lt-section"><h2 class="lt-section-title">Selected person</h2><div class="lt-card lt-hero">${avatarHtml(p,'lg')}<div class="lt-hero-body"><div class="lt-hero-name">${esc(displayName(p))}</div><div class="lt-card-sub">${esc(lifespan(p)||'Dates not yet recorded')}${p.birth.plac?` · <span aria-hidden="true">📍</span> ${esc(p.birth.plac)}`:''}</div><div class="lt-progress" title="Record completeness"><div class="lt-progress-bar" role="progressbar" aria-label="Record completeness" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${sc}"><span style="width:${sc}%"></span></div><span class="lt-progress-txt">${sc}% complete${sc>=100?' 🌟':''}</span></div><div class="lt-card-actions"><button class="modal-btn primary" data-act="edit" data-id="${p.id}"><span aria-hidden="true">✏️</span> Edit</button><button class="modal-btn" data-act="info" data-id="${p.id}"><span aria-hidden="true">ℹ️</span> Details</button><button class="modal-btn" data-act="bio" data-id="${p.id}"><span aria-hidden="true">📝</span> Life story</button><button class="modal-btn" data-act="sheet" data-id="${p.id}"><span aria-hidden="true">🖨️</span> Family sheet</button></div></div></div></div>`;
  const spouses=getSpouses(selectedId);
  if(spouses.length){h+=`<div class="lt-section"><h2 class="lt-section-title">Spouses</h2>`;for(const{person:sp,fam}of spouses){h+=`<div class="lt-card"><div class="lt-person-row">${avatarHtml(sp,'xs')}<div class="lt-person-name" role="link" tabindex="0" data-act="select" data-id="${sp.id}">${esc(displayName(sp))}</div><div class="lt-person-years">${esc(lifespan(sp))}</div><button class="info-btn" data-act="info" data-id="${sp.id}" aria-label="Details for ${esc(sp.name)}">i</button></div>${fam.marr.date||fam.marr.plac?`<div class="lt-card-sub">m. ${esc(fam.marr.date||'')} ${esc(fam.marr.plac||'')}</div>`:''}</div>`}h+=`</div>`}
  const parents=getParents(selectedId);
  if(parents.length){h+=`<div class="lt-section"><h2 class="lt-section-title">Parents</h2>`;for(const par of parents)h+=personRow(par);h+=`</div>`}
  const sibs=getSiblings(selectedId);
  if(sibs.length){h+=`<div class="lt-section"><h2 class="lt-section-title">Siblings (${sibs.length})</h2>`;for(const s of sibs)h+=personRow(s);h+=`</div>`}
  h+=`<div class="lt-section"><h2 class="lt-section-title">Descendants</h2>`;h+=buildDescTree(selectedId,0);h+=`</div>`;
  el.innerHTML=h;
  el.querySelectorAll('button.dt-toggle').forEach(btn=>{
    btn.addEventListener('click',e=>{e.stopPropagation();const cont=btn.closest('.dt-node').querySelector('.dt-children');if(!cont)return;const c=cont.style.display==='none';cont.style.display=c?'':'none';btn.textContent=c?'▾':'▸';btn.setAttribute('aria-expanded',c);btn.setAttribute('aria-label',btn.getAttribute('aria-label').replace(/^(Hide|Show)/,c?'Hide':'Show'))});
  });
}
function personRow(p){return`<div class="lt-person-row">${avatarHtml(p,'xs')}<div class="lt-person-name" role="link" tabindex="0" data-act="select" data-id="${p.id}">${esc(displayName(p))}</div><div class="lt-person-years">${esc(lifespan(p))}</div><button class="info-btn" data-act="info" data-id="${p.id}" aria-label="Details for ${esc(p.name)}">i</button></div>`}
function buildDescTree(id,depth,visited=new Set()){
  if(visited.has(id))return'';visited.add(id);const p=persons[id];if(!p)return'';
  const ch=getChildren(id),sp=getSpouses(id),hasKids=ch.length>0;
  let h=`<div class="dt-node"><div class="dt-row">${hasKids?`<button type="button" class="dt-toggle" aria-expanded="true" aria-label="Hide children of ${esc(p.name)}">▾</button>`:'<span class="dt-toggle" aria-hidden="true"></span>'}${avatarHtml(p,'xs')}<span class="dt-name" role="link" tabindex="0" data-act="select" data-id="${id}">${esc(displayName(p))}</span><span class="dt-years">${esc(lifespan(p))}</span><button class="info-btn" data-act="info" data-id="${id}" aria-label="Details for ${esc(p.name)}">i</button></div>`;
  for(const{person:s}of sp)h+=`<div class="dt-spouse-line"><span aria-hidden="true">💍 </span><span role="link" tabindex="0" data-act="select" data-id="${s.id}"><span class="visually-hidden">spouse </span>${esc(displayName(s))}</span> ${esc(lifespan(s))}</div>`;
  if(hasKids){h+=`<div class="dt-children">`;for(const c of ch)h+=buildDescTree(c.id,depth+1,visited);h+=`</div>`}
  h+=`</div>`;return h;
}

// ── Ancestors ──
function renderAncestors(){
  const wrap=document.getElementById('ancestors-wrap');
  if(!selectedId){wrap.innerHTML=`<div class="empty-state"><div class="empty-state-icon">🌳</div><p>Select a person from the list to see their ancestors.</p></div>`;return}
  wrap.innerHTML=`<div style="position:absolute;top:8px;left:8px;z-index:10;display:flex;gap:8px;align-items:center"><label for="anc-gen-sel" style="font-size:12px;color:#666">Gens:</label><select id="anc-gen-sel" style="background:#fff;border:1px solid #c8c8d8;color:#333;border-radius:5px;padding:3px 6px;font-size:12px"><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option></select></div><div class="svg-wrap" id="anc-svg-wrap" style="position:absolute;inset:0;top:36px"></div>`;
  document.getElementById('anc-gen-sel').value=ancestorMaxGen;
  document.getElementById('anc-gen-sel').addEventListener('change',e=>{ancestorMaxGen=+e.target.value;drawAncestorSvg()});
  drawAncestorSvg();
}
function drawAncestorSvg(){
  const svgWrap=document.getElementById('anc-svg-wrap');if(!svgWrap||!selectedId)return;
  const BW=155,BH=48,HGAP=36,VGAP=12,mg=ancestorMaxGen;
  const genMap=[[{id:selectedId}]];
  for(let g=1;g<=mg;g++){genMap[g]=[];for(const node of genMap[g-1]){const pars=node.id?getParents(node.id):[];genMap[g].push({id:pars[0]?pars[0].id:null});genMap[g].push({id:pars[1]?pars[1].id:null})}}
  const colX=g=>g*(BW+HGAP)+50;
  const svgW=colX(mg+1)+20;
  const maxNodes=Math.pow(2,mg);const svgH=Math.max(380,maxNodes*(BH+VGAP)+80);
  function getY(g,i){const count=genMap[g].length;const totalH=count*(BH+VGAP)-VGAP;return(svgH-totalH)/2+i*(BH+VGAP)}
  const GL=['Self','Parents','Grandparents','Great-Grandparents','2×Great-Grandparents'];
  let rects='',lines='',labels='';
  for(let g=0;g<=mg;g++){
    labels+=`<text x="${colX(g)+BW/2}" y="16" text-anchor="middle" font-size="10" fill="#55558f">${GL[g]||`Gen ${g}`}</text>`;
    for(let i=0;i<genMap[g].length;i++){
      const node=genMap[g][i],x=colX(g),y=getY(g,i)+24;
      node._x=x;node._y=y;const p=node.id?persons[node.id]:null;
      const fill=p?(p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8'):'#eaeaf4';
      const stroke=p?(p.sex==='M'?'#5a90e0':p.sex==='F'?'#d060b0':'#9090d0'):'#b0b0d0';
      if(p){rects+=`<g data-act="select" data-id="${node.id}" tabindex="0" role="button" style="cursor:pointer"><title>${esc(p.name)}${lifespan(p)?', '+esc(lifespan(p)):''}</title><rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${x+7}" y="${y+17}" font-size="12" fill="#fff" font-weight="600">${esc(truncate(p.name,19))}</text><text x="${x+7}" y="${y+31}" font-size="10" fill="#f4f4ff">${esc(lifespan(p))}</text><circle cx="${x+BW-10}" cy="${y+9}" r="7" fill="#000" fill-opacity=".25"/><text x="${x+BW-10}" y="${y+13}" text-anchor="middle" font-size="8" fill="#fff" font-style="italic" font-weight="bold" data-act="info" data-id="${node.id}">i</text></g>`}
      else rects+=`<rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="6" fill="#eaeaf4" stroke="#b0b0d0" stroke-width="1" stroke-dasharray="4"/>`;
      if(g<mg){const pi0=i*2,pi1=i*2+1;const p0=genMap[g+1][pi0],p1=genMap[g+1][pi1];if(p0&&p1){const x1=x+BW,y1=y+BH/2,x2=colX(g+1),ym0=getY(g+1,pi0)+24+BH/2,ym1=getY(g+1,pi1)+24+BH/2,mx=x1+HGAP/2;lines+=`<path d="M${x1},${y1} L${mx},${y1} L${mx},${ym0} L${x2},${ym0}" fill="none" stroke="#9090c8" stroke-width="1.5"/>`;lines+=`<path d="M${mx},${ym1} L${x2},${ym1}" fill="none" stroke="#9090c8" stroke-width="1.5"/>`;lines+=`<line x1="${mx}" y1="${ym0}" x2="${mx}" y2="${ym1}" stroke="#9090c8" stroke-width="1.5"/>`}}
    }
  }
  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');svgEl.setAttribute('width',svgW);svgEl.setAttribute('height',svgH);svgEl.setAttribute('viewBox',`0 0 ${svgW} ${svgH}`);
  svgEl.setAttribute('role','group');svgEl.setAttribute('aria-label',`Ancestor chart of ${persons[selectedId]?.name||''}, ${mg} generations`);
  svgEl.innerHTML=`<style>.anc-g:hover rect{filter:brightness(1.2)}</style>${lines}${rects}${labels}`;
  svgWrap.innerHTML='';svgWrap.appendChild(svgEl);const pz=makePanZoom(svgWrap,svgEl);pz.fitAll(svgW,svgH);svgControls(svgWrap,pz,svgW,svgH);svgWrap.__pz=pz;
}

// ── Chart (descendant SVG) ──
function renderChart(){
  const wrap=document.getElementById('chart-wrap');
  if(!selectedId){wrap.innerHTML=`<div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="empty-state-icon">🌿</div><p>Select a person from the list to see their descendants.</p></div>`;return}
  const{svgEl,svgW,svgH}=buildDescSvg(selectedId);wrap.innerHTML='';wrap.appendChild(svgEl);const pz=makePanZoom(wrap,svgEl);pz.fitAll(svgW,svgH);svgControls(wrap,pz,svgW,svgH);wrap.__pz=pz;
}
function buildDescSvg(rootId,sharedVisited=null){
  const BW=145,BH=46,HGAP=26,VGAP=18,CW=18;const visited=sharedVisited||new Set();const genNodes=[];
  function collectGen(ids,gen){
    if(!ids.length||gen>8)return;const nodes=[];
    for(const id of ids){if(visited.has(id))continue;visited.add(id);const p=persons[id];if(!p)continue;const sp=getSpouses(id);const s=sp.length>0?sp[0].person:null;if(s)visited.add(s.id);nodes.push({id,spouseId:s?s.id:null})}
    if(!nodes.length)return;genNodes[gen]=(genNodes[gen]||[]).concat(nodes);
    const next=[];for(const node of nodes)for(const ch of getChildren(node.id))if(!visited.has(ch.id))next.push(ch.id);
    if(next.length)collectGen(next,gen+1);
  }
  collectGen([rootId],0);const mg=genNodes.length;const GRH=BH+VGAP+18;let svgW=0,svgH=mg*GRH+60;
  for(let g=0;g<mg;g++){const nodes=genNodes[g]||[];let x=50;for(const node of nodes){const nw=node.spouseId?BW+CW+BW:BW;node.x=x;node.y=g*GRH+36;node.w=nw;x+=nw+HGAP}svgW=Math.max(svgW,x)}
  svgW+=36;const GL=['','Children','Grandchildren','Great-Grandchildren','2×GC','3×GC','4×GC','5×GC'];
  let rects='',lines='',labels='';
  for(let g=0;g<mg;g++){const lbl=g===0?'':(GL[g]||`Gen ${g}`);if(lbl)labels+=`<text x="4" y="${g*GRH+36+BH/2+4}" font-size="10" fill="#55558f">${esc(lbl)}</text>`}
  const nodeById={};for(const nodes of genNodes){if(!nodes)continue;for(const n of nodes)nodeById[n.id]=n}
  for(let g=0;g<mg;g++){const nodes=genNodes[g]||[];for(const node of nodes){
    const p=persons[node.id];if(!p)continue;
    rects+=drawBox(p,node.x,node.y,BW,BH,true);
    if(node.spouseId){const sp=persons[node.spouseId];if(sp){const spX=node.x+BW+CW;rects+=drawBox(sp,spX,node.y,BW,BH,true);const mx=node.x+BW+CW/2;rects+=`<line x1="${node.x+BW}" y1="${node.y+BH/2}" x2="${spX}" y2="${node.y+BH/2}" stroke="#8050b8" stroke-width="2"/><circle cx="${mx}" cy="${node.y+BH/2}" r="4" fill="#8050b8"/>`}}
    for(const ch of getChildren(node.id)){const cn=nodeById[ch.id];if(!cn)continue;const px=node.x+(node.w||BW)/2,py=node.y+BH,cx2=cn.x+BW/2,cy2=cn.y,midy=py+(cy2-py)/2;lines+=`<path d="M${px},${py} L${px},${midy} L${cx2},${midy} L${cx2},${cy2}" fill="none" stroke="#9090c8" stroke-width="1.5"/>`}
  }}
  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');svgEl.setAttribute('width',svgW);svgEl.setAttribute('height',svgH);svgEl.setAttribute('viewBox',`0 0 ${svgW} ${svgH}`);
  svgEl.setAttribute('role','group');svgEl.setAttribute('aria-label',`Descendant chart of ${persons[rootId]?.name||''}`);
  svgEl.innerHTML=`<style>.pbox:hover rect{filter:brightness(1.3)}</style>${lines}${rects}${labels}`;
  return{svgEl,svgW,svgH};
}
function drawBox(p,x,y,w,h,click){
  const fill=p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8';const stroke=p.sex==='M'?'#5a90e0':p.sex==='F'?'#d060b0':'#9090d0';
  const c=click?`data-act="select" data-id="${p.id}" tabindex="0" role="button" style="cursor:pointer"`:'';
  return`<g class="pbox" ${c}><title>${esc(p.name)}${lifespan(p)?', '+esc(lifespan(p)):''}</title><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/><text x="${x+6}" y="${y+16}" font-size="11" fill="#fff" font-weight="600">${esc(truncate(p.name,17))}</text><text x="${x+6}" y="${y+30}" font-size="10" fill="#f4f4ff">${esc(lifespan(p))}</text><circle cx="${x+w-9}" cy="${y+9}" r="7" fill="#000" fill-opacity=".25"/><text x="${x+w-9}" y="${y+13}" text-anchor="middle" font-size="8" fill="#fff" font-style="italic" font-weight="bold" data-act="info" data-id="${p.id}" style="cursor:pointer">i</text></g>`;
}

// ── Timeline ──
function renderTimeline(){
  const wrap=document.getElementById('timeline-wrap');const allP=Object.values(persons);
  let minY=Infinity,maxY=-Infinity;const pData=[];
  for(const p of allP){const b=extractYear(p.birth.date),d=extractYear(p.death.date);if(b||d){pData.push({p,by:b,dy:d});if(b){minY=Math.min(minY,b);maxY=Math.max(maxY,b)}if(d){minY=Math.min(minY,d);maxY=Math.max(maxY,d)}}}
  if(!pData.length){wrap.innerHTML='<div style="color:#555;padding:30px;text-align:center;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)">No dates in this tree.</div>';return}
  minY=Math.floor(minY/10)*10-10;maxY=Math.ceil(maxY/10)*10+10;
  const RH=13,PL=170,PR=36,HH=44,PPY=4;
  const svgW=PL+(maxY-minY)*PPY+PR;const svgH=HH+pData.length*RH+16;
  function toX(y){return PL+(y-minY)*PPY}
  let rects='',axis='',texts='';
  for(let y=minY;y<=maxY;y+=10){const x=toX(y);axis+=`<line x1="${x}" y1="${HH-8}" x2="${x}" y2="${svgH}" stroke="#c0c0d8" stroke-width="${y%50===0?1.5:.6}"/>`;axis+=`<text x="${x}" y="${HH-12}" text-anchor="middle" font-size="10" fill="${y%50===0?'#4a4a96':'#62629a'}">${y}</text>`}
  pData.sort((a,b)=>(a.by||a.dy||9999)-(b.by||b.dy||9999));
  for(let i=0;i<pData.length;i++){
    const{p,by,dy}=pData[i],y=HH+i*RH+1,color=p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8';
    texts+=`<text x="${PL-3}" y="${y+9}" text-anchor="end" font-size="10" fill="#444466" data-act="select" data-id="${p.id}" tabindex="0" role="button" style="cursor:pointer">${esc(truncate(p.name,21))}</text>`;
    if(by&&dy){const x1=toX(by),x2=toX(dy);rects+=`<rect x="${x1}" y="${y}" width="${Math.max(x2-x1,2)}" height="${RH-2}" rx="2" fill="${color}" opacity=".7" data-act="select" data-id="${p.id}" style="cursor:pointer"><title>${esc(p.name)} (${by}–${dy})</title></rect>`}
    else{const x1=toX(by||dy);rects+=`<circle cx="${x1}" cy="${y+5}" r="4" fill="${color}" opacity=".7" data-act="select" data-id="${p.id}" style="cursor:pointer"><title>${esc(p.name)}</title></circle>`}
  }
  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');svgEl.setAttribute('width',svgW);svgEl.setAttribute('height',svgH);svgEl.setAttribute('viewBox',`0 0 ${svgW} ${svgH}`);
  svgEl.setAttribute('role','group');svgEl.setAttribute('aria-label',`Timeline of births and deaths, ${pData.length} people, ${minY} to ${maxY}`);
  svgEl.innerHTML=axis+rects+texts;
  wrap.innerHTML='';wrap.appendChild(svgEl);const pz=makePanZoom(wrap,svgEl);pz.fitAll(svgW,svgH);svgControls(wrap,pz,svgW,svgH);wrap.__pz=pz;timelineBuilt=true;
}

// ── Places ──
function collectPlaces(){const m=new Map();function add(plac,pid){if(!plac)return;const k=plac.trim();if(!k)return;if(!m.has(k))m.set(k,new Set());m.get(k).add(pid)}
  for(const p of Object.values(persons)){add(p.birth.plac,p.id);add(p.death.plac,p.id);for(const e of p.events)add(e.plac,p.id)}
  for(const f of Object.values(families)){if(f.marr.plac)[f.husb,f.wife].filter(Boolean).forEach(id=>add(f.marr.plac,id))}
  return[...m.entries()].sort((a,b)=>b[1].size-a[1].size);
}
function renderPlaces(){const el=document.getElementById('tab-places');const places=collectPlaces();if(!places.length){el.innerHTML='<div style="color:#555;padding:30px;text-align:center">No place data found.</div>';return}el.innerHTML=places.map(([name,ids])=>`<div class="place-item" role="button" tabindex="0" data-act="place" data-name="${esc(name)}"><div class="place-name">${esc(name)}</div><div class="place-count">${ids.size}</div></div>`).join('')}
function showPlaceModal(place){
  const places=collectPlaces();const entry=places.find(([n])=>n===place);if(!entry)return;
  const ids=[...entry[1]];
  document.getElementById('place-modal-title').textContent=place;
  document.getElementById('place-modal-content').innerHTML=ids.map(id=>{const p=persons[id];if(!p)return'';return`<div class="lt-person-row">${avatarHtml(p,'xs')}<div class="lt-person-name" role="link" tabindex="0" data-act="select" data-id="${p.id}" data-close="place-modal">${esc(displayName(p))}</div><div class="lt-person-years">${esc(lifespan(p))}</div></div>`}).join('');
  document.getElementById('place-modal').classList.remove('hidden');
}

// ── Surnames ──
let activeLetter='';
function extractSurname(name){const parts=name.split(' ');return parts.length>1?parts[parts.length-1]:''}
function renderSurnames(){
  const el=document.getElementById('tab-surnames');const groups=new Map();
  for(const p of Object.values(persons)){const s=p.nameSur||(p.name==='Unknown'?'?':extractSurname(p.name))||'?';if(!groups.has(s))groups.set(s,[]);groups.get(s).push(p)}
  const sorted=[...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
  const letters=[...new Set(sorted.map(([s])=>s[0].toUpperCase()))].sort();
  let h=`<div class="alpha-filter"><button class="alpha-btn ${!activeLetter?'active':''}" data-act="alpha">All</button>${letters.map(l=>`<button class="alpha-btn ${activeLetter===l?'active':''}" data-act="alpha" data-letter="${esc(l)}">${esc(l)}</button>`).join('')}</div>`;
  for(const[sur,people]of sorted){
    if(activeLetter&&!sur.toUpperCase().startsWith(activeLetter))continue;
    const gid='sg_'+sur.replace(/[^a-z0-9]/gi,'_');
    h+=`<div class="surname-group"><div class="surname-group-header" role="button" tabindex="0" data-act="surname-group" data-gid="${gid}"><span class="surname-group-name">${esc(sur)}</span><span class="surname-group-count">${people.length} people</span><span style="color:#8f8fae;font-size:12px">▾</span></div><div class="surname-group-members" id="${gid}">${people.sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<div class="surname-member" role="link" tabindex="0" data-act="select" data-id="${p.id}">${avatarHtml(p,'xs')}<span>${esc(displayName(p))}</span><span style="color:#8f8fae;font-size:11px">${esc(lifespan(p))}</span></div>`).join('')}</div></div>`;
  }
  el.innerHTML=h;
}
function setAlpha(l){activeLetter=l;renderSurnames()}
function toggleSurnameGroup(id){const el=document.getElementById(id);if(el)el.style.display=el.style.display==='none'?'':'none'}

// ── Conflict Detection ──
function findConflicts(){
  const issues=[];const yr=new Date().getFullYear();
  for(const p of Object.values(persons)){
    const by=extractYear(p.birth.date),dy=extractYear(p.death.date);
    if(by&&dy&&dy<by)issues.push({personId:p.id,name:p.name,issue:'Death year before birth year'});
    if(by&&dy&&dy-by>120)issues.push({personId:p.id,name:p.name,issue:`Lifespan of ${dy-by} years (>120)`});
    if(by&&by>yr)issues.push({personId:p.id,name:p.name,issue:'Birth year is in the future'});
    if(p.name==='Unknown'&&!by&&!dy&&!p.fams.length&&!p.famc.length)issues.push({personId:p.id,name:p.name,issue:'Named "Unknown" with no data'});
    const noInfo=!by&&!dy&&!p.fams.length&&!p.famc.length&&!p.birth.plac&&!p.death.plac;
    if(noInfo&&p.name!=='Unknown')issues.push({personId:p.id,name:p.name,issue:'Person has no data at all'});
    // Marriage before birth
    for(const fid of p.fams){const f=families[fid];if(!f)continue;const my=extractYear(f.marr.date);if(by&&my&&my<by)issues.push({personId:p.id,name:p.name,issue:'Marriage before birth year'})}
    // Child born less than 12 years after parent
    if(by){for(const fid of p.famc){const f=families[fid];if(!f)continue;for(const pid of[f.husb,f.wife]){const par=pid?persons[pid]:null;if(!par)continue;const pby=extractYear(par.birth.date);if(pby&&by-pby<12)issues.push({personId:p.id,name:p.name,issue:`Born only ${by-pby} years after parent "${par.name}"`})}}}
  }
  return issues;
}

// ── Duplicate Detection & Merge ──
function nameSimilarity(a,b){
  a=a.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  b=b.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim();
  if(!a.length||!b.length)return 0;
  if(a===b)return 1;
  const setA=new Set(a.split(''));const setB=new Set(b.split(''));
  let common=0;for(const c of setA)if(setB.has(c))common++;
  return 2*common/(a.length+b.length);
}
function findPotentialDuplicates(){
  const arr=Object.values(persons);const pairs=[];
  for(let i=0;i<arr.length;i++){
    for(let j=i+1;j<arr.length;j++){
      const a=arr[i],b=arr[j];
      const ns=nameSimilarity(a.name,b.name);
      const byA=extractYear(a.birth.date),byB=extractYear(b.birth.date);
      const yp=(byA&&byB)?Math.max(0,1-Math.abs(byA-byB)/10):0;
      const score=ns*0.7+yp*0.3;
      if(score>0.75)pairs.push({a,b,score});
      if(pairs.length>=30)return pairs;
    }
  }
  return pairs.sort((x,y)=>y.score-x.score);
}
function openDupModal(){
  const pairs=findPotentialDuplicates();
  const list=document.getElementById('dup-list');
  if(!pairs.length){list.innerHTML='<div style="color:#888;font-size:13px;padding:10px">No potential duplicates found.</div>';}
  else{list.innerHTML=pairs.map(({a,b,score})=>`<div class="dup-pair"><div class="dup-name"><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${a.id}">${esc(a.name)}</a> <span style="color:#8f8fae;font-size:11px">${esc(lifespan(a))}</span></div><div style="color:#8f8fae;font-size:11px">vs</div><div class="dup-name"><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${b.id}">${esc(b.name)}</a> <span style="color:#8f8fae;font-size:11px">${esc(lifespan(b))}</span></div><span class="dup-score">${Math.round(score*100)}%</span><div class="dup-actions"><button class="modal-btn" data-act="merge-keep" data-keep="${a.id}" data-remove="${b.id}" style="font-size:11px;padding:2px 8px" title="Keep ${esc(a.name)}, remove ${esc(b.name)}">Keep A</button><button class="modal-btn" data-act="merge-keep" data-keep="${b.id}" data-remove="${a.id}" style="font-size:11px;padding:2px 8px" title="Keep ${esc(b.name)}, remove ${esc(a.name)}">Keep B</button></div></div>`).join('')}
  document.getElementById('dup-modal').classList.remove('hidden');
}
function mergePeople(keepId,removeId){
  const keep=persons[keepId],rem=persons[removeId];if(!keep||!rem)return;
  snapshotState();
  if(!keep.birth.date&&rem.birth.date)keep.birth.date=rem.birth.date;
  if(!keep.birth.plac&&rem.birth.plac)keep.birth.plac=rem.birth.plac;
  if(!keep.death.date&&rem.death.date)keep.death.date=rem.death.date;
  if(!keep.death.plac&&rem.death.plac)keep.death.plac=rem.death.plac;
  if(!keep.death.caus&&rem.death.caus)keep.death.caus=rem.death.caus;
  if(!keep.death.confirmed&&rem.death.confirmed)keep.death.confirmed=rem.death.confirmed;
  for(const n of(rem.notes||[]))if(!keep.notes.includes(n))keep.notes.push(n);
  for(const e of(rem.events||[]))keep.events.push(e);
  for(const img of(rem.images||[]))if(!keep.images.includes(img))keep.images.push(img);
  for(const s of(rem.sources||[]))if(!keep.sources.includes(s))keep.sources.push(s);
  for(const t of(rem.tasks||[]))keep.tasks=(keep.tasks||[]).concat(t);
  // Re-point family links
  for(const famId of(rem.fams||[])){
    const fam=families[famId];if(!fam)continue;
    if(fam.husb===removeId){fam.husb=keepId;if(!keep.fams.includes(famId))keep.fams.push(famId)}
    if(fam.wife===removeId){fam.wife=keepId;if(!keep.fams.includes(famId))keep.fams.push(famId)}
    fam.children=fam.children.map(c=>c===removeId?keepId:c);
  }
  for(const famId of(rem.famc||[])){
    const fam=families[famId];if(!fam)continue;
    fam.children=fam.children.map(c=>c===removeId?keepId:c);
    if(!keep.famc.includes(famId))keep.famc.push(famId);
  }
  // Remove from all families as the removeId
  for(const fam of Object.values(families)){
    if(fam.husb===removeId)fam.husb=keepId;
    if(fam.wife===removeId)fam.wife=keepId;
    fam.children=fam.children.map(c=>c===removeId?keepId:c);
  }
  delete persons[removeId];
  if(selectedId===removeId)selectPerson(keepId);
  closeModal('dup-modal');updateSidebar();renderCurrentTab();scheduleSave();
  showToast(`Merged: kept ${keep.name}`);
  openDupModal();
}

// ── Stats ──
function renderStats(){
  const el=document.getElementById('tab-stats');const allP=Object.values(persons);
  const total=allP.length,males=allP.filter(p=>p.sex==='M').length,females=allP.filter(p=>p.sex==='F').length,totalFam=Object.keys(families).length;
  const ls=allP.filter(p=>{const b=extractYear(p.birth.date),d=extractYear(p.death.date);return b&&d&&d>b}).map(p=>extractYear(p.death.date)-extractYear(p.birth.date));
  const avgLife=ls.length?Math.round(ls.reduce((a,b)=>a+b,0)/ls.length):null;
  let mostKids=0,mostKidsPerson=null;for(const p of allP){const k=getChildren(p.id).length;if(k>mostKids){mostKids=k;mostKidsPerson=p}}
  const surMap=new Map();for(const p of allP){const s=p.nameSur||extractSurname(p.name)||'?';surMap.set(s,(surMap.get(s)||0)+1)}
  const topSur=[...surMap.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  const years=allP.flatMap(p=>[extractYear(p.birth.date),extractYear(p.death.date)]).filter(Boolean);
  const minY=years.length?Math.min(...years):null,maxY=years.length?Math.max(...years):null;
  const decMap=new Map();for(const p of allP){const b=extractYear(p.birth.date);if(b){const d=Math.floor(b/10)*10;decMap.set(d,(decMap.get(d)||0)+1)}}
  const decades=[...decMap.entries()].sort((a,b)=>a[0]-b[0]);
  let roots=allP.filter(p=>p.famc.length===0);let maxDepth=0;for(const r of roots.slice(0,5)){const d=getMaxDepth(r.id,new Set());maxDepth=Math.max(maxDepth,d)}
  const conflicts=findConflicts();
  let h='';
  if(conflicts.length){
    h+=`<details class="conflicts-section"><summary>⚠ Data Issues (${conflicts.length})</summary><table class="stats-table" style="margin-top:8px"><thead><tr><th>Person</th><th>Issue</th></tr></thead><tbody>${conflicts.map(c=>`<tr><td><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${c.personId}">${esc(c.name)}</a></td><td>${esc(c.issue)}</td></tr>`).join('')}</tbody></table></details>`;
  }
  h+=`<div class="stats-grid">
    <div class="stat-card"><div class="stat-card-val">${total}</div><div class="stat-card-label">People</div></div>
    <div class="stat-card"><div class="stat-card-val">${totalFam}</div><div class="stat-card-label">Families</div></div>
    <div class="stat-card"><div class="stat-card-val">${males}</div><div class="stat-card-label">Males</div></div>
    <div class="stat-card"><div class="stat-card-val">${females}</div><div class="stat-card-label">Females</div></div>
    ${avgLife?`<div class="stat-card"><div class="stat-card-val">${avgLife}</div><div class="stat-card-label">Avg Lifespan</div></div>`:''}
    ${mostKidsPerson?`<div class="stat-card"><div class="stat-card-val">${mostKids}</div><div class="stat-card-label">Most Children<br><small style="color:#999">${esc(mostKidsPerson.name)}</small></div></div>`:''}
    ${topSur[0]?`<div class="stat-card"><div class="stat-card-val">${topSur[0][1]}</div><div class="stat-card-label">Top Surname<br><small style="color:#999">${esc(topSur[0][0])}</small></div></div>`:''}
    ${minY&&maxY?`<div class="stat-card"><div class="stat-card-val">${minY}–${maxY}</div><div class="stat-card-label">Time Span</div></div>`:''}
    ${maxDepth?`<div class="stat-card"><div class="stat-card-val">${maxDepth}</div><div class="stat-card-label">Gen Depth</div></div>`:''}
  </div>`;
  if(topSur.length){const maxV=topSur[0][1];const BW=260,BH=16,G=3,svgH2=topSur.length*(BH+G);
    let bars='';for(let i=0;i<topSur.length;i++){const[n,c]=topSur[i];const bw=c/maxV*BW,y=i*(BH+G);bars+=`<rect x="90" y="${y}" width="${bw}" height="${BH}" rx="2" fill="#3a2a6a"/><text x="86" y="${y+12}" text-anchor="end" font-size="11" fill="#444">${esc(truncate(n,11))}</text><text x="${90+bw+4}" y="${y+12}" font-size="11" fill="#444">${c}</text>`}
    h+=`<div class="chart-section"><h3>Top Surnames</h3><svg width="${BW+160}" height="${svgH2}" viewBox="0 0 ${BW+160} ${svgH2}" role="img" aria-label="Bar chart of the ${topSur.length} most common surnames: ${esc(topSur.map(([n,c])=>`${n} (${c})`).join(', '))}">${bars}</svg></div>`;
  }
  if(decades.length){
    // Collect death decades alongside birth decades
    const deathDecMap=new Map();for(const p of allP){const d=extractYear(p.death.date);if(d){const dec=Math.floor(d/10)*10;deathDecMap.set(dec,(deathDecMap.get(dec)||0)+1)}}
    const allDecs=[...new Set([...decMap.keys(),...deathDecMap.keys()])].sort((a,b)=>a-b);
    const maxD=Math.max(...allDecs.map(d=>Math.max(decMap.get(d)||0,deathDecMap.get(d)||0)));
    const BW2=14,G2=4,CH=110,svgW2=allDecs.length*(BW2*2+G2+4);
    let bars='',legend=`<rect x="0" y="0" width="10" height="10" fill="#3a2a6a"/><text x="14" y="9" font-size="9" fill="#444">Births</text><rect x="54" y="0" width="10" height="10" fill="#6a2a3a"/><text x="68" y="9" font-size="9" fill="#444">Deaths</text>`;
    for(let i=0;i<allDecs.length;i++){
      const dec=allDecs[i];const bc=decMap.get(dec)||0;const dc=deathDecMap.get(dec)||0;
      const x=i*(BW2*2+G2+4);const bh=bc/maxD*CH;const dh=dc/maxD*CH;
      if(bc)bars+=`<rect x="${x}" y="${CH-bh}" width="${BW2}" height="${bh}" rx="2" fill="#3a2a6a"/><text x="${x+BW2/2}" y="${CH-bh-3}" text-anchor="middle" font-size="8" fill="#666">${bc}</text>`;
      if(dc)bars+=`<rect x="${x+BW2+2}" y="${CH-dh}" width="${BW2}" height="${dh}" rx="2" fill="#6a2a3a"/><text x="${x+BW2+2+BW2/2}" y="${CH-dh-3}" text-anchor="middle" font-size="8" fill="#666">${dc}</text>`;
      bars+=`<text x="${x+BW2}" y="${CH+12}" text-anchor="middle" font-size="9" fill="#666" transform="rotate(-45 ${x+BW2} ${CH+12})">${dec}s</text>`;
    }
    h+=`<div class="chart-section"><h3>Births &amp; Deaths per Decade</h3><svg width="${svgW2}" height="${CH+50}" viewBox="0 0 ${svgW2} ${CH+50}" style="overflow:visible" role="img" aria-label="Bar chart of births and deaths per decade, ${allDecs[0]}s to ${allDecs[allDecs.length-1]}s"><g transform="translate(0,16)">${bars}</g><g transform="translate(0,0)">${legend}</g></svg></div>`;
  }
  // ── Pedigree collapse (common ancestors in couples) ──
  const collapse=[];
  for(const fid of Object.keys(families)){
    const f=families[fid];if(!f.husb||!f.wife||!persons[f.husb]||!persons[f.wife])continue;
    const ancH=getAllAncestors(f.husb,new Set());ancH.delete(f.husb);
    const ancW=getAllAncestors(f.wife,new Set());ancW.delete(f.wife);
    const common=[...ancH].filter(id=>ancW.has(id)&&persons[id]);
    if(common.length)collapse.push({husb:persons[f.husb],wife:persons[f.wife],common:common.slice(0,4)});
    if(collapse.length>=12)break;
  }
  if(collapse.length){
    h+=`<div class="chart-section"><h3>Pedigree Collapse <span style="font-size:11px;font-weight:normal;color:#666">— couples with a shared ancestor</span></h3>`;
    h+=`<table class="stats-table"><thead><tr><th>Husband</th><th>Wife</th><th>Common Ancestor(s)</th></tr></thead><tbody>`;
    collapse.forEach(({husb,wife,common})=>{
      h+=`<tr><td><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${husb.id}">${esc(husb.name)}</a></td><td><a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${wife.id}">${esc(wife.name)}</a></td><td>${common.map(id=>`<a class="modal-link" role="link" tabindex="0" data-act="select" data-id="${id}">${esc(persons[id].name)}</a>`).join(', ')}</td></tr>`;
    });
    h+=`</tbody></table></div>`;
  }
  el.innerHTML=h;
}
function getMaxDepth(id,v){if(v.has(id))return 0;v.add(id);const ch=getChildren(id);if(!ch.length)return 1;return 1+Math.max(...ch.map(c=>getMaxDepth(c.id,v)))}

// ── Completeness score ──
function completenessScore(p){
  let s=0,max=6;
  if(p.birth.date)s+=2;
  if(p.birth.plac)s+=1;
  if(p.famc.length>0)s+=2;
  if(p.sex&&p.sex!=='U')s+=1;
  if(!p.living){max+=3;if(p.death.date)s+=2;if(p.death.plac)s+=1}
  return Math.round(s/max*100);
}
function completenessDotClass(p){const sc=completenessScore(p);return sc>=80?'cdot cdot-high':sc>=50?'cdot cdot-mid':sc>0?'cdot cdot-low':'cdot cdot-none'}

// ── Fan Chart ──
function renderFanChart(){
  const wrap=document.getElementById('fan-wrap');
  if(!selectedId){wrap.innerHTML=`<div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="empty-state-icon">🌀</div><p>Select a person from the list to see their fan chart.</p></div>`;return}
  wrap.innerHTML=`<div style="position:absolute;top:8px;left:8px;z-index:10;display:flex;gap:8px;align-items:center"><label for="fan-gen-sel" style="font-size:12px;color:#5a5a7a">Gens:</label><select id="fan-gen-sel" style="background:#fff;border:1px solid #c0c0d8;color:#333;border-radius:5px;padding:3px 6px;font-size:12px"><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8</option><option value="9">9</option><option value="10">10</option></select></div><div class="svg-wrap" id="fan-svg-wrap" style="position:absolute;inset:0;top:34px"></div>`;
  document.getElementById('fan-gen-sel').value=fanMaxGen;document.getElementById('fan-gen-sel').addEventListener('change',e=>{fanMaxGen=+e.target.value;drawFanSvg()});
  drawFanSvg();
}
function drawFanSvg(){
  const svgWrap=document.getElementById('fan-svg-wrap');if(!svgWrap||!selectedId)return;
  const mg=fanMaxGen;
  // Build generation map
  const genMap=[[{id:selectedId}]];
  for(let g=1;g<=mg;g++){genMap[g]=[];for(const node of genMap[g-1]){const pars=node.id?getParents(node.id):[];genMap[g].push({id:pars[0]?pars[0].id:null});genMap[g].push({id:pars[1]?pars[1].id:null})}}
  // Fan geometry: semicircle (π radians) centred at bottom.
  // Ring height shrinks for deeper charts so the SVG stays manageable.
  const innerR=50;
  const ringH=mg<=5?90:mg<=7?72:mg<=8?60:50;
  const maxR=innerR+mg*ringH+10;
  const svgW=(maxR+60)*2,svgH=maxR+80;const cx=svgW/2,cy=svgH-30;
  function arc(r1,r2,a1,a2,fill,stroke,click,label,sub){
    const pad=0.018;
    a1+=pad;a2-=pad;
    const midA=(a1+a2)/2,midR=(r1+r2)/2;
    const lx=cx+midR*Math.cos(Math.PI-midA),ly=cy-midR*Math.sin(Math.PI-midA);
    const x1=cx+r1*Math.cos(Math.PI-a1),y1=cy-r1*Math.sin(Math.PI-a1);
    const x2=cx+r2*Math.cos(Math.PI-a1),y2=cy-r2*Math.sin(Math.PI-a1);
    const x3=cx+r2*Math.cos(Math.PI-a2),y3=cy-r2*Math.sin(Math.PI-a2);
    const x4=cx+r1*Math.cos(Math.PI-a2),y4=cy-r1*Math.sin(Math.PI-a2);
    const large=a2-a1>Math.PI?1:0;
    const path=`M${f(x1)},${f(y1)} L${f(x2)},${f(y2)} A${r2},${r2} 0 ${large} 1 ${f(x3)},${f(y3)} L${f(x4)},${f(y4)} A${r1},${r1} 0 ${large} 0 ${f(x1)},${f(y1)} Z`;
    // Only draw text when the arc segment is wide enough to be legible
    const arcLen=(a2-a1)*midR;
    const showLabel=label&&arcLen>28;
    const showSub=sub&&midR>80&&arcLen>42;
    const nc=Math.max(3,Math.round(arcLen/7));
    const fs=midR>110?11:midR>70?9:8;
    const textEl=showLabel?`<text x="${f(lx)}" y="${f(ly-(showSub?5:2))}" text-anchor="middle" dominant-baseline="middle" font-size="${fs}" fill="#fff" font-weight="600" style="pointer-events:none">${esc(truncate(label,nc))}</text>`:'';
    const subEl=showSub?`<text x="${f(lx)}" y="${f(ly+7)}" text-anchor="middle" dominant-baseline="middle" font-size="8" fill="#f4f4ff" style="pointer-events:none">${esc(truncate(sub,nc))}</text>`:'';
    const titleEl=label?`<title>${esc(label)}${sub?', '+esc(sub):''}</title>`:'';
    return`<path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="1" ${click} style="cursor:${click?'pointer':'default'}">${titleEl}</path>${textEl}${subEl}`;
  }
  function f(n){return Math.round(n*10)/10}
  let paths='';
  // Centre circle for selected person
  const sp=persons[selectedId];
  const spFill=sp?(sp.sex==='M'?'#3a70c0':sp.sex==='F'?'#b04090':'#6262a8'):'#666';
  paths+=`<circle cx="${cx}" cy="${cy}" r="${innerR-2}" fill="${spFill}" stroke="${sp?.sex==='M'?'#5a90e0':sp?.sex==='F'?'#d060b0':'#9090d0'}" stroke-width="1.5" data-act="info" data-id="${selectedId}" tabindex="0" role="button" style="cursor:pointer"><title>${esc(sp?sp.name:'')}${sp&&lifespan(sp)?', '+esc(lifespan(sp)):''}</title></circle>`;
  if(sp){paths+=`<text x="${cx}" y="${cy-5}" text-anchor="middle" font-size="10" fill="#fff" font-weight="600" style="pointer-events:none">${esc(truncate(sp.name,12))}</text>`;paths+=`<text x="${cx}" y="${cy+7}" text-anchor="middle" font-size="8" fill="#f4f4ff" style="pointer-events:none">${esc(lifespan(sp))}</text>`}
  // Generation rings
  for(let g=1;g<=mg;g++){
    const cnt=Math.pow(2,g);const r1=innerR+(g-1)*ringH,r2=innerR+g*ringH;
    const span=Math.PI/cnt;
    for(let i=0;i<genMap[g].length;i++){
      const node=genMap[g][i];const p=node.id?persons[node.id]:null;
      const a1=i*span,a2=(i+1)*span;
      const fill=p?(p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8'):'#e8e8f0';
      const stroke=p?(p.sex==='M'?'#5a90e0':p.sex==='F'?'#d060b0':'#9090d0'):'#b0b0d0';
      const click=p?`data-act="select" data-id="${node.id}" tabindex="0" role="button"`:'' ;
      paths+=arc(r1,r2,a1,a2,fill,stroke,click,p?p.name:'',p?lifespan(p):'');
    }
    // Generation label at the inner edge (only where there's room)
    const GL=['','Parents','Grandparents','Great-Grandparents','2×Great-Grands','3×Great-Grands','4×Great-Grands','5×Great-Grands','6×Great-Grands','7×Great-Grands','8×Great-Grands'];
    const lbl=GL[g]||`Gen ${g}`;
    if(g<=4)paths+=`<text x="${cx}" y="${f(cy-r1-4)}" text-anchor="middle" font-size="9" fill="#55558f">${lbl}</text>`;
  }
  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');svgEl.setAttribute('width',svgW);svgEl.setAttribute('height',svgH);svgEl.setAttribute('viewBox',`0 0 ${svgW} ${svgH}`);
  svgEl.setAttribute('role','group');svgEl.setAttribute('aria-label',`Fan chart of ancestors of ${sp?.name||''}, ${mg} generations`);
  svgEl.innerHTML=paths;
  svgWrap.innerHTML='';svgWrap.appendChild(svgEl);const pz=makePanZoom(svgWrap,svgEl);pz.fitAll(svgW,svgH);svgControls(svgWrap,pz,svgW,svgH);svgWrap.__pz=pz;
}

// ── Hourglass Chart ──
function renderHourglass(){
  const wrap=document.getElementById('hourglass-wrap');
  if(!selectedId){wrap.innerHTML='<div class="empty-state" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)"><div class="empty-state-icon">⧗</div><p>Select a person from the list to see their hourglass chart.</p></div>';return}
  const BW=145,BH=46,HGAP=26,VGAP=18;

  // ── Collect ancestor rows (oldest first) ──
  const ancRows=[];
  const ancVis=new Set([selectedId]);
  (function goUp(ids){
    if(!ids.length||ancRows.length>=5)return;
    const valid=[...new Set(ids)].filter(id=>persons[id]&&!ancVis.has(id));
    if(!valid.length)return;
    valid.forEach(id=>ancVis.add(id));
    ancRows.unshift(valid.map(id=>({id})));
    const next=[];valid.forEach(id=>getParents(id).forEach(p=>{if(!ancVis.has(p.id))next.push(p.id)}));
    goUp(next);
  })(getParents(selectedId).map(p=>p.id));

  // ── Collect descendant rows (nearest first) ──
  const descRows=[];
  const descVis=new Set([selectedId]);
  (function goDown(ids){
    if(!ids.length||descRows.length>=5)return;
    const valid=[...new Set(ids)].filter(id=>persons[id]&&!descVis.has(id));
    if(!valid.length)return;
    valid.forEach(id=>descVis.add(id));
    descRows.push(valid.map(id=>({id})));
    const next=[];valid.forEach(id=>getChildren(id).forEach(c=>{if(!descVis.has(c.id))next.push(c.id)}));
    goDown(next);
  })(getChildren(selectedId).map(c=>c.id));

  // ── All rows ──
  const rows=[...ancRows,[{id:selectedId,isSelf:true}],...descRows];
  const selfRowIdx=ancRows.length;

  // ── Pass 1: compute positions for every node ──
  const maxCols=Math.max(1,...rows.map(r=>r.length));
  const svgW=Math.max(500,maxCols*(BW+HGAP)+60);
  const svgH=rows.length*(BH+VGAP)+60;
  const nodePos={};
  rows.forEach((row,ri)=>{
    const totalW=row.length*(BW+HGAP)-HGAP;
    const startX=(svgW-totalW)/2;
    const y=30+ri*(BH+VGAP);
    row.forEach((node,ni)=>{
      const x=startX+ni*(BW+HGAP);
      nodePos[node.id]={x,y,cx:x+BW/2};
    });
  });

  // ── Pass 2: draw lines (all positions known) ──
  let lines='';
  rows.forEach((row,ri)=>{
    if(ri===0)return;
    const prevIds=new Set(rows[ri-1].map(n=>n.id));
    row.forEach(node=>{
      const np=nodePos[node.id];if(!np)return;
      getParents(node.id).forEach(par=>{
        if(!prevIds.has(par.id))return;
        const pp=nodePos[par.id];if(!pp)return;
        const x1=pp.cx,y1=pp.y+BH,x2=np.cx,y2=np.y,my=(y1+y2)/2;
        lines+=`<path d="M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}" fill="none" stroke="#9090c8" stroke-width="1.5"/>`;
      });
    });
  });

  // ── Pass 3: draw boxes ──
  let rects='';
  rows.forEach(row=>{
    row.forEach(node=>{
      const p=persons[node.id];if(!p)return;
      const{x,y}=nodePos[node.id];const isSelf=node.isSelf;
      const fill=p.sex==='M'?'#3a70c0':p.sex==='F'?'#b04090':'#6262a8';
      const stroke=p.sex==='M'?'#5a90e0':p.sex==='F'?'#d060b0':'#9090d0';
      rects+=`<g data-act="select" data-id="${p.id}" tabindex="0" role="button" style="cursor:pointer">`;
      rects+=`<title>${esc(p.name)}${lifespan(p)?', '+esc(lifespan(p)):''}</title>`;
      rects+=`<rect x="${x}" y="${y}" width="${BW}" height="${BH}" rx="6" fill="${fill}" stroke="${stroke}" stroke-width="${isSelf?3:1.5}" ${isSelf?'filter="url(#glow)"':''}/>`;
      rects+=`<text x="${x+BW/2}" y="${y+16}" text-anchor="middle" font-size="11" fill="#fff" font-weight="600">${esc(truncate(p.name,18))}</text>`;
      rects+=`<text x="${x+BW/2}" y="${y+30}" text-anchor="middle" font-size="9" fill="#f4f4ff">${esc(lifespan(p))}</text>`;
      rects+=`<text x="${x+BW-8}" y="${y+11}" text-anchor="middle" font-size="8" fill="#fff" font-style="italic" data-act="info" data-id="${p.id}" style="cursor:pointer">i</text>`;
      rects+=`</g>`;
    });
  });

  // ── Row labels & dividers ──
  let labels='',dividers='';
  const ancLbl=['','Parents','Grandparents','Great-Grandparents','2×Great-Grands','3×Great-Grands'];
  const descLbl=['','Children','Grandchildren','Great-Grandchildren','2×Great-GC','3×Great-GC'];
  ancRows.forEach((_,i)=>{const lbl=ancLbl[ancRows.length-i]||`+${ancRows.length-i} gen`;const y=30+i*(BH+VGAP)+BH/2+4;labels+=`<text x="4" y="${y}" font-size="10" fill="#55558f">${lbl}</text>`});
  descRows.forEach((_,i)=>{const lbl=descLbl[i+1]||`-${i+1} gen`;const y=30+(selfRowIdx+1+i)*(BH+VGAP)+BH/2+4;labels+=`<text x="4" y="${y}" font-size="10" fill="#55558f">${lbl}</text>`});
  if(ancRows.length){const dy=30+selfRowIdx*(BH+VGAP)-VGAP/2;dividers+=`<line x1="20" y1="${dy}" x2="${svgW-20}" y2="${dy}" stroke="#c0c0d8" stroke-width="1" stroke-dasharray="5,3"/>`}
  if(descRows.length){const dy=30+(selfRowIdx+1)*(BH+VGAP)-VGAP/2;dividers+=`<line x1="20" y1="${dy}" x2="${svgW-20}" y2="${dy}" stroke="#c0c0d8" stroke-width="1" stroke-dasharray="5,3"/>`}

  const svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');
  svgEl.setAttribute('width',svgW);svgEl.setAttribute('height',svgH);svgEl.setAttribute('viewBox',`0 0 ${svgW} ${svgH}`);
  svgEl.setAttribute('role','group');svgEl.setAttribute('aria-label',`Hourglass chart of ${persons[selectedId]?.name||''}: ancestors above, descendants below`);
  svgEl.innerHTML=`<defs><filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${dividers}${lines}${rects}${labels}`;
  wrap.innerHTML='';wrap.appendChild(svgEl);
  const pz=makePanZoom(wrap,svgEl);pz.fitAll(svgW,svgH);svgControls(wrap,pz,svgW,svgH);wrap.__pz=pz;
}

// ── Map ──
// Tear down the Leaflet instance and any in-flight geocoding. Without
// mapInstance.remove() Leaflet keeps its DOM listeners alive (memory leak) and
// throws "Map container is already initialized" the next time a map is created.
function destroyMap(){
  if(geoAbort){geoAbort.abort();geoAbort=null}
  if(mapInstance){try{mapInstance.remove()}catch(e){}mapInstance=null}
  document.querySelectorAll('.geo-progress').forEach(el=>el.remove());
}
function renderMap(){
  const el=document.getElementById('tab-map');
  if(!el.querySelector('#map-container'))el.innerHTML='<div id="map-container"></div>';
  if(leafletLoaded){if(!mapInstance)initLeafletMap();else setTimeout(()=>{try{mapInstance.invalidateSize()}catch(e){}},60);return}
  if(leafletLoading)return;leafletLoading=true;
  const link=document.createElement('link');link.rel='stylesheet';link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';document.head.appendChild(link);
  const script=document.createElement('script');script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  script.onload=()=>{leafletLoaded=true;leafletLoading=false;initLeafletMap()};script.onerror=()=>{leafletLoading=false;renderMapFallback()};document.head.appendChild(script);
}
function initLeafletMap(){
  const cont=document.getElementById('map-container');if(!cont||!window.L)return;
  if(mapInstance){try{mapInstance.remove()}catch(e){}mapInstance=null}
  // Abort any in-progress geocoding from a previous map session
  if(geoAbort){geoAbort.abort();geoAbort=null}
  const L=window.L;mapInstance=L.map('map-container',{preferCanvas:true}).setView([30,10],2);
  // CARTO basemaps now require an API key (tiles render "API KEY REQUIRED"), so use standard OSM tiles
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',maxZoom:19}).addTo(mapInstance);
  const pm=new Map();const addP=(pl,pid)=>{if(!pl)return;const k=pl.trim();if(!k)return;if(!pm.has(k))pm.set(k,new Set());pm.get(k).add(pid)};
  for(const p of Object.values(persons)){addP(p.birth.plac,p.id);addP(p.death.plac,p.id);for(const e of p.events)addP(e.plac,p.id)}
  for(const f of Object.values(families))if(f.marr.plac)[f.husb,f.wife].filter(Boolean).forEach(id=>addP(f.marr.plac,id));
  const places=[...pm.entries()];
  places.forEach(([pl,pids])=>{if(geoCache[pl])addMarker(L,pl,pids,geoCache[pl].lat,geoCache[pl].lon)});
  const uncached=places.filter(([p])=>!geoCache[p]);
  const prog=document.createElement('div');prog.className='geo-progress';prog.setAttribute('role','status');prog.setAttribute('aria-live','polite');prog.style.cssText='position:absolute;top:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.75);color:#fff;padding:4px 12px;border-radius:14px;font-size:12px;z-index:1000;pointer-events:none';
  document.getElementById('tab-map').appendChild(prog);
  // AbortController lets us cancel in-flight Nominatim requests when navigating away
  const ac=new AbortController();geoAbort=ac;
  let idx=0;
  function next(){
    if(ac.signal.aborted)return; // navigation cancelled this session
    if(idx>=uncached.length){prog.textContent=`${places.length} place${places.length!==1?'s':''} mapped`;setTimeout(()=>prog.remove(),2000);return}
    const[pl,pids]=uncached[idx++];prog.textContent=`Geocoding ${idx}/${uncached.length}: ${pl.slice(0,30)}…`;
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(pl)}&format=json&limit=1`,{signal:ac.signal})
      .then(r=>r.json())
      .then(data=>{if(data&&data[0]){const lat=+data[0].lat,lon=+data[0].lon;geoCache[pl]={lat,lon};try{localStorage.setItem('geoCache',JSON.stringify(geoCache))}catch(e){}if(!ac.signal.aborted)addMarker(L,pl,pids,lat,lon)}})
      .catch(e=>{if(e.name==='AbortError')return}) // silently ignore abort
      .finally(()=>{if(!ac.signal.aborted)setTimeout(next,1100)});
  }
  // The sidebar animates closed when the Map tab opens; re-measure once it has
  setTimeout(()=>{try{mapInstance?.invalidateSize()}catch(e){}},250);
  if(uncached.length)next();else if(!places.length){prog.textContent='No place data.';setTimeout(()=>prog.remove(),3000)}else prog.remove();
}
function addMarker(L,place,pids,lat,lon){
  const ids=[...pids];
  // Escape all user-sourced strings before embedding in popup HTML
  const names=ids.slice(0,6).map(id=>esc(persons[id]?.name||id)).join('<br>');
  const more=ids.length>6?`<br><em>…and ${ids.length-6} more</em>`:'';
  L.circleMarker([lat,lon],{radius:5+Math.min(ids.length,15)/3,color:'#7c5cbf',fillColor:'#a78bfa',fillOpacity:.75,weight:1.5})
    .addTo(mapInstance)
    .bindPopup(`<b>${esc(place)}</b><br><small>${ids.length} people</small><br>${names}${more}`);
}
function renderMapFallback(){const el=document.getElementById('tab-map');const places=collectPlaces();let h='<div style="padding:14px"><p style="color:#888;margin-bottom:10px;font-size:13px">Map unavailable offline. Places:</p>';for(const[name,ids]of places.slice(0,60))h+=`<a href="https://www.openstreetmap.org/search?query=${encodeURIComponent(name)}" target="_blank" style="display:flex;gap:8px;align-items:center;padding:5px 9px;background:#fff;border:1px solid #d8d8e8;border-radius:6px;margin-bottom:3px;text-decoration:none;color:#1a1a2e"><span style="flex:1">${esc(name)}</span><span style="background:#ede8f8;color:#6a40b0;border-radius:10px;padding:2px 7px;font-size:11px">${ids.size}</span></a>`;el.innerHTML=h+'</div>'}

// ── Sidebar ──
let listHighlightIdx=-1;
function personMatchesQuery(p,q){
  if(!q)return true;
  if(p.name.toLowerCase().includes(q))return true;
  if(p.birth.plac?.toLowerCase().includes(q))return true;
  if(p.birth.date?.toLowerCase().includes(q))return true;
  if(p.death.plac?.toLowerCase().includes(q))return true;
  if(p.death.date?.toLowerCase().includes(q))return true;
  for(const n of p.notes||[])if(n.toLowerCase().includes(q))return true;
  for(const e of p.events||[]){if(e.plac?.toLowerCase().includes(q))return true;if(e.date?.toLowerCase().includes(q))return true;if(e.val?.toLowerCase().includes(q))return true}
  return false;
}
function getFilteredPersons(){
  const q=document.getElementById('search-box').value.toLowerCase().trim();
  const sex=document.getElementById('filter-sex').value;
  const ba=+document.getElementById('filter-born-after').value||null;
  const bb=+document.getElementById('filter-born-before').value||null;
  const extra=document.getElementById('filter-extra').checked;
  return getSortedPersons().filter(p=>{
    if(!personMatchesQuery(p,q))return false;
    if(sex&&p.sex!==sex)return false;
    if(ba||bb){const by=extractYear(p.birth.date);if(ba&&(!by||by<ba))return false;if(bb&&(!by||by>bb))return false}
    if(extra&&!hasExtraData(p))return false;
    return true;
  });
}
const ITEM_H=28;
function renderSidebar(){
  const filtered=getFilteredPersons();const list=document.getElementById('person-list');
  const total=Object.keys(persons).length;
  document.getElementById('result-count').textContent=filtered.length===total?`${total} people`:`${filtered.length} of ${total}`;
  // Batch bar update
  const batchBar=document.getElementById('batch-bar');
  if(batchBar){batchBar.style.display=batchMode?'flex':'none';if(batchMode){const ct=document.getElementById('batch-count');if(ct)ct.textContent=batchSelected.size+' selected'}}
  const buttonBatch=document.getElementById('btn-batch');
  if(buttonBatch){buttonBatch.classList.toggle('active',batchMode);buttonBatch.setAttribute('aria-pressed',batchMode?'true':'false')}
  if(batchMode)list.setAttribute('aria-multiselectable','true');else list.removeAttribute('aria-multiselectable');

  if(!filtered.length){
    list.innerHTML=total?`<div class="list-empty" role="presentation">🔎 Nobody matches that search.<br><small>Try fewer letters, or clear the filters.</small></div>`:`<div class="list-empty" role="presentation">🌱 No one here yet.<br><small>Press <strong>＋ Person</strong> to plant the first name.</small></div>`;
    list.removeAttribute('aria-activedescendant');return;
  }
  // Virtual scrolling for large lists
  const virt=filtered.length>200;
  let startIdx=0,endIdx=filtered.length;
  if(virt){
    const scrollTop=list.scrollTop,visH=list.clientHeight||400;
    startIdx=Math.max(0,Math.floor(scrollTop/ITEM_H)-5);
    endIdx=Math.min(filtered.length,Math.ceil((scrollTop+visH)/ITEM_H)+5);
  }
  const items=filtered.slice(startIdx,endIdx).map((p,ri)=>personItemHtml(p,startIdx+ri,virt)).join('');
  list.innerHTML=virt?`<div style="height:${startIdx*ITEM_H}px" role="presentation"></div>${items}<div style="height:${(filtered.length-endIdx)*ITEM_H}px" role="presentation"></div>`:items;
  const hl=list.querySelector('.person-item.highlighted');
  if(hl)list.setAttribute('aria-activedescendant',hl.id);else list.removeAttribute('aria-activedescendant');
}
// Colour is never the only signal: each row carries a screen-reader summary
// of sex, living status, completeness and open tasks.
function personItemHtml(p,i,fixedH){
  const sc=completenessScore(p);
  const relBadge=relToAllMode&&p.id!==selectedId&&relToAllCache[p.id]?`<span class="rel-badge">${esc(relToAllCache[p.id])}</span>`:'';
  const livDot=p.living?`<div class="living-dot" title="Living" aria-hidden="true"></div>`:'';
  const cDot=`<div class="${completenessDotClass(p)}" title="Record completeness: ${sc}%" aria-hidden="true"></div>`;
  const undone=(p.tasks||[]).filter(t=>!t.done).length;
  const taskBadge=undone?`<span class="task-badge" title="${undone} open research task${undone>1?'s':''}" aria-hidden="true">${undone}</span>`:'';
  const batchCb=batchMode?`<input type="checkbox" ${batchSelected.has(p.id)?'checked':''} data-act="batch-cb" data-id="${p.id}" tabindex="-1" aria-hidden="true" style="flex-shrink:0">`:'';
  const sr=`<span class="visually-hidden">, ${sexWord(p)}${p.living?', living':''}, record ${sc}% complete${undone?`, ${undone} open task${undone>1?'s':''}`:''}${relBadge?', '+esc(relToAllCache[p.id]):''}</span>`;
  const sel=batchMode?batchSelected.has(p.id):p.id===selectedId;
  return`<div class="person-item${p.id===selectedId?' selected':''}${i===listHighlightIdx?' highlighted':''}" id="pi-${i}" role="option" aria-selected="${sel}" data-act="person-row" data-id="${p.id}" data-idx="${i}"${fixedH?` style="height:${ITEM_H}px"`:''}>${batchCb}${avatarHtml(p,'sm')}${livDot}${cDot}<div class="person-item-name">${esc(displayName(p))}</div><div class="person-item-years">${esc(lifespan(p))}</div>${relBadge?`<span aria-hidden="true">${relBadge}</span>`:''}${taskBadge}${sr}<button class="pi-del" data-act="del-person" data-id="${p.id}" title="Delete ${esc(p.name)}" tabindex="-1" aria-hidden="true">✕</button></div>`;
}
function sexWord(p){return p.sex==='M'?'male':p.sex==='F'?'female':p.sex==='X'?'other sex':'sex unknown'}
function initials(p){
  const g=(p.nameGiven||p.name||'').replace(/[^\p{L}\s'-]/gu,'').trim(),s=(p.nameSur||'').replace(/[^\p{L}'-]/gu,'').trim();
  const words=g.split(/\s+/).filter(Boolean);
  return((words[0]||'?')[0]+(s?s[0]:(words[1]||'')[0]||'')).toUpperCase();
}
function avatarHtml(p,size=''){return`<span class="avatar ${sexClass(p)}${size?' avatar-'+size:''}" aria-hidden="true">${esc(initials(p))}</span>`}
function updateSidebar(){renderSidebar()}
document.getElementById('person-list').addEventListener('scroll',()=>{if(getFilteredPersons().length>200)renderSidebar()},{passive:true});
['search-box','filter-sex','filter-born-after','filter-born-before','filter-extra'].forEach(id=>{const el=document.getElementById(id);if(el)el.addEventListener(el.type==='checkbox'?'change':'input',()=>{listHighlightIdx=-1;updateSidebar()})});
document.getElementById('sort-sel').addEventListener('change',e=>{currentSort=e.target.value;updateSidebar()});
document.getElementById('btn-rel-all').addEventListener('click',()=>{
  relToAllMode=!relToAllMode;
  document.getElementById('btn-rel-all').classList.toggle('active',relToAllMode);
  document.getElementById('btn-rel-all').setAttribute('aria-pressed',relToAllMode?'true':'false');
  if(relToAllMode)computeRelToAll();else relToAllCache={};
  updateSidebar();
});
document.getElementById('filter-dim').addEventListener('change',applyRelativeDim);
document.getElementById('btn-compact').addEventListener('click',()=>{const l=document.getElementById('person-list');l.classList.toggle('person-list-compact');const on=l.classList.contains('person-list-compact');const b=document.getElementById('btn-compact');b.classList.toggle('active',on);b.setAttribute('aria-pressed',on?'true':'false')});

// ── Person selection ──
function selectPerson(id){
  selectedId=id;if(currentTreeId)try{localStorage.setItem('lastSelected_'+currentTreeId,id)}catch(e){}
  writeLocation();
  document.title=(persons[id]?.name||'')+' — '+currentTreeName+' — Family Tree';
  document.querySelectorAll('.person-item').forEach(el=>{const on=el.dataset.id===id;el.classList.toggle('selected',on);if(!batchMode)el.setAttribute('aria-selected',on)});
  const sel=document.querySelector(`.person-item[data-id="${id}"]`);if(sel)sel.scrollIntoView({block:'nearest'});
  document.getElementById('btn-relationship').style.display='';
  document.getElementById('btn-edit-person').style.display='';
  if(relToAllMode)computeRelToAll();
  applyRelativeDim();renderCurrentTab();
  if(relToAllMode)updateSidebar();
}
function applyRelativeDim(){
  const dim=document.getElementById('filter-dim')?.checked;
  if(!dim||!selectedId){document.querySelectorAll('.person-item.not-relative').forEach(el=>el.classList.remove('not-relative'));return}
  const rel=new Set();getAllAncestors(selectedId,rel);getDescendants(selectedId,rel);getSpouses(selectedId).forEach(sp=>rel.add(sp.person.id));getSiblings(selectedId).forEach(s=>rel.add(s.id));
  document.querySelectorAll('.person-item').forEach(el=>el.classList.toggle('not-relative',!rel.has(el.dataset.id)));
}

// ── Tab switching ──
const TABS_WITH_SIDEBAR=new Set(['listtree','ancestors','chart','fan','hourglass','fam-view']);
function switchTab(tabId){
  currentTab=tabId;
  document.querySelectorAll('.tab-btn').forEach(b=>{const on=b.dataset.tab===tabId;b.classList.toggle('active',on);b.setAttribute('aria-selected',on?'true':'false')});
  syncTabStops();writeLocation();
  document.querySelectorAll('.tab-pane').forEach(p=>p.classList.toggle('active',p.id==='tab-'+tabId));
  document.getElementById('sidebar').classList.toggle('sidebar-hidden',!TABS_WITH_SIDEBAR.has(tabId));
  renderCurrentTab();
}
function renderCurrentTab(){
  switch(currentTab){
    case'listtree':renderListTree();break;
    case'ancestors':renderAncestors();break;
    case'chart':renderChart();break;
    case'timeline':if(!timelineBuilt)renderTimeline();break;
    case'places':renderPlaces();break;
    case'surnames':renderSurnames();break;
    case'stats':renderStats();break;
    case'fan':renderFanChart();break;
    case'map':renderMap();break;
    case'hourglass':renderHourglass();break;
    case'fam-view':renderFamView();break;
  }
}
document.querySelectorAll('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));

// ── Location ──
// The open tree, tab and person live in the URL hash (#tree=3&tab=stats&person=I12)
// so a reload, bookmark or the Back button lands in the same place.
function readLocation(){
  const q=new URLSearchParams(location.hash.slice(1));const t=q.get('tab'),pp=q.get('person');
  return{tree:+q.get('tree')||null,tab:TAB_IDS.includes(t)?t:null,person:pp?`@${safeId(pp)}@`:null};
}
let pushNextLocation=false; // opening a tree from the home screen adds a history entry, so Back returns home
function writeLocation(push=false){
  if(pushNextLocation){push=true;pushNextLocation=false}
  let h='';
  if(currentTreeId){const q=new URLSearchParams({tree:currentTreeId});if(currentTab!=='listtree')q.set('tab',currentTab);if(selectedId)q.set('person',selectedId.replace(/@/g,''));h='#'+q}
  const url=location.pathname+location.search+h;
  if(url!==location.pathname+location.search+location.hash)history[push?'pushState':'replaceState'](null,'',url);
}
addEventListener('popstate',()=>{
  const loc=readLocation();
  if(!loc.tree&&currentTreeId)showHomeScreen(true);
  else if(loc.tree&&loc.tree!==currentTreeId)loadTreeById(loc.tree,loc,true);
  else if(loc.tree){if(loc.tab&&loc.tab!==currentTab)switchTab(loc.tab);if(loc.person&&persons[loc.person]&&loc.person!==selectedId)selectPerson(loc.person)}
});

// ── File loading ──
function loadGedcom(text,filename,loc={}){
  parseGedcom(text);undoStack=[];
  const count=Object.keys(persons).length;
  if(count===0&&!filename){alert('No individuals found. Check GEDCOM format.');return}
  destroyMap();timelineBuilt=false;selectedId=null;
  document.getElementById('home-screen').style.display='none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('btn-export-ged').style.display='';
  document.getElementById('btn-merge-ged').style.display='';
  document.getElementById('btn-csv-import').style.display='';
  currentTreeName=filename?(filename.replace(/.*[\\/]/,'').replace(/\.ged$/i,'')):'Family Tree';
  document.getElementById('app-title').textContent=currentTreeName;
  document.title=currentTreeName+' — Family Tree';
  updateSidebar();
  const lastId=(()=>{try{return currentTreeId?localStorage.getItem('lastSelected_'+currentTreeId):null}catch(e){return null}})();
  const first=getSortedPersons()[0];
  if(loc.tab)switchTab(loc.tab);
  if(loc.person&&persons[loc.person])selectPerson(loc.person);
  else if(lastId&&persons[lastId])selectPerson(lastId);
  else if(first)selectPerson(first.id);
  else renderCurrentTab();
  syncTabStops();setSaveStatus('','All changes saved');writeLocation();
  showToast(count?`🌳 ${currentTreeName} — ${count} ${count===1?'person':'people'}`:`🌱 ${currentTreeName} is ready for its first person`,2500);
  document.getElementById('search-box').focus();
}
async function importGedcomFile(text,filename){
  await saveNow();currentTreeId=null;
  loadGedcom(text,filename);
  const cnt=Object.keys(persons).length,now=Date.now();
  const result=await apiCreateTree({name:currentTreeName,gedcom:text,person_count:cnt,created:now,modified:now});
  if(result){currentTreeId=result.id;treeMod.set(result.id,now);writeLocation(true)}
  else showToast('⚠️ The import could not be saved to the server — export it before leaving this page',6000);
}

// ── GEDCOM import event handlers ──
const dropZone=document.getElementById('drop-zone');
const fileInput=document.getElementById('file-input');
fileInput.addEventListener('change',e=>{const file=e.target.files[0];if(!file)return;const reader=new FileReader();reader.onload=ev=>importGedcomFile(ev.target.result,file.name);reader.readAsText(file,'utf-8')});
dropZone.addEventListener('dragover',e=>{e.preventDefault();dropZone.classList.add('dragover')});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop',e=>{e.preventDefault();dropZone.classList.remove('dragover');const file=e.dataTransfer.files[0];if(!file)return;const reader=new FileReader();reader.onload=ev=>importGedcomFile(ev.target.result,file.name);reader.readAsText(file,'utf-8')});
document.addEventListener('dragover',e=>e.preventDefault());
document.addEventListener('drop',e=>{e.preventDefault();if(document.getElementById('app').classList.contains('visible')){const file=e.dataTransfer.files[0];if(!file)return;const reader=new FileReader();reader.onload=ev=>importGedcomFile(ev.target.result,file.name);reader.readAsText(file,'utf-8')}});
// Merge GEDCOM file input
document.getElementById('merge-file-input').addEventListener('change',e=>{
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=ev=>{mergeGedcomFile(ev.target.result)};
  reader.readAsText(file,'utf-8');
  e.target.value='';
});

// ── Home Screen ──
// Reads the currently loaded persons/families, so it must be called BEFORE
// the globals are cleared when navigating back to the home screen.
function collectAnniversaries(){
  const now=new Date();
  const annEvents=[];
  const todayYear=now.getFullYear();
  const today=new Date(todayYear,now.getMonth(),now.getDate());
  function daysUntil(m,d){let target=new Date(todayYear,m-1,d);if(target<today)target=new Date(todayYear+1,m-1,d);return Math.round((target-today)/86400000)}
  const ord=n=>n+(['th','st','nd','rd'][(n%100-20)%10]||['th','st','nd','rd'][n%100]||'th');
  for(const p of Object.values(persons)){
    const b=p.birth.date;if(!b)continue;
    const bm=b.match(/\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})\b/i);
    if(!bm)continue;
    const mn=MON_NAMES.indexOf(bm[2].toUpperCase())+1;const dy=+bm[1];const byear=+bm[3];
    if(!mn||!dy)continue;
    const days=daysUntil(mn,dy);
    if(days<=7){const age=todayYear-byear+(days>0&&new Date(todayYear,mn-1,dy)<today?1:0);const alive=p.living||(!p.death.date&&!p.death.confirmed&&age<105);const verb=alive?(days===0?'turns':'will be'):(days===0?'would have been':'would be');const txt=days===0?`🎂 Today: ${p.name} ${verb} ${age}`:`🎂 In ${days} day${days>1?'s':''}: ${p.name} ${verb} ${age}`;annEvents.push({days,txt})}
  }
  for(const f of Object.values(families)){
    if(!f.marr.date)continue;
    const mm=f.marr.date.match(/\b(\d{1,2})\s+([A-Z]{3})\s+(\d{4})\b/i);
    if(!mm)continue;
    const mn=MON_NAMES.indexOf(mm[2].toUpperCase())+1;const dy=+mm[1];const myear=+mm[3];
    if(!mn||!dy)continue;
    const days=daysUntil(mn,dy);
    if(days<=7){const yrs=todayYear-myear+(days>0&&new Date(todayYear,mn-1,dy)<today?1:0);const h=f.husb&&persons[f.husb]?persons[f.husb].name:'?';const w=f.wife&&persons[f.wife]?persons[f.wife].name:'?';const txt=days===0?`💑 Today: ${h} & ${w} — ${ord(yrs)} wedding anniversary`:`💑 In ${days} day${days>1?'s':''}: ${h} & ${w} — ${ord(yrs)} wedding anniversary`;annEvents.push({days,txt})}
  }
  annEvents.sort((a,b)=>a.days-b.days);
  return annEvents;
}
async function renderHomeScreen(annEvents=[]){
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('home-screen').style.display='';
  document.getElementById('app').classList.remove('visible');
  document.title='Family Tree';
  const hr=new Date().getHours();
  const tag=['Every family has a story — let\'s explore yours.','Who will you discover today?','Roots, branches and the odd surprise.','Grab a cuppa and wander through the generations.'];
  document.getElementById('home-greeting').textContent=`${hr<12?'Good morning ☀️':hr<18?'Good afternoon 🌤️':'Good evening 🌙'} ${tag[Math.floor(Math.random()*tag.length)]}`;
  const trees=await apiGetTrees();
  if(!trees)return; // 401 → already redirected to login
  const grid=document.getElementById('home-trees-grid');
  if(!trees.length){grid.innerHTML='<div class="no-trees"><div class="no-trees-icon" aria-hidden="true">🌱</div>No trees yet — let\'s plant one!<br><small>Start a new tree, or import a GEDCOM file from another family-history program.</small></div>';return}
  let bannerHtml='';
  if(annEvents.length){bannerHtml=`<details id="anniversary-banner" open><summary>🗓 Upcoming anniversaries &amp; birthdays (${annEvents.length})</summary><ul>${annEvents.map(e=>`<li>${esc(e.txt)}</li>`).join('')}</ul></details>`}
  const existingBanner=document.getElementById('anniversary-banner');
  if(existingBanner)existingBanner.remove();
  if(bannerHtml){const tempDiv=document.createElement('div');tempDiv.innerHTML=bannerHtml;const bannerEl=tempDiv.firstChild;grid.parentElement.insertBefore(bannerEl,grid)}
  const icons=['🌳','🌲','🌴','🌿','🍀','🌻','🌸','🍁'];
  grid.innerHTML=trees.map(t=>`
    <div class="tree-card">
      <div class="tree-card-icon" aria-hidden="true">${icons[t.id%icons.length]}</div>
      <button class="tree-card-open" type="button" data-act="load-tree" data-tid="${t.id}" aria-describedby="tc-meta-${t.id}"><span class="tree-card-name">${esc(t.name)}</span></button>
      <div class="tree-card-meta" id="tc-meta-${t.id}"><span aria-hidden="true">👥</span> ${t.person_count||0} ${t.person_count===1?'person':'people'} · updated ${relTs(t.modified)}</div>
      <div class="tree-card-actions">
        <button class="tc-btn" data-act="rename-tree" data-tid="${t.id}" data-name="${esc(t.name)}" type="button" aria-label="Rename ${esc(t.name)}"><span aria-hidden="true">✏️</span> Rename</button>
        <button class="tc-btn danger" data-act="delete-tree" data-tid="${t.id}" type="button" aria-label="Delete ${esc(t.name)}"><span aria-hidden="true">🗑️</span> Delete</button>
      </div>
    </div>`).join('');
}
async function loadTreeById(id,loc={},fromHistory=false){
  if(currentTreeId&&currentTreeId!==id)await saveNow();
  const tree=await apiGetTree(id,{quiet:true});
  if(!tree){showToast('🤔 That tree could not be opened — it may have been deleted',4000);if(!document.getElementById('app').classList.contains('visible'))renderHomeScreen();return false}
  treeMod.set(id,+tree.modified||0);
  let ged=tree.gedcom,restored=false;
  // Changes saved on this device but never confirmed by the server (closed tab,
  // lost connection, expired login…) are kept in a local backup — offer them back.
  const bk=readBackup(id);
  if(bk){
    if(bk.ged===tree.gedcom)clearBackup(id);
    else if(bk.base===+tree.modified){ged=bk.ged;restored=true} // nobody else saved since: just carry on
    else if(confirm(`This device has changes to "${tree.name}" from ${new Date(bk.at).toLocaleString()} that never reached the server — and the tree has been saved from somewhere else since.\n\nOK: keep YOUR version (replaces the other changes)\nCancel: use the SAVED version (a copy of yours is downloaded first)`)){ged=bk.ged;restored=true}
    else{downloadGed(bk.ged,tree.name+' (my unsaved changes)');clearBackup(id)}
  }
  pushNextLocation=!fromHistory&&!currentTreeId;
  currentTreeId=id;loadGedcom(ged,tree.name,loc);pushNextLocation=false;
  if(restored){scheduleSave();showToast('♻️ Your unsaved changes were restored',3500)}
  return true;
}
async function createNewTree(){
  const name=prompt('What shall we call your new tree?','Our Family Tree');if(!name)return;
  const ged='0 HEAD\r\n1 GEDC\r\n2 VERS 7.0\r\n1 SOUR FamilyTreeApp\r\n2 NAME Family Tree\r\n1 LANG en\r\n0 TRLR';
  const now=Date.now();
  const result=await apiCreateTree({name,gedcom:ged,person_count:0,created:now,modified:now});
  if(!result)return;
  currentTreeId=result.id;treeMod.set(result.id,now);currentTreeName=name;persons={};families={};sources={};extraRecords=[];selectedId=null;destroyMap();timelineBuilt=false;
  writeLocation(true);
  document.getElementById('home-screen').style.display='none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('btn-export-ged').style.display='';
  document.getElementById('btn-merge-ged').style.display='';
  document.getElementById('btn-csv-import').style.display='';
  document.getElementById('app-title').textContent=name;
  document.title=name+' — Family Tree';
  undoStack=[];syncTabStops();setSaveStatus('','All changes saved');
  updateSidebar();renderCurrentTab();celebrate();showToast(`🌱 "${name}" planted — now add the first person`,3000);
  setTimeout(()=>openEditModal(null),120);
}
async function renameTree(id,currentName){
  const name=prompt('New name:',currentName);if(!name||name===currentName)return;
  const tree=await apiGetTree(id);if(!tree)return;
  const modified=Date.now();
  if(await apiUpdateTree(id,{name,gedcom:tree.gedcom,person_count:tree.person_count,modified}))treeMod.set(id,modified);
  if(currentTreeId===id){currentTreeName=name;document.getElementById('app-title').textContent=name}
  renderHomeScreen();
}
async function deleteTree(id){
  if(!confirm('Delete this tree permanently?'))return;
  await apiDeleteTree(id);clearBackup(id);
  if(currentTreeId===id){destroyMap();currentTreeId=null;persons={};families={};sources={};selectedId=null;timelineBuilt=false}
  renderHomeScreen();
}
function showHomeScreen(fromHistory=false){
  saveNow(); // send any pending edit now (it captures the tree before we clear it)
  destroyMap();
  // Collect anniversaries from the tree we're leaving BEFORE clearing it, so
  // the home-screen banner has data to show.
  const ann=collectAnniversaries();
  currentTreeId=null;persons={};families={};sources={};extraRecords=[];selectedId=null;timelineBuilt=false;undoStack=[];
  if(!fromHistory)writeLocation(true);
  renderHomeScreen(ann).then(()=>{const first=document.querySelector('.tree-card-open');(first||document.getElementById('home-screen')).focus()});
}

// ── Keyboard ──
// Single-character shortcuts can be switched off from the shortcuts panel
// (WCAG 2.1.4) so they never fight speech-input or switch users.
let singleKeyShortcuts=(()=>{try{return localStorage.getItem('singleKeyShortcuts')!=='off'}catch(e){return true}})();
{
  const t=document.getElementById('kbd-single-toggle');t.checked=singleKeyShortcuts;
  t.addEventListener('change',()=>{singleKeyShortcuts=t.checked;try{localStorage.setItem('singleKeyShortcuts',t.checked?'on':'off')}catch(e){}showToast(t.checked?'⌨️ Single-key shortcuts on':'⌨️ Single-key shortcuts off')});
}
function anyOverlayOpen(){return!!document.querySelector('.modal-overlay:not(.hidden),#kbd-overlay:not(.hidden)')}
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented)return; // a combobox/menu already handled this key
  const t=e.target,tag=t.tagName.toLowerCase();const inInput=tag==='input'||tag==='select'||tag==='textarea'||t.isContentEditable;
  // Guide modal can be open from the login screen too — handle it before the app-visible gate
  if(e.key==='Escape'&&!document.getElementById('guide-modal').classList.contains('hidden')){closeModal('guide-modal');return}
  const appVisible=document.getElementById('app').classList.contains('visible');if(!appVisible)return;
  if(e.key==='Escape'){
    if(!document.getElementById('kbd-overlay').classList.contains('hidden')){document.getElementById('kbd-overlay').classList.add('hidden');return}
    for(const id of['edit-modal','rel-modal','person-modal','place-modal','narrative-modal','dup-modal'])if(!document.getElementById(id).classList.contains('hidden')){closeModal(id);return}
    if(t.id==='search-box'||t.closest?.('#person-list')){document.getElementById('search-box').value='';listHighlightIdx=-1;updateSidebar()}
    return;
  }
  // Never hijack typing, text-field undo or arrow keys, and leave dialogs alone
  if(inInput||anyOverlayOpen()||e.altKey)return;
  if((e.key==='z'||e.key==='Z')&&(e.ctrlKey||e.metaKey)&&!e.shiftKey){e.preventDefault();undoLast();return}
  if(e.ctrlKey||e.metaKey)return; // leave browser shortcuts (⌘N, ⌘R…) alone
  if(e.key==='Delete'&&selectedId){e.preventDefault();deletePersonById(selectedId);return}
  if(!singleKeyShortcuts||e.key.length!==1)return;
  const k=e.key.toLowerCase();
  if(k==='?'){document.getElementById('kbd-overlay').classList.remove('hidden');return}
  if(k==='/'){e.preventDefault();document.getElementById('search-box').focus();return}
  if(k==='n'){openEditModal(null);return}
  if(k==='e'&&selectedId){openEditModal(selectedId);return}
  if(k==='r'&&selectedId){openRelModal(selectedId);return}
  if(k==='x'){selectRandomPerson();return}
  if(k>='1'&&k<='9'){switchTab(TAB_IDS[+k-1]);return}
  if(k==='['||k===']'){const i=TAB_IDS.indexOf(currentTab);switchTab(TAB_IDS[(i+(k===']'?1:-1)+TAB_IDS.length)%TAB_IDS.length]);return}
});

// ── Tab bar: roving tabindex + arrow keys (WAI-ARIA tabs pattern) ──
function syncTabStops(){document.querySelectorAll('.tab-btn').forEach(b=>{b.tabIndex=b.classList.contains('active')?0:-1})}
document.getElementById('tab-bar').addEventListener('keydown',e=>{
  const tabs=[...document.querySelectorAll('.tab-btn')];const i=tabs.indexOf(document.activeElement);if(i<0)return;
  const n=e.key==='ArrowRight'?(i+1)%tabs.length:e.key==='ArrowLeft'?(i-1+tabs.length)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:null;
  if(n===null)return;e.preventDefault();tabs[n].focus();switchTab(tabs[n].dataset.tab);
});

// ── Person list: listbox with aria-activedescendant ──
function highlightListIdx(i){
  const list=document.getElementById('person-list');const filtered=getFilteredPersons();if(!filtered.length)return;
  listHighlightIdx=Math.max(0,Math.min(i,filtered.length-1));
  let el=list.querySelector(`.person-item[data-idx="${listHighlightIdx}"]`);
  if(!el&&filtered.length>200){list.scrollTop=listHighlightIdx*ITEM_H;renderSidebar();el=list.querySelector(`.person-item[data-idx="${listHighlightIdx}"]`)}
  list.querySelectorAll('.person-item.highlighted').forEach(x=>x.classList.remove('highlighted'));
  if(el){el.classList.add('highlighted');list.setAttribute('aria-activedescendant',el.id);el.scrollIntoView({block:'nearest'})}
}
function activateHighlighted(){
  const el=document.querySelector(`#person-list .person-item[data-idx="${listHighlightIdx}"]`);if(!el)return;
  if(batchMode)toggleBatchItem(el.dataset.id,!batchSelected.has(el.dataset.id));else selectPerson(el.dataset.id);
}
document.getElementById('person-list').addEventListener('focus',()=>{
  if(listHighlightIdx>=0)return;
  const idx=getFilteredPersons().findIndex(p=>p.id===selectedId);highlightListIdx(idx>=0?idx:0);
});
document.getElementById('person-list').addEventListener('keydown',e=>{
  const page=Math.max(1,Math.floor(e.currentTarget.clientHeight/ITEM_H)-1);
  const moves={ArrowDown:1,ArrowUp:-1,PageDown:page,PageUp:-page};
  if(e.key in moves){e.preventDefault();highlightListIdx(Math.max(listHighlightIdx,0)+moves[e.key])}
  else if(e.key==='Home'){e.preventDefault();highlightListIdx(0)}
  else if(e.key==='End'){e.preventDefault();highlightListIdx(Infinity)}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();activateHighlighted()}
});
document.getElementById('search-box').addEventListener('keydown',e=>{
  if(e.key==='ArrowDown'){e.preventDefault();listHighlightIdx=-1;document.getElementById('person-list').focus();highlightListIdx(0)}
  else if(e.key==='Enter'){const first=getFilteredPersons()[0];if(first){e.preventDefault();selectPerson(first.id);showToast(`👤 ${first.name}`)}}
});

// ── Random person ──
function selectRandomPerson(){
  const ids=Object.keys(persons);if(!ids.length)return;
  selectPerson(ids[Math.floor(Math.random()*ids.length)]);
  showToast('🎲 Random person selected');
}

// ── Batch Mode ──
function toggleBatchMode(){batchMode=!batchMode;batchSelected.clear();updateSidebar()}
function toggleBatchItem(id,checked){if(checked)batchSelected.add(id);else batchSelected.delete(id);const batchBar=document.getElementById('batch-bar');if(batchBar){const ct=document.getElementById('batch-count');if(ct)ct.textContent=batchSelected.size+' selected'};const row=document.querySelector(`.person-item[data-id="${id}"]`);if(row){row.setAttribute('aria-selected',checked);const el=row.querySelector('input[type=checkbox]');if(el)el.checked=checked}}
function batchMarkLiving(){if(!batchSelected.size)return;snapshotState();for(const id of batchSelected){const p=persons[id];if(p){p.living=true;delete p.death.confirmed}}updateSidebar();renderCurrentTab();scheduleSave();showToast(`Marked ${batchSelected.size} as living`)}
function batchMarkDeceased(){if(!batchSelected.size)return;snapshotState();for(const id of batchSelected){const p=persons[id];if(p){p.living=undefined;p.death.confirmed=true}}updateSidebar();renderCurrentTab();scheduleSave();showToast(`Marked ${batchSelected.size} as deceased`)}
function batchDelete(){
  if(!batchSelected.size)return;
  if(!confirm(`Delete ${batchSelected.size} people?\n\nYou can undo it straight away with Ctrl+Z (⌘Z).`))return;
  editDirty=false;
  snapshotState();
  for(const id of [...batchSelected]){
    const p=persons[id];if(!p)continue;
    for(const famId of p.fams){const fam=families[famId];if(!fam)continue;if(fam.husb===id)fam.husb=null;if(fam.wife===id)fam.wife=null;if(!fam.husb&&!fam.wife&&!fam.children.length)delete families[famId]}
    for(const famId of p.famc){const fam=families[famId];if(fam)fam.children=fam.children.filter(c=>c!==id)}
    delete persons[id];
  }
  if(selectedId&&!persons[selectedId]){selectedId=null;document.getElementById('btn-edit-person').style.display='none';document.getElementById('btn-relationship').style.display='none'}
  batchSelected.clear();batchMode=false;updateSidebar();renderCurrentTab();scheduleSave();showToast('Deleted selected people');
  closeModal('edit-modal');closeModal('person-modal');
}

// ── CSV Import ──
function parseCsvLine(line){
  const cells=[];let cur='',inQ=false;
  for(const ch of line){if(ch==='"')inQ=!inQ;else if(ch===','&&!inQ){cells.push(cur);cur=''}else cur+=ch}
  cells.push(cur);return cells.map(c=>c.replace(/^"|"$/g,'').trim());
}
function importCsvText(text){
  const lines=text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(lines.length<2){showToast('CSV needs a header row and at least one data row',3000);return}
  const headers=parseCsvLine(lines[0]).map(h=>h.toLowerCase().replace(/[^a-z0-9 ]/g,'').trim());
  function col(...keys){return headers.findIndex(h=>keys.some(k=>h===k||h.includes(k)))}
  const givenCol=col('given','first','firstname','given name','forename');
  const surCol=col('surname','last','lastname','family','family name','sur');
  const nickCol=col('nick','nickname','known as','alias');
  const sexCol=col('sex','gender');
  const bdCol=col('birth date','born','dob','birth d','birthdate');
  const bpCol=col('birth place','birthplace','place of birth');
  const ddCol=col('death date','died','dod','death d','deathdate');
  const dpCol=col('death place','deathplace','place of death');
  const noteCol=col('note','notes','memo');
  let added=0;
  snapshotState();
  for(let i=1;i<lines.length;i++){
    const cells=parseCsvLine(lines[i]);
    const get=c=>c>=0?cells[c]?.trim()||'':'';
    const given=get(givenCol),sur=get(surCol);
    if(!given&&!sur)continue;
    const fullName=[given,sur].filter(Boolean).join(' ')||'Unknown';
    const id=newPersonId();
    const rawSex=get(sexCol).toUpperCase();
    const sex=rawSex==='M'||rawSex==='MALE'?'M':rawSex==='F'||rawSex==='FEMALE'?'F':'U';
    const bd=get(bdCol),bp=get(bpCol),dd=get(ddCol),dp=get(dpCol);
    persons[id]={
      id,name:fullName,nameGiven:given,nameSur:sur,
      nickname:get(nickCol)||undefined,sex,
      birth:bd||bp?{date:bd,plac:bp}:{},
      death:dd||dp?{date:dd,plac:dp}:{},
      events:[],notes:get(noteCol)?[get(noteCol)]:[],
      fams:[],famc:[],sources:[],images:[],tasks:[],residences:[],
    };
    added++;
  }
  if(added){updateSidebar();renderCurrentTab();scheduleSave();showToast(`Imported ${added} people from CSV`)}
  else showToast('No valid rows found — check column headers match: Given, Surname, Sex, Birth Date, Birth Place, Death Date, Death Place',5000);
}
function handleCsvFile(input){
  const file=input.files[0];if(!file)return;input.value='';
  const reader=new FileReader();reader.onload=e=>importCsvText(e.target.result);reader.readAsText(file);
}

// ── Family Group Sheet ──
function openFamilySheet(id){
  const p=persons[id];if(!p)return;
  const spouseList=getSpouses(id);
  const parents=getParents(id);
  const sibs=getSiblings(id);
  const e=v=>String(v||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const dn=person=>e(displayName(person));
  const sexStr=x=>x==='M'?'Male':x==='F'?'Female':'—';
  const sexAbbr=x=>x==='M'?'M':x==='F'?'F':'?';

  let html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Family Group Sheet — ${e(p.name)}</title><style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Georgia,serif;font-size:11pt;color:#111;padding:1.5cm 2cm;max-width:22cm;margin:0 auto}
    h1{font-size:15pt;margin-bottom:4pt;border-bottom:2pt solid #333;padding-bottom:4pt}
    h2{font-size:12pt;margin:18pt 0 6pt;border-bottom:1pt solid #aaa;padding-bottom:3pt;color:#333}
    h3{font-size:11pt;margin:14pt 0 5pt;color:#555;font-style:italic}
    .row{display:flex;gap:8pt;margin:3pt 0;font-size:10.5pt}
    .lbl{font-weight:bold;min-width:110pt;color:#555;flex-shrink:0}
    table{width:100%;border-collapse:collapse;margin-top:8pt;font-size:10pt}
    th{background:#eee;font-weight:bold;text-align:left;padding:4pt 6pt;border:1pt solid #bbb}
    td{padding:4pt 6pt;border:1pt solid #ccc;vertical-align:top}
    tr:nth-child(even) td{background:#fafafa}
    .rel-lbl{font-size:9pt;color:#777;font-style:italic}
    .print-btn{position:fixed;top:12pt;right:12pt;padding:6pt 14pt;background:#333;color:#fff;border:none;border-radius:4pt;cursor:pointer;font-size:10pt;font-family:sans-serif}
    .footer{margin-top:24pt;font-size:8.5pt;color:#999;border-top:1pt solid #ddd;padding-top:6pt}
    @media print{.print-btn{display:none}}
  </style></head><body>
  <!-- Blob documents inherit this app's CSP (no inline scripts), so the
       print button is wired up by a same-origin external script. -->
  <script src="${location.origin}${location.pathname.replace(/[^/]*$/,'')}sheet.js" defer><\/script>
  <button class="print-btn" id="sheet-print-btn">🖨 Print</button>
  <h1>Family Group Sheet</h1>
  <h2>${dn(p)}</h2>`;

  // ── Personal details ──────────────────────────────────────────────────────
  html+=`<div class="row"><span class="lbl">Sex:</span><span>${sexStr(p.sex)}</span></div>`;
  if(p.nickname)html+=`<div class="row"><span class="lbl">Known as:</span><span>${e(p.nickname)}</span></div>`;
  if(p.birth.date||p.birth.plac)html+=`<div class="row"><span class="lbl">Birth:</span><span>${e([p.birth.date,p.birth.plac].filter(Boolean).join(' — '))}</span></div>`;
  if(p.death.date||p.death.plac)html+=`<div class="row"><span class="lbl">Death:</span><span>${e([p.death.date,p.death.plac].filter(Boolean).join(' — '))}</span></div>`;
  else if(p.death.confirmed)html+=`<div class="row"><span class="lbl">Death:</span><span style="font-style:italic;color:#777">† Deceased — date and place unknown</span></div>`;
  for(const ev of p.events){const lbl=EVT_LABEL[ev._tag]||ev._tag;const parts=[ev.val,ev.date,ev.plac].filter(Boolean);if(parts.length)html+=`<div class="row"><span class="lbl">${e(lbl)}:</span><span>${e(parts.join(' — '))}</span></div>`}
  for(const n of p.notes)html+=`<div class="row"><span class="lbl">Note:</span><span style="white-space:pre-wrap">${e(n)}</span></div>`;

  // ── Siblings ──────────────────────────────────────────────────────────────
  if(sibs.length){
    html+=`<h2>Siblings (${sibs.length})</h2>`;
    html+=`<table><thead><tr><th>#</th><th>Name</th><th>Sex</th><th>Born</th><th>Birth Place</th><th>Died</th><th>Death Place</th></tr></thead><tbody>`;
    sibs.forEach((s,i)=>html+=`<tr><td>${i+1}</td><td>${dn(s)}</td><td>${sexAbbr(s.sex)}</td><td>${e(s.birth.date||'')}</td><td>${e(s.birth.plac||'')}</td><td>${e(s.death.date||'')}</td><td>${e(s.death.plac||'')}</td></tr>`);
    html+=`</tbody></table>`;
  }

  // ── Ancestors ─────────────────────────────────────────────────────────────
  // Collect up to 4 generations. Each entry: {person, relationship_label}
  // Track by Ahnentafel-style position using a queue of {pid, prefix, genWord}
  const ancestorRows=[];
  const seen=new Set([id]);
  // Queue entries: {pid, prefix:'Paternal'|'Maternal'|'', gen:1..4}
  // gen 1 = parents, gen 2 = grandparents, gen 3 = great-grandparents, gen 4 = gg-grandparents
  function collectAnc(queue,gen){
    if(gen>4||!queue.length)return;
    const nextQueue=[];
    for(const{pid,prefix}of queue){
      const pars=getParents(pid);
      pars.forEach(par=>{
        if(seen.has(par.id))return;seen.add(par.id);
        const isMale=par.sex==='M',isFemale=par.sex==='F';
        const sex=isMale?'father':isFemale?'mother':'parent';
        let lbl;
        if(gen===1){
          lbl=isMale?'Father':isFemale?'Mother':'Parent';
        }else{
          const gWord=gen===2?'Grand':('Great-').repeat(gen-2)+'Grand';
          const linePrefix=prefix?prefix+' ':'';
          lbl=`${linePrefix}${gWord}${sex}`;
          lbl=lbl.charAt(0).toUpperCase()+lbl.slice(1);
        }
        ancestorRows.push({person:par,lbl,gen});
        // Determine side for the next level
        const nextPrefix=gen===1?(isMale||!isFemale?'Paternal':'Maternal'):prefix;
        nextQueue.push({pid:par.id,prefix:nextPrefix});
      });
    }
    collectAnc(nextQueue,gen+1);
  }
  collectAnc([{pid:id,prefix:''}],1);

  if(ancestorRows.length){
    html+=`<h2>Ancestors</h2>`;
    html+=`<table><thead><tr><th>Relationship</th><th>Name</th><th>Sex</th><th>Born</th><th>Birth Place</th><th>Died</th><th>Death Place</th></tr></thead><tbody>`;
    ancestorRows.forEach(({person:a,lbl})=>html+=`<tr><td class="rel-lbl">${e(lbl)}</td><td>${dn(a)}</td><td>${sexAbbr(a.sex)}</td><td>${e(a.birth.date||'')}</td><td>${e(a.birth.plac||'')}</td><td>${e(a.death.date||'')}</td><td>${e(a.death.plac||'')}</td></tr>`);
    html+=`</tbody></table>`;
  }

  // ── Families (spouses + children) ─────────────────────────────────────────
  if(spouseList.length){
    spouseList.forEach(({person:sp,fam})=>{
      html+=`<h2>Family with ${dn(sp)}</h2>`;
      if(sp.nickname)html+=`<div class="row"><span class="lbl">Spouse known as:</span><span>${e(sp.nickname)}</span></div>`;
      if(sp.birth.date||sp.birth.plac)html+=`<div class="row"><span class="lbl">Spouse birth:</span><span>${e([sp.birth.date,sp.birth.plac].filter(Boolean).join(' — '))}</span></div>`;
      if(sp.death.date||sp.death.plac)html+=`<div class="row"><span class="lbl">Spouse death:</span><span>${e([sp.death.date,sp.death.plac].filter(Boolean).join(' — '))}</span></div>`;
      else if(sp.death.confirmed)html+=`<div class="row"><span class="lbl">Spouse death:</span><span style="font-style:italic;color:#777">† Deceased — date and place unknown</span></div>`;
      if(fam.marr.date||fam.marr.plac){const marrY=extractYear(fam.marr.date);const pBY=extractYear(p.birth.date);const ageAtMarr=(marrY&&pBY&&marrY>=pBY)?` (age ${marrY-pBY} at marriage)`:'';html+=`<div class="row"><span class="lbl">Married:</span><span>${e([fam.marr.date,fam.marr.plac].filter(Boolean).join(' — '))}${ageAtMarr}</span></div>`}
      const ch=fam.children.map(c=>persons[c]).filter(Boolean);
      if(ch.length){
        html+=`<table><thead><tr><th>#</th><th>Name</th><th>Sex</th><th>Born</th><th>Birth Place</th><th>Died</th><th>Death Place</th></tr></thead><tbody>`;
        ch.forEach((c,i)=>html+=`<tr><td>${i+1}</td><td>${dn(c)}</td><td>${sexAbbr(c.sex)}</td><td>${e(c.birth.date||'')}</td><td>${e(c.birth.plac||'')}</td><td>${e(c.death.date||'')}</td><td>${e(c.death.plac||'')}</td></tr>`);
        html+=`</tbody></table>`;
      }else html+=`<p style="color:#777;font-style:italic;margin-top:6pt">No children recorded.</p>`;
    });
  }else{
    const solo=getChildren(id);
    if(solo.length){
      html+=`<h2>Children</h2><table><thead><tr><th>#</th><th>Name</th><th>Sex</th><th>Born</th><th>Birth Place</th><th>Died</th><th>Death Place</th></tr></thead><tbody>`;
      solo.forEach((c,i)=>html+=`<tr><td>${i+1}</td><td>${dn(c)}</td><td>${sexAbbr(c.sex)}</td><td>${e(c.birth.date||'')}</td><td>${e(c.birth.plac||'')}</td><td>${e(c.death.date||'')}</td><td>${e(c.death.plac||'')}</td></tr>`);
      html+=`</tbody></table>`;
    }
  }

  html+=`<div class="footer">Generated ${new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'})} · Family Tree App</div></body></html>`;
  // Use a Blob URL instead of document.write() — avoids the deprecated API and
  // prevents the opened window from having a reference back to our opener.
  const blob=new Blob([html],{type:'text/html;charset=utf-8'});
  const url=URL.createObjectURL(blob);
  const w=window.open(url,'_blank','width=960,height=800,scrollbars=yes');
  if(w)w.opener=null;else showToast('Popup blocked — please allow pop-ups for this site',4000);
  // Revoke after a generous delay so the page has time to fully load
  setTimeout(()=>URL.revokeObjectURL(url),120000);
}

// ── Narrative Biography ──
function generateNarrative(id){
  const p=persons[id];if(!p)return'';
  const he=p.sex==='M'?'He':p.sex==='F'?'She':'They';
  const his=p.sex==='M'?'his':p.sex==='F'?'her':'their';
  const him=p.sex==='M'?'him':p.sex==='F'?'her':'them';
  const parts=[];
  // Sentence 1: birth
  let s1=`${p.name}`;
  if(p.birth.date||p.birth.plac){s1+=' was born';if(p.birth.date)s1+=` on ${p.birth.date}`;if(p.birth.plac)s1+=` in ${p.birth.plac}`;s1+='.'}
  else{s1+='\'s birth details are not recorded.'}
  parts.push(s1);
  // Sentence 2: parents
  const parents=getParents(id);
  if(parents.length){const pnames=parents.map(q=>q.name).join(' and ');parts.push(`${he} was the child of ${pnames}.`)}
  // Sentence 3: siblings
  const sibs=getSiblings(id);
  if(sibs.length){parts.push(`${he} had ${sibs.length} sibling${sibs.length>1?'s':''}: ${sibs.map(s=>s.name).join(', ')}.`)}
  // Sentence 4: occupation
  const occ=p.events.find(e=>e._tag==='OCCU');
  if(occ){parts.push(`${he} worked as ${occ.val||'an occupation not specified'}${occ.date?' ('+occ.date+')':''}.`)}
  // Sentence 5: spouses and children
  const spouses=getSpouses(id);
  if(spouses.length){
    for(const{person:sp,fam}of spouses){
      let ms=`${he} married ${sp.name}`;if(fam.marr.date)ms+=` on ${fam.marr.date}`;if(fam.marr.plac)ms+=` in ${fam.marr.plac}`;ms+='.';parts.push(ms);
    }
    const children=getChildren(id);
    if(children.length){parts.push(`Together they had ${children.length} child${children.length>1?'ren':''}: ${children.map(c=>c.name).join(', ')}.`)}
  }
  // Sentence 6: death
  if(p.death.date||p.death.plac||p.death.confirmed){
    let ds=`${p.name} died`;if(p.death.date)ds+=` on ${p.death.date}`;if(p.death.plac)ds+=` in ${p.death.plac}`;if(p.death.caus)ds+=`, cause of death: ${p.death.caus}`;ds+='.';
    const by=extractYear(p.birth.date),dy=extractYear(p.death.date);
    if(by&&dy)ds+=` ${he} was ${dy-by} years old.`;
    parts.push(ds);
  }else if(!p.living){parts.push(`No death date has been recorded for ${p.name}.`)}
  return parts.join(' ');
}
function showNarrativeModal(id){
  const text=generateNarrative(id);
  document.getElementById('narrative-content').textContent=text;
  document.getElementById('narrative-modal').classList.remove('hidden');
}

// ── Family Unit View ──
function renderFamView(){
  const el=document.getElementById('tab-fam-view');
  if(!selectedId){el.innerHTML=`<div class="empty-state"><div class="empty-state-icon">👨‍👩‍👧</div><p>Select a person from the list to see their family view.</p></div>`;return}
  const p=persons[selectedId];if(!p)return;
  let h='';
  // Family of origin
  const parents=getParents(selectedId);
  const sibs=getSiblings(selectedId);
  if(parents.length||sibs.length){
    h+=`<div class="lt-section"><h2 class="lt-section-title">Family of origin</h2><div class="lt-card">`;
    if(parents.length){h+=`<div style="font-size:11px;color:#7060a0;margin-bottom:4px">Parents</div>`;for(const par of parents)h+=personRow(par);}
    if(sibs.length){h+=`<div style="font-size:11px;color:#7060a0;margin:6px 0 4px">Siblings</div>`;for(const s of sibs)h+=personRow(s);}
    h+=`</div></div>`;
  }
  // Own families
  const spouses=getSpouses(selectedId);
  if(spouses.length){
    h+=`<div class="lt-section"><h2 class="lt-section-title">Own families</h2>`;
    for(const{person:sp,fam}of spouses){
      h+=`<div class="lt-card">`;
      h+=`<div style="font-size:11px;color:#7060a0;margin-bottom:4px">Spouse</div>`;
      h+=personRow(sp);
      if(fam.marr.date||fam.marr.plac){
        h+=`<div class="lt-card-sub" style="margin-top:4px">`;
        if(fam.marr.date)h+=`Married ${esc(fam.marr.date)} `;
        if(fam.marr.plac)h+=`— ${esc(fam.marr.plac)}`;
        const by=extractYear(p.birth.date),my=extractYear(fam.marr.date);
        if(by&&my&&my>=by)h+=` (age ${my-by})`;
        h+=`</div>`;
      }
      const children=fam.children.map(c=>persons[c]).filter(Boolean);
      if(children.length){
        h+=`<div style="font-size:11px;color:#7060a0;margin:6px 0 4px">Children</div>`;
        for(const c of children)h+=personRow(c);
      }
      h+=`</div>`;
    }
    h+=`</div>`;
  }else{
    // Solo children (no recorded spouse)
    const soloChildren=getChildren(selectedId);
    if(soloChildren.length){
      h+=`<div class="lt-section"><h2 class="lt-section-title">Children</h2><div class="lt-card">`;
      for(const c of soloChildren)h+=personRow(c);
      h+=`</div></div>`;
    }
  }
  if(!h)h=`<div class="empty-state"><div class="empty-state-icon">👨‍👩‍👧</div><p>No family relations recorded for ${esc(p.name)}.</p></div>`;
  el.innerHTML=h;
}

// ── Event delegation ──
// Every generated element carries data-act instead of an inline onclick, so
// the CSP can exclude 'unsafe-inline' for scripts. One document-level listener
// dispatches all actions; the innermost [data-act] wins, which replaces the
// old event.stopPropagation() patterns.
function runAction(el){
  const d=el.dataset,id=d.id,idx=+d.idx;
  if(d.close&&closeModal(d.close)===false)return; // user chose to keep editing
  if(/^(rm-|add-|clear-)/.test(d.act))editDirty=true;
  switch(d.act){
    case'menu':{const open=document.getElementById('more-menu').hidden;if(open)openMenu(false);else closeMenu(true);break}
    case'select':selectPerson(id);break;
    case'info':showPersonModal(id);break;
    case'edit':openEditModal(id||null);break;
    case'new-person':openEditModal(null);break;
    case'edit-selected':if(selectedId)openEditModal(selectedId);break;
    case'rel-selected':if(selectedId)openRelModal(selectedId);break;
    case'rel':openRelModal(id);break;
    case'copy-person':copyPersonSummary(id);break;
    case'sheet':openFamilySheet(id);break;
    case'bio':showNarrativeModal(id);break;
    case'del-person':deletePersonById(id);break;
    case'del-person-confirm':deletePersonConfirm();break;
    case'compute-rel':computeRel(id);break;
    case'close':break; // data-close above did the work
    case'home':showHomeScreen();break;
    case'export-ged':exportGedcomFile();break;
    case'export-svg':exportSvg();break;
    case'export-png':exportPng();break;
    case'print':exportPrint();break;
    case'guide':openGuide();break;
    case'logout':saveNow().finally(()=>logout());break;
    case'dup':openDupModal();break;
    case'random':selectRandomPerson();break;
    case'kbd':document.getElementById('kbd-overlay').classList.remove('hidden');break;
    case'merge-file':document.getElementById('merge-file-input').click();break;
    case'csv-file':document.getElementById('csv-file-input').click();break;
    case'import-file':document.getElementById('file-input').click();break;
    case'new-tree':createNewTree();break;
    case'load-tree':loadTreeById(+d.tid);break;
    case'rename-tree':renameTree(+d.tid,d.name);break;
    case'delete-tree':deleteTree(+d.tid);break;
    case'submit-login':submitLogin();break;
    case'batch-mode':toggleBatchMode();break;
    case'batch-living':batchMarkLiving();break;
    case'batch-deceased':batchMarkDeceased();break;
    case'batch-delete':batchDelete();break;
    case'batch-cb':toggleBatchItem(id,el.checked);break;
    case'person-row':if(batchMode)toggleBatchItem(id,!batchSelected.has(id));else selectPerson(id);break;
    case'place':showPlaceModal(d.name);break;
    case'alpha':setAlpha(d.letter||'');break;
    case'surname-group':toggleSurnameGroup(d.gid);break;
    case'merge-keep':mergePeople(d.keep,d.remove);break;
    case'rm-row':{const r=el.closest('.event-row');if(r)r.remove();break}
    case'rm-spouse':removeEditSpouse(idx);break;
    case'rm-child':removeEditChild(id);break;
    case'rm-sib':removeEditSibling(id);break;
    case'rm-photo':removeEditPhoto(idx);break;
    case'rm-source':removeEditSource(idx);break;
    case'rm-task':removeEditTask(idx);break;
    case'rm-resi':removeEditResi(idx);break;
    case'add-event':addEditEvent();break;
    case'add-resi':addEditResi();break;
    case'add-photo':addEditPhoto();break;
    case'add-source':addEditSource();break;
    case'add-task':addEditTask();break;
    case'clear-father':clearEditFather();break;
    case'clear-mother':clearEditMother();break;
    case'save-person':savePersonEdit();break;
    case'scroll-guide':scrollGuide(d.target);break;
    case'copy-narrative':navigator.clipboard.writeText(document.getElementById('narrative-content').textContent).then(()=>showToast('Copied!')).catch(()=>{});break;
  }
}
document.addEventListener('click',e=>{
  const el=e.target.closest('[data-act]');
  if(!el)return;
  if(el.tagName==='A')e.preventDefault();
  if(el.closest('#more-menu'))closeMenu(true); // focus returns to the menu button, so dialogs opened from here hand it back
  runAction(el);
});
// Keyboard activation for non-native controls (role="button"/"link" divs,
// SVG chart nodes). Native buttons/links/inputs handle Enter themselves.
document.addEventListener('keydown',e=>{
  if(e.key!=='Enter'&&e.key!==' ')return;
  const el=e.target&&e.target.closest?e.target.closest('[data-act]'):null;
  if(!el)return;
  const t=el.tagName.toUpperCase();
  if(t==='BUTTON'||t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||(t==='A'&&el.href))return;
  e.preventDefault();runAction(el);
});
// Delegated inputs for the edit-modal working arrays (spouses/photos/…)
document.addEventListener('input',e=>{
  const el=e.target,f=el.dataset.field;if(!f)return;const i=+el.dataset.idx;
  switch(f){
    case'sp-marr-date':editSpouses[i].marrDate=el.value;break;
    case'sp-marr-place':editSpouses[i].marrPlace=el.value;break;
    case'sp-div-date':editSpouses[i].divDate=el.value;break;
    case'sp-div-place':editSpouses[i].divPlace=el.value;break;
    case'photo-url':{editPhotos[i].url=el.value;const img=el.previousElementSibling;if(img&&img.tagName==='IMG'){img.style.display='';img.src=el.value}break}
    case'source-title':editSources[i].title=el.value;break;
    case'task-text':editTasks[i].text=el.value;break;
    case'resi-place':editResi[i].place=el.value;break;
    case'resi-from':editResi[i].from=el.value;break;
    case'resi-to':editResi[i].to=el.value;break;
  }
});
document.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.chk==='task-done'){editTasks[+el.dataset.idx].done=el.checked;renderEditTasks()}
});
// Static controls that previously used inline attributes
document.getElementById('login-password').addEventListener('keydown',e=>{if(e.key==='Enter')submitLogin()});
document.getElementById('csv-file-input').addEventListener('change',function(){handleCsvFile(this)});
{
  const liv=document.getElementById('ef-living'),dec=document.getElementById('ef-death-confirmed');
  liv.addEventListener('change',()=>{if(liv.checked)dec.checked=false});
  dec.addEventListener('change',()=>{if(dec.checked)liv.checked=false});
}

// ── Init ──
(async function init(){
  if(!authToken){showLogin();return}
  // Probe the token. On 401, apiFetch() calls logout() which clears authToken.
  // On a network error it returns null but leaves authToken intact — don't log
  // the user out just because the connection was slow on load.
  const loc=readLocation();
  if(loc.tree)document.getElementById('home-screen').style.display='none'; // don't flash the tree list on reload
  await apiGetTrees();
  if(!authToken){showLogin();return} // token was rejected (401)
  if(loc.tree&&await loadTreeById(loc.tree,loc,true))return;
  history.replaceState(null,'',location.pathname+location.search);
  await renderHomeScreen();
})();
