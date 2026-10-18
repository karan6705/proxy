// The stage page: a dark, full-window view meant to be screen-recorded.
//   Under the title  a progress line: Mistake detected, Human alerted, Human replied, Negotiating, Refunds confirmed, Rebooked
//   Left   "The mistake"    the task, then what the agent booked (wrong dates in red), then what it rebooked (green)
//   Middle "Proxy"          the human's phone (the alert and the reply), the money recovered, and each refund as Stripe confirms it
//   Right  "Agent to agent" one thread per merchant, in order from the first message, with Stripe receipts inside their thread
// It polls GET /demo/feed?task_id=... every second. ?fixture=1 plays a built-in story (/web/stage-fixture; add &long=1 for a
// long run, &step=N to freeze a frame); ?feed=<url> points it at any other feed; ?task_id=<id> picks the run.
// Each column scrolls on its own, follows the newest entry unless the viewer scrolls up, and offers a "New" pill instead.
// Everything from the feed is written with textContent, never innerHTML.
export const STAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy stage</title>
<style>
:root{
  --ground:#0b0f16;--panel:#121823;--raised:#19212f;--line:#263247;
  --ink:#f2f5fa;--soft:#c3ccda;--mute:#97a3b6;
  --mistake:#ff6b61;--mistake-bg:#2f1519;--saved:#3fddae;--saved-bg:#0e3329;--amber:#ffc65c;--indigo:#9fb0ff;--teal:#5fe0d2;--phone:#232a38;--blue:#0a6cf0;
  --serif:"New York","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --sans:ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box;margin:0}
html{background:var(--ground);color:var(--ink);font-family:var(--sans);
  /* 1rem tracks the window: about 17px at 1920x1080, 13px at 1440x900, never below 12px */
  font-size:clamp(12px,min(100vw/110,100vh/63.5),22px)}
body{background:var(--ground);height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr);overflow:hidden}
button{font:inherit;color:inherit}

/* title and progress line */
header{padding:.65rem 1.6rem .45rem}
.top{display:flex;align-items:baseline;gap:1rem}
.top h1{font-family:var(--serif);font-size:1.7rem;font-weight:700;letter-spacing:-.01em}
.top .tag{color:var(--mute);font-size:1.05rem}
#status{margin-left:auto;color:var(--mute);font-size:1rem}
#status.live::before{content:"";display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:var(--saved);margin-right:.55rem;animation:pulse 1.8s infinite}
#story{list-style:none;display:grid;grid-template-columns:repeat(6,1fr);margin-top:.5rem}
#story li{position:relative;padding-top:1.1rem;font-size:1rem;color:var(--mute);text-align:left}
#story li::before{content:"";position:absolute;top:.3rem;left:0;right:0;height:.18rem;background:var(--line)}
#story li::after{content:"";position:absolute;top:.05rem;left:0;width:.7rem;height:.7rem;border-radius:50%;background:var(--ground);border:.16rem solid var(--line)}
#story li.done{color:var(--soft)}
#story li.done::before{background:var(--saved)}
#story li.done::after{background:var(--saved);border-color:var(--saved)}
#story li.now{color:var(--ink);font-weight:700}
#story li.now::before{background:linear-gradient(90deg,var(--saved),var(--line))}
#story li.now::after{background:var(--ink);border-color:var(--ink);box-shadow:0 0 0 .3rem rgba(242,245,250,.18)}
#story li.all::before{background:var(--saved)}

/* columns */
main{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1fr) minmax(0,1.28fr);gap:1.1rem;padding:0 1.6rem 1.1rem;min-height:0}
.col{position:relative;display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--panel);border:.08rem solid var(--line);border-radius:1rem;overflow:hidden}
.head{flex:none;display:flex;align-items:baseline;justify-content:space-between;gap:1rem;padding:.65rem 1.2rem .55rem;border-bottom:.08rem solid var(--line);background:var(--panel);position:relative;z-index:2}
.head h2{font-family:var(--serif);font-size:1.45rem;font-weight:700;letter-spacing:-.005em}
.head .sub{color:var(--mute);font-size:1rem;font-variant-numeric:tabular-nums}
.pin{flex:none;padding:.85rem 1.2rem .25rem}
.body{flex:1;min-height:0;overflow-y:auto;padding:.8rem 1.2rem .8rem;--ft:0rem;--fb:0rem;
  -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 var(--ft),#000 calc(100% - var(--fb)),transparent 100%);
  mask-image:linear-gradient(to bottom,transparent 0,#000 var(--ft),#000 calc(100% - var(--fb)),transparent 100%);
  scrollbar-width:thin;scrollbar-color:var(--line) transparent}
.body.cut-top{--ft:1.7rem}.body.cut-bottom{--fb:1.7rem}
.pill{position:absolute;left:50%;bottom:1rem;transform:translateX(-50%);display:none;padding:.35rem .95rem;border:0;border-radius:2rem;background:var(--ink);color:var(--ground);font-weight:700;font-size:.95rem;cursor:pointer;z-index:3;box-shadow:0 .3rem 1rem rgba(0,0,0,.5)}
.pill.on{display:block}
.empty{color:var(--mute);font-size:1.05rem;padding:.3rem 0}
.enter{animation:in .45s ease-out both}
@keyframes in{from{opacity:0;transform:translateY(.7rem)}to{opacity:1;transform:none}}
@keyframes pop{0%{transform:scale(.5)}100%{transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* left: the mistake */
.goal{font-family:var(--serif);font-size:1.4rem;font-weight:700;line-height:1.2}
.asked{color:var(--soft);font-size:1.02rem;margin:.3rem 0 .9rem}
.asked strong{color:var(--saved);font-weight:700}
.grp{margin-top:.9rem}
.grp h3{display:flex;justify-content:space-between;align-items:baseline;font-family:var(--serif);font-size:1.12rem;font-weight:700;margin-bottom:.55rem}
.grp h3 small{font-family:var(--sans);font-weight:400;color:var(--mute);font-size:.92rem}
.grp.bad h3{color:var(--mistake)}.grp.good h3{color:var(--saved)}
.list{display:flex;flex-direction:column;gap:.5rem}
.card{display:grid;grid-template-columns:1.9rem 1fr auto;column-gap:.8rem;align-items:center;padding:.6rem .85rem;border-radius:.75rem;background:var(--raised);border:.08rem solid var(--line)}
.card .ic{font-size:1.5rem;text-align:center}
.card .t{font-size:1.08rem;font-weight:650;line-height:1.2}
.card .when{font-size:.98rem;margin-top:.12rem;font-weight:650}
.card .when i{font-style:normal;color:var(--mute);font-weight:500;margin-left:.45rem}
.card .a{font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums}
.bad .card{background:var(--mistake-bg);border-color:#6b2a31}
.bad .card .when{color:var(--mistake)}
.good .card{background:var(--saved-bg);border-color:#1f6b54}
.good .card .when{color:var(--saved)}

/* middle: the human's phone, then the money */
.phone{display:flex;flex-direction:column;gap:.5rem}
.note{background:var(--phone);border-radius:1.1rem;padding:.65rem .9rem .75rem}
.note .who{display:flex;align-items:center;gap:.55rem;margin-bottom:.3rem;font-size:.95rem;color:var(--soft)}
.note .who b{color:var(--ink);font-weight:650}
.note .who span:last-child{margin-left:auto;color:var(--mute);font-variant-numeric:tabular-nums}
.ico{width:1.5rem;height:1.5rem;border-radius:.4rem;display:grid;place-items:center;font-family:var(--serif);font-weight:700;font-size:.95rem;color:#0b0f16;background:var(--indigo)}
.note p{font-size:1rem;line-height:1.28;white-space:pre-line}
.note p+p{margin-top:.4rem}
.reply{align-self:flex-end;max-width:92%;text-align:right}
.latest{color:var(--soft);font-size:.95rem;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;padding:0 .2rem}
.latest b{color:var(--ink);font-weight:650}
.reply .rb{display:inline-block;white-space:nowrap;background:var(--blue);color:#fff;font-weight:700;font-size:1.2rem;padding:.35rem 1rem;border-radius:1.2rem;border-bottom-right-radius:.35rem}
.reply small{display:block;color:var(--mute);font-size:.85rem;margin-top:.15rem;font-variant-numeric:tabular-nums}
.nophone{color:var(--mute);font-size:1.02rem;padding:.2rem 0 .5rem}
.money{margin:.2rem 0 .8rem}
.money .lab{color:var(--soft);font-size:1.02rem}
.num{font-family:var(--serif);font-size:3.9rem;font-weight:700;line-height:1.02;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.num small{font-size:1.9rem;font-weight:400;color:var(--mute);margin-left:.5rem;letter-spacing:0}
.bar{height:.6rem;border-radius:1rem;background:var(--raised);margin:.6rem 0 .45rem;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--saved);border-radius:1rem;transition:width .9s ease-out}
.meta{display:flex;justify-content:space-between;color:var(--soft);font-size:1rem}
.meta b{color:var(--ink);font-variant-numeric:tabular-nums}
.row{display:grid;grid-template-columns:1.8rem 1fr auto;column-gap:.8rem;align-items:center;padding:.55rem .85rem;border-radius:.75rem;background:var(--raised);border:.08rem solid var(--line);transition:background .5s,border-color .5s}
.row .dot{width:1.7rem;height:1.7rem;border-radius:50%;border:.14rem solid var(--mute);display:grid;place-items:center;font-size:1rem;font-weight:900;color:transparent}
.row .l{font-size:1.08rem;font-weight:650}
.row .s{font-size:.9rem;color:var(--mute);margin-top:.05rem}
.row .a{font-size:1.15rem;font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.row.work .dot{border-color:var(--amber);animation:pulse 1.4s infinite}
.row.ok{background:var(--saved-bg);border-color:#1f6b54}
.row.ok .dot{background:var(--saved);border-color:var(--saved);color:#04170f;animation:pop .45s ease-out}
.row.ok .s{color:var(--saved)}
.rows{display:flex;flex-direction:column;gap:.5rem}

/* right: agent to agent */
.thread{margin-bottom:.55rem}
.thead{display:flex;align-items:center;gap:.6rem;padding-bottom:.35rem;margin-bottom:.45rem;border-bottom:.08rem solid var(--line);font-size:1rem;font-weight:650}
.thead .av{width:1.6rem;height:1.6rem;font-size:.85rem}
.thead span{color:var(--soft)}
.msgs{display:flex;flex-direction:column;gap:.35rem}
.chat{display:flex;gap:.5rem;align-items:flex-end}
.chat.r{flex-direction:row-reverse}
.av{width:1.9rem;height:1.9rem;flex:none;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:.95rem;color:#0b0f16}
.bub{max-width:calc(100% - 3.2rem);padding:.35rem .75rem .4rem;border-radius:.95rem;font-size:.98rem;line-height:1.26;background:var(--raised);border:.08rem solid var(--line)}
.bub .n{font-size:.84rem;font-weight:700;margin-bottom:.05rem}
.bub .n em{font-style:normal;font-weight:500;color:var(--mute);margin-left:.45rem}
.chat.proxy .bub{border-bottom-left-radius:.3rem}.chat.r .bub{border-bottom-right-radius:.3rem}
.sys{align-self:center;padding:.4rem 1.1rem;border-radius:2rem;background:var(--saved-bg);border:.08rem solid #1f6b54;color:var(--saved);font-size:1rem;font-weight:700}

@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
@media (max-width:1099px){
  html{font-size:clamp(13px,2.3vw,17px)}
  body{height:auto;display:block;overflow:auto}
  #story{grid-template-columns:repeat(3,1fr);row-gap:.4rem}
  main{grid-template-columns:1fr;padding-bottom:1.5rem}
  .col{max-height:85vh}
}
</style>
</head>
<body>
<header>
  <div class="top"><h1>Proxy</h1><span class="tag">the undo layer for AI agents</span><span id="status">Connecting to the demo feed...</span></div>
  <ol id="story"></ol>
</header>
<main>
  <section class="col" id="colA">
    <div class="head"><h2>The mistake</h2><span class="sub" id="subA"></span></div>
    <div class="body" id="bodyA">
      <div class="goal" id="goal"></div>
      <div class="asked" id="asked"></div>
      <div class="grp bad" id="grpBad"><h3><span>Booked by the agent</span><small id="cntBad"></small></h3><div class="list" id="listBad"></div></div>
      <div class="grp good" id="grpGood" hidden><h3><span id="goodTitle">Rebooked</span><small id="cntGood"></small></h3><div class="list" id="listGood"></div></div>
    </div>
    <button class="pill" id="pillA" type="button">New &#8595;</button>
  </section>
  <section class="col" id="colB">
    <div class="head"><h2>Proxy</h2><span class="sub" id="subB"></span></div>
    <div class="pin"><div class="phone" id="phone"></div></div>
    <div class="body" id="bodyB">
      <div class="money"><div class="lab">Recovered</div><div class="num" id="rec">$0<small id="of"></small></div>
        <div class="bar"><i id="barfill"></i></div><div class="meta"><span id="state"></span><span id="clock"></span></div></div>
      <div class="rows" id="rows"></div>
    </div>
    <button class="pill" id="pillB" type="button">New &#8595;</button>
  </section>
  <section class="col" id="colC">
    <div class="head"><h2>Agent to agent</h2><span class="sub" id="subC"></span></div>
    <div class="body" id="bodyC"><div class="empty" id="chatEmpty">Proxy writes to the merchants' agents here once the human replies.</div><div id="threads"></div></div>
    <button class="pill" id="pillC" type="button">New &#8595;</button>
  </section>
</main>
<script>
(function(){
  var q=new URLSearchParams(location.search);
  var tid=q.get("task_id")||"";
  var fixtureQ=q.get("fixture")?("?"+(q.get("step")?"step="+encodeURIComponent(q.get("step"))+"&":"")+(q.get("long")?"long=1":"")):"";
  var feedUrl=q.get("feed")||(q.get("fixture")?"/web/stage-fixture"+fixtureQ:"/demo/feed"+(tid?"?task_id="+encodeURIComponent(tid):""));
  var $=function(id){return document.getElementById(id)};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=text;return e}
  var MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function money(c){return "$"+(c/100).toLocaleString("en-US",{maximumFractionDigits:0})}
  function day(s){var m=/^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s||"");return m?MONTHS[+m[2]-1]+" "+(+m[3]):""}
  function range(d){if(!d||!d.start)return "";if(!d.end||d.end===d.start)return day(d.start);var a=day(d.start),b=day(d.end);return a.split(" ")[0]===b.split(" ")[0]?a+" to "+b.split(" ")[1]:a+" to "+b}
  function clock(iso){var t=Date.parse(iso);return isNaN(t)?"":new Date(t).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"UTC"})}
  var ICON={flight:"\\u2708\\uFE0F",hotel:"\\uD83C\\uDFE8",transfer:"\\uD83D\\uDE95",message:"\\u2709\\uFE0F",saas:"\\uD83D\\uDCBB",store:"\\uD83D\\uDECD\\uFE0F"};
  var PARTY={proxy:{n:"Proxy",c:"#9fb0ff",i:"P"},hotel:{n:"Harborview Hotel agent",c:"#ffc65c",i:"H"},transfer:{n:"Metro Transfer support",c:"#5fe0d2",i:"T"},host:{n:"Host",c:"#c9b6ff",i:"H"}};
  var KIND={request:"Reversal request",counter:"Counter-offer",push_back:"Push back",accept_counter:"Accepted",accept:"Agreed",deny:"Declined",email:"Email",reply:"Reply",correction:"Correction"};
  var PROTOCOL={request:1,counter:1,push_back:1,accept_counter:1,accept:1,deny:1};
  var EMAILISH={email:1,reply:1,correction:1};

  /* ---- scrolling: each column follows its newest entry until the viewer scrolls up ---- */
  function track(body,pill){
    var st={follow:true,auto:0};
    function edges(){
      body.classList.toggle("cut-top",body.scrollTop>6);
      body.classList.toggle("cut-bottom",body.scrollHeight-body.scrollTop-body.clientHeight>6);
    }
    body.addEventListener("scroll",function(){
      edges();
      if(Date.now()-st.auto<800)return;
      st.follow=body.scrollHeight-body.scrollTop-body.clientHeight<56;
      if(st.follow)pill.classList.remove("on");
    });
    pill.addEventListener("click",function(){st.follow=true;pill.classList.remove("on");toEnd()});
    function toEnd(){st.auto=Date.now();body.scrollTo({top:body.scrollHeight,behavior:"smooth"})}
    return {
      grew:function(){if(st.follow)toEnd();else pill.classList.add("on");setTimeout(edges,50)},
      edges:edges
    };
  }
  var scA=track($("bodyA"),$("pillA")),scB=track($("bodyB"),$("pillB")),scC=track($("bodyC"),$("pillC"));
  window.addEventListener("resize",function(){scA.edges();scB.edges();scC.edges()});

  /* keyed rendering: a node is built once, so only new entries animate. Returns true when something was added. */
  function sync(box,items,keyOf,build,update){
    var have=box._m||(box._m={}),added=false;
    items.forEach(function(it){
      var k=keyOf(it),n=have[k];
      if(!n){n=build(it);n.classList.add("enter");have[k]=n;box.appendChild(n);added=true}
      if(update)update(n,it);
    });
    return added;
  }

  /* ---- reading the feed ---- */
  function idsOf(f,kind){var s={};(f.entries||[]).forEach(function(e){if(e.kind===kind&&e.data&&e.data.action_id!==undefined)s[String(e.data.action_id)]=1});return s}
  function isWrong(b,task){
    if(b.wrong===true||b.wrong===false)return b.wrong;
    var want=task&&task.intended_dates,d=b.dates;
    if(!want||!d||!d.start)return false;
    var end=want.end||want.start;
    return d.start<want.start||d.start>end||(d.end&&d.end>end);
  }

  /* ---- progress line ---- */
  var STEPS=["Mistake detected","Human alerted","Human replied","Negotiating","Refunds confirmed","Rebooked"];
  var story=$("story");STEPS.forEach(function(s){story.appendChild(el("li",null,s))});
  function progress(f,redo){
    var rows=f.chain?f.chain.rows||[]:[],human=f.human||[];
    var talked=(f.conversations||[]).some(function(c){return(c.entries||[]).length>0});
    var allDone=rows.length>0&&rows.every(function(r){return r.verified||(r.amount===0&&(r.state==="accepted"||r.state==="verified"))});
    var reached=[
      !!f.chain||(f.bookings||[]).some(function(b){return isWrong(b,f.task)}),
      human.some(function(h){return h.direction==="out"}),
      human.some(function(h){return h.direction==="in"}),
      talked,
      allDone,
      (f.bookings||[]).some(function(b){return b.rebooked===true||redo[b.id]})
    ];
    var cur=-1;reached.forEach(function(r,i){if(r)cur=i});
    var lis=story.children,finished=cur===5;
    for(var i=0;i<lis.length;i++){
      lis[i].className=i<cur||(finished&&i===cur)?"done":i===cur?"now":"";
      if(finished)lis[i].classList.add("all");
    }
  }

  /* ---- left ---- */
  function buildCard(b,task,good){
    var c=el("div","card");
    c.appendChild(el("div","ic",ICON[b.category]||"\\u2022"));
    var mid=el("div");mid.appendChild(el("div","t",b.summary));
    if(b.dates&&b.dates.start){
      var w=el("div","when",range(b.dates));
      if(!good&&task&&task.intended_dates)w.appendChild(el("i",null,"should be "+(b.dates.end?range(task.intended_dates):day(task.intended_dates.start))));
      mid.appendChild(w);
    }
    c.appendChild(mid);
    c.appendChild(el("div","a",b.amount?money(b.amount):"no charge"));
    return c;
  }

  /* ---- middle ---- */
  var shown=0,target=0,raf=0,from=0,t0=0;
  function setNum(v){$("rec").firstChild.nodeValue=money(v)}
  function countTo(v){
    if(v===target)return;target=v;from=shown;t0=performance.now();cancelAnimationFrame(raf);
    (function step(now){var p=Math.min(1,(now-t0)/1100),e=1-Math.pow(1-p,3);shown=Math.round(from+(target-from)*e);setNum(shown);if(p<1)raf=requestAnimationFrame(step)})(t0);
  }
  var serverNow=0,gotAt=0,windowEnd=0,chainState="";
  function tick(){
    var left=windowEnd?windowEnd-(serverNow+(Date.now()-gotAt)):null,c=$("clock");c.textContent="";
    if(chainState==="reversed"||chainState==="redone"||chainState==="closed"){c.appendChild(el("b",null,"Done"));return}
    if(left===null)return;
    if(left<=0){c.textContent="Window closed";return}
    var s=Math.floor(left/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;
    c.appendChild(document.createTextNode("Window closes in "));c.appendChild(el("b",null,h+"h "+("0"+m).slice(-2)+"m "+("0"+r).slice(-2)+"s"));
  }
  setInterval(tick,250);
  var TONE={detected:"needs you",alerted:"waiting for the human",undoing:"undoing",partial:"partly done",reversed:"undone",redone:"rebooked",closed:"closed",kept:"kept",expired:"window closed"};
  function buildRow(r){
    var d=el("div","row");d.appendChild(el("div","dot","\\u2713"));
    var m=el("div");m.appendChild(el("div","l",r.label));m.appendChild(el("div","s",""));d.appendChild(m);d.appendChild(el("div","a",""));return d;
  }
  function updateRow(n,r,agent){
    var done=r.verified||(r.amount===0&&(r.state==="accepted"||r.state==="verified"));
    var cls="row"+(done?" ok":(r.state&&r.state!=="found"?" work":""));
    if(n.className.indexOf("enter")>=0)cls+=" enter";
    n.className=cls;
    var s=n.querySelector(".s"),a=n.querySelector(".a");
    if(r.verified){
      a.textContent=r.refunded<r.amount?money(r.refunded)+" of "+money(r.amount):money(r.refunded);
      s.textContent=agent?"Refunded by your agent":"Confirmed in Stripe";
    }else{
      a.textContent=r.amount?money(r.amount):"no charge";
      s.textContent=r.amount===0&&done?"Corrected":r.state==="requested"?"Asking the merchant":r.state==="refund_pending"?"Waiting for Stripe":r.state==="failed"?"Could not be undone":r.state==="kept"?"Kept":"Flagged";
    }
  }
  function renderPhone(f){
    var box=$("phone"),h=f.human||[];
    if(!h.length){if(!box._empty){box._empty=el("div","nophone","No text sent yet.");box.appendChild(box._empty)}return false}
    if(box._empty){box._empty.remove();box._empty=null}
    var firstOut=-1,lastOut=-1;h.forEach(function(x,i){if(x.direction==="out"){if(firstOut<0)firstOut=i;lastOut=i}});
    // the alert, then the human's replies; any later text from Proxy is one line underneath
    var picks=[];
    if(firstOut>=0)picks.push(h[firstOut]);
    h.forEach(function(x){if(x.direction==="in")picks.push(x)});
    picks=picks.slice(0,4).sort(function(a,b){return Date.parse(a.at)-Date.parse(b.at)});
    var added=sync(box,picks,function(x){return x.at+"|"+x.direction+"|"+x.text},function(x){
      if(x.direction==="in"){var r=el("div","reply");r.appendChild(el("span","rb",x.text));r.appendChild(el("small",null,"You replied at "+clock(x.at)));return r}
      var n=el("div","note"),w=el("div","who");w.appendChild(el("span","ico","P"));w.appendChild(el("b",null,"Proxy"));w.appendChild(el("span",null,clock(x.at)));n.appendChild(w);
      x.text.split("\\n\\n").forEach(function(par){n.appendChild(el("p",null,par))});return n;
    });
    var late=lastOut>firstOut?h[lastOut]:null,L=box._late;
    if(late){
      if(!L){L=el("div","latest enter");box._late=L;box.appendChild(L)}
      L.textContent="";L.appendChild(el("b",null,"Latest text, "+clock(late.at)+": "));L.appendChild(document.createTextNode(late.text.split("\\n").join(" ")));
    }
    return added;
  }

  /* ---- right ---- */
  function party(id){return PARTY[id]||{n:id,c:"#cfd6e2",i:String(id||"?").charAt(0).toUpperCase()}}
  function channelOf(c){
    var proto=false,mail=false;(c.entries||[]).forEach(function(e){if(PROTOCOL[e.kind])proto=true;else if(EMAILISH[e.kind])mail=true});
    return proto&&mail?"A2A, then email":proto?"A2A":"email";
  }
  function threadName(c){return party(c.with).n!==c.with?party(c.with).n:(c.name||c.with)}
  function buildThread(c){
    var t=el("div","thread"),h=el("div","thead"),av=el("div","av",party(c.with).i);av.style.background=party(c.with).c;
    h.appendChild(av);h.appendChild(el("span",null,""));t.appendChild(h);t.appendChild(el("div","msgs"));return t;
  }
  function buildBubble(e,c){
    if(e.from==="stripe")return el("div","sys","\\u2713 "+e.text);
    var p=e.from==="proxy"?party("proxy"):party(c.with);
    var row=el("div","chat "+(e.from==="proxy"?"proxy":"r"));
    var av=el("div","av",p.i);av.style.background=p.c;row.appendChild(av);
    var b=el("div","bub"),n=el("div","n",e.from==="proxy"?"Proxy":threadName(c));n.style.color=p.c;
    if(KIND[e.kind])n.appendChild(el("em",null,KIND[e.kind]));
    b.appendChild(n);b.appendChild(el("div",null,e.text));
    row.appendChild(b);return row;
  }
  function renderThreads(f){
    var box=$("threads"),convs=f.conversations||[],grew=false;
    convs.forEach(function(c){
      var have=box._t||(box._t={}),t=have[c.with];
      if(!t){t=buildThread(c);t.classList.add("enter");have[c.with]=t;box.appendChild(t);grew=true;t._n=0}
      t.querySelector(".thead span").textContent=threadName(c)+" \\u00B7 "+channelOf(c);
      var msgs=t.querySelector(".msgs"),list=c.entries||[];
      // Entries are appended in order; keyed by position so identical lines never collapse into one.
      for(;t._n<list.length;t._n++){var b=buildBubble(list[t._n],c);b.classList.add("enter");msgs.appendChild(b);grew=true}
    });
    if(convs.length&&$("chatEmpty"))$("chatEmpty").remove();
    return grew;
  }

  /* ---- one render per poll ---- */
  var lastGoal="";
  function render(f){
    var task=f.task||{},chain=f.chain||null,redo=idsOf(f,"redo"),selfUndo=idsOf(f,"self_undo");
    serverNow=Date.parse(f.now)||Date.now();gotAt=Date.now();
    if(task.goal!==lastGoal){lastGoal=task.goal;$("goal").textContent=task.goal||""}
    var meta=$("asked");meta.textContent="";
    if(task.intended_dates){meta.appendChild(document.createTextNode("The human asked for "));meta.appendChild(el("strong",null,range(task.intended_dates)))}
    if(task.budget_total)meta.appendChild(document.createTextNode(", under "+money(task.budget_total)));

    var all=f.bookings||[];
    var isRe=function(b){return b.rebooked===true||!!redo[b.id]};
    var bad=all.filter(function(b){return !isRe(b)}),good=all.filter(isRe);
    var a1=sync($("listBad"),bad,function(b){return b.id},function(b){return buildCard(b,task,false)});
    $("cntBad").textContent=bad.length?bad.length+(bad.length===1?" booking":" bookings"):"";
    $("grpGood").hidden=!good.length;
    var a2=sync($("listGood"),good,function(b){return b.id},function(b){return buildCard(b,task,true)});
    if(good.length){$("goodTitle").textContent="Rebooked for "+(task.intended_dates?day(task.intended_dates.start):"the right dates");$("cntGood").textContent=good.length+(good.length===1?" booking":" bookings")}
    $("subA").textContent=bad.some(function(b){return isWrong(b,task)})?"wrong dates":"";
    if(a1||a2)scA.grew();

    var addedRows=false;
    if(chain){
      windowEnd=chain.window_ends_at?Date.parse(chain.window_ends_at):0;chainState=chain.state;
      $("of").textContent="of "+money(chain.total||0);
      countTo(chain.recovered||0);
      $("barfill").style.width=(chain.total?Math.min(100,Math.round(100*(chain.recovered||0)/chain.total)):0)+"%";
      $("state").textContent=TONE[chain.state]||chain.state;
      addedRows=sync($("rows"),chain.rows||[],function(r){return r.id},buildRow,function(n,r){updateRow(n,r,r.by_agent===true||!!selfUndo[r.id])});
      $("subB").textContent=(chain.rows||[]).length+((chain.rows||[]).length===1?" action":" actions");
    }else{
      $("of").textContent="";$("state").textContent="Watching for mistakes";$("subB").textContent="";
    }
    var addedPhone=renderPhone(f);
    if(addedRows||addedPhone)scB.grew();

    var grewC=renderThreads(f);
    $("subC").textContent=(f.conversations||[]).length?(f.conversations.length+(f.conversations.length===1?" thread":" threads")):"";
    if(grewC)scC.grew();
    progress(f,redo);
    scA.edges();scB.edges();scC.edges();
  }

  var failures=0;
  function poll(){
    fetch(feedUrl,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(f){
      failures=0;var s=$("status");s.className="live";s.textContent=q.get("fixture")?"Replaying the demo story":"Live";render(f);
    }).catch(function(){
      failures++;var s=$("status");s.className="";if(failures>2)s.textContent="Waiting for the demo feed";
    }).then(function(){setTimeout(poll,1000)});
  }
  setNum(0);poll();
})();
</script>
</body>
</html>`;
