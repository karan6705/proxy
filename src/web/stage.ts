// The stage page: a full-screen 16:9 dark view meant to be screen-recorded.
//   Left   "The mistake"   the agent's task and its bookings appearing one by one, wrong dates in red
//   Middle "Proxy"         the live undo chain: Recovered $X of $Y, rows turning green when Stripe confirms,
//                          the countdown, and the human's thread (the alert and the reply as it arrives)
//   Right  "Agent to agent" Proxy talking to the hotel agent and the transfer desk, bubble by bubble
// It polls GET /demo/feed?task_id=... every second. ?fixture=1 plays a built-in story instead (/web/stage-fixture);
// ?feed=<url> points it at any other feed; ?task_id=<id> picks the run.
// Everything from the feed is written with textContent, never innerHTML.
export const STAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy stage</title>
<style>
:root{
  --bg:#07090d;--panel:#10141b;--panel2:#161b24;--line:#27303d;
  --ink:#f6f8fb;--mute:#b4bdcb;--dim:#8793a5;
  --red:#ff6b78;--redbg:#3a1118;--green:#42e0a0;--greenbg:#0f3326;--amber:#ffc65c;--indigo:#9aa8ff;--teal:#56d6c9;--blue:#0a6cf0;
}
*{box-sizing:border-box;margin:0}
html,body{height:100%;background:var(--bg);color:var(--ink);overflow:hidden;
  font-family:ui-sans-serif,-apple-system,"SF Pro Display","Segoe UI",Helvetica,Arial,sans-serif}
/* 1rem is 1% of the stage width, so the whole layout scales with the 16:9 frame */
html{font-size:calc(min(100vw,100vh*16/9)/100)}
body{display:grid;place-items:center}
#stage{width:100rem;height:56.25rem;display:grid;grid-template-rows:5.4rem 1fr;background:var(--bg);position:relative}
header{display:flex;align-items:center;justify-content:space-between;padding:0 2.2rem;border-bottom:.1rem solid var(--line)}
header h1{font-size:1.9rem;font-weight:800;letter-spacing:.02em}
header h1 span{color:var(--indigo)}
#status{font-size:1.15rem;color:var(--mute)}
#status.live::before{content:"";display:inline-block;width:.8rem;height:.8rem;border-radius:50%;background:var(--green);margin-right:.7rem;animation:pulse 1.6s infinite}
main{display:grid;grid-template-columns:1fr 1fr 1fr;gap:1.4rem;padding:1.4rem 1.8rem 1.6rem;min-height:0}
section{background:var(--panel);border:.1rem solid var(--line);border-radius:1.2rem;padding:1.5rem 1.6rem;display:flex;flex-direction:column;min-height:0;min-width:0}
h2{font-size:1.15rem;letter-spacing:.14em;text-transform:uppercase;color:var(--mute);font-weight:700;margin-bottom:1.1rem;display:flex;align-items:center;gap:.8rem}
h2 b{display:inline-grid;place-items:center;width:2.2rem;height:2.2rem;border-radius:50%;background:var(--panel2);color:var(--ink);font-size:1.2rem}
.scroll{flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;gap:.8rem;scroll-behavior:smooth}
#chat{justify-content:flex-start}
.ask{font-size:1.45rem;font-weight:700;line-height:1.22;margin-bottom:.3rem}
.askmeta{font-size:1.15rem;color:var(--mute);margin-bottom:.9rem}
.askmeta strong{color:var(--green)}
/* left: bookings */
.card{background:var(--panel2);border:.1rem solid var(--line);border-radius:1rem;padding:.75rem 1.1rem;display:grid;grid-template-columns:2.4rem 1fr auto;column-gap:1rem;align-items:center}
.card .ic{font-size:1.8rem;text-align:center}
.card .t{font-size:1.25rem;font-weight:650;line-height:1.15}
.card .m{font-size:1rem;color:var(--mute);margin-top:.15rem}
.card .a{font-size:1.4rem;font-weight:750;font-variant-numeric:tabular-nums}
.card .when{grid-column:2/4;margin-top:.4rem;font-size:1.12rem;font-weight:700;color:var(--green)}
.card.wrong{border-color:var(--red);background:var(--redbg)}
.card.wrong .when{color:var(--red)}
.card.wrong .when em{font-style:normal;color:var(--mute);font-weight:600;margin-left:.6rem}
/* middle: proxy */
.big{font-size:1.25rem;color:var(--mute);margin-bottom:.2rem}
.num{font-size:4.2rem;font-weight:850;line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.num small{font-size:2.2rem;font-weight:700;color:var(--mute);margin-left:.5rem;letter-spacing:0}
.bar{height:.8rem;border-radius:1rem;background:var(--panel2);margin:.8rem 0 .5rem;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:var(--green);border-radius:1rem;transition:width .9s cubic-bezier(.2,.8,.2,1)}
.meta{display:flex;justify-content:space-between;font-size:1.15rem;color:var(--mute);margin-bottom:.8rem}
.meta b{color:var(--ink);font-variant-numeric:tabular-nums}
.pill{display:inline-block;padding:.15rem .8rem;border-radius:2rem;background:var(--panel2);font-size:1.05rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.pill.warn{color:var(--amber)}.pill.ok{color:var(--green)}.pill.info{color:var(--indigo)}
.row{display:grid;grid-template-columns:2.2rem 1fr auto;column-gap:1rem;align-items:center;padding:.55rem 1rem;border-radius:.9rem;background:var(--panel2);border:.1rem solid var(--line);transition:background .6s,border-color .6s}
.row .dot{width:2rem;height:2rem;border-radius:50%;border:.17rem solid var(--dim);display:grid;place-items:center;font-size:1.15rem;font-weight:900;color:transparent;transition:all .5s}
.row .l{font-size:1.2rem;font-weight:650}
.row .s{font-size:.95rem;color:var(--mute)}
.row .a{font-size:1.25rem;font-weight:750;font-variant-numeric:tabular-nums}
.row.work .dot{border-color:var(--amber);animation:pulse 1.4s infinite}
.row.ok{background:var(--greenbg);border-color:var(--green)}
.row.ok .dot{background:var(--green);border-color:var(--green);color:#04170f;animation:pop .5s cubic-bezier(.2,1.6,.4,1)}
.row.ok .s{color:var(--green)}
#rows{flex:none;gap:.55rem}
.fade{-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 2.6rem);mask-image:linear-gradient(to bottom,transparent 0,#000 2.6rem)}
.thread{margin-top:.8rem;flex:1;min-height:0;display:flex;flex-direction:column;gap:.5rem;overflow:hidden;justify-content:flex-end}
.msg{max-width:92%;padding:.55rem 1rem;border-radius:1.3rem;font-size:1.02rem;line-height:1.25;white-space:pre-line}
.msg.out{align-self:flex-start;background:#262c37;border-bottom-left-radius:.4rem}
.msg.in{align-self:flex-end;background:var(--blue);color:#fff;font-weight:700;font-size:1.25rem;border-bottom-right-radius:.4rem}
.msg small{display:block;color:var(--dim);font-size:.82rem;margin-bottom:.1rem;letter-spacing:.04em}
.msg.in small{color:#cfe3ff}
/* right: agent to agent */
.chat{display:flex;gap:.9rem;align-items:flex-end}
.chat.r{flex-direction:row-reverse}
.av{width:3.1rem;height:3.1rem;flex:none;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:1.3rem;color:#0a0d12}
.bub{max-width:76%;padding:.75rem 1.1rem;border-radius:1.3rem;font-size:1.15rem;line-height:1.3;background:var(--panel2);border:.1rem solid var(--line)}
.bub .n{font-size:.92rem;font-weight:700;margin-bottom:.15rem;letter-spacing:.03em}
.chat.proxy .bub{border-bottom-left-radius:.4rem}
.chat.r .bub{border-bottom-right-radius:.4rem}
.chat .k{display:inline-block;margin-top:.35rem;font-size:.82rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:700}
.sys{align-self:center;text-align:center;padding:.6rem 1.4rem;border-radius:2rem;background:var(--greenbg);border:.1rem solid var(--green);color:var(--green);font-size:1.2rem;font-weight:750}
.empty{color:var(--dim);font-size:1.2rem;padding:.5rem 0}
.enter{animation:in .55s cubic-bezier(.2,.8,.2,1) both}
@keyframes in{from{opacity:0;transform:translateY(1.4rem) scale(.98)}to{opacity:1;transform:none}}
@keyframes pop{0%{transform:scale(.4)}100%{transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
</style>
</head>
<body>
<div id="stage">
  <header>
    <h1><span>Proxy</span> · the undo layer for AI agents</h1>
    <div id="status">Connecting to the demo feed…</div>
  </header>
  <main>
    <section>
      <h2><b>1</b> The mistake</h2>
      <div class="ask" id="goal"></div>
      <div class="askmeta" id="asked"></div>
      <div class="scroll" id="bookings" data-noscroll="1"></div>
    </section>
    <section>
      <h2><b>2</b> Proxy</h2>
      <div class="big">Recovered</div>
      <div class="num" id="rec">$0<small id="of"></small></div>
      <div class="bar"><i id="barfill"></i></div>
      <div class="meta"><span id="state"></span><span id="clock"></span></div>
      <div class="scroll" id="rows"></div>
      <div class="thread fade" id="thread"></div>
    </section>
    <section>
      <h2><b>3</b> Agent to agent</h2>
      <div class="scroll fade" id="chat"><div class="empty" id="chatEmpty">Proxy messages the merchants' agents here once you reply.</div></div>
    </section>
  </main>
</div>
<script>
(function(){
  var q=new URLSearchParams(location.search);
  var tid=q.get("task_id")||"";
  var feedUrl=q.get("feed")||(q.get("fixture")?"/web/stage-fixture"+(q.get("step")?"?step="+encodeURIComponent(q.get("step")):""):"/demo/feed"+(tid?"?task_id="+encodeURIComponent(tid):""));
  var $=function(id){return document.getElementById(id)};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=text;return e}
  var MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function money(c){return "$"+(c/100).toLocaleString("en-US",{maximumFractionDigits:0})}
  function day(s){var m=/^(\\d{4})-(\\d{2})-(\\d{2})/.exec(s||"");return m?MONTHS[+m[2]-1]+" "+(+m[3]):""}
  function range(d){if(!d||!d.start)return "";if(!d.end||d.end===d.start)return day(d.start);var a=day(d.start),b=day(d.end);return a.split(" ")[0]===b.split(" ")[0]?a+" to "+b.split(" ")[1]:a+" to "+b}
  var ICON={flight:"\\u2708\\uFE0F",hotel:"\\uD83C\\uDFE8",transfer:"\\uD83D\\uDE95",message:"\\u2709\\uFE0F",saas:"\\uD83D\\uDCBB",store:"\\uD83D\\uDECD\\uFE0F"};
  var PARTY={proxy:{n:"Proxy",c:"#9aa8ff",i:"P"},hotel:{n:"Harborview Hotel agent",c:"#ffc65c",i:"H"},transfer:{n:"Metro Transfer desk",c:"#56d6c9",i:"T"},stripe:{n:"Stripe",c:"#42e0a0",i:"S"}};
  var KIND={request:"Reversal request",counter:"Counter-offer",push_back:"Push back",accept_counter:"Accepted",accept:"Agreed",deny:"Declined",email:"Email",reply:"Reply",correction:"Correction"};

  /* keyed rendering: a node is built once, so only new entries animate */
  function sync(box,items,keyOf,build,update){
    var have=box._m||(box._m={}),added=false;
    items.forEach(function(it){
      var k=keyOf(it),n=have[k];
      if(!n){n=build(it);n.classList.add("enter");have[k]=n;box.appendChild(n);added=true}
      if(update)update(n,it);
    });
    if(added&&!box.dataset.noscroll)box.scrollTop=box.scrollHeight;
  }

  /* ---- left ---- */
  function isWrong(b,task){
    if(b.wrong===true||b.wrong===false)return b.wrong;
    var want=task&&task.intended_dates,d=b.dates;
    if(!want||!d||!d.start)return false;
    var end=want.end||want.start;
    return d.start<want.start||d.start>end||(d.end&&d.end>end);
  }
  function buildBooking(b,task){
    var c=el("div","card"+(isWrong(b,task)?" wrong":""));
    c.appendChild(el("div","ic",ICON[b.category]||"\\u2022"));
    var mid=el("div");mid.appendChild(el("div","t",b.summary));mid.appendChild(el("div","m",b.merchant));c.appendChild(mid);
    c.appendChild(el("div","a",b.amount?money(b.amount):"free"));
    if(b.dates&&b.dates.start){
      var w=el("div","when",range(b.dates));
      if(isWrong(b,task)&&task&&task.intended_dates)w.appendChild(el("em",null,"should be "+(b.dates.end?range(task.intended_dates):day(task.intended_dates.start))));
      c.appendChild(w);
    }
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
    var left=windowEnd?windowEnd-(serverNow+(Date.now()-gotAt)):null,c=$("clock");
    if(chainState==="reversed"||chainState==="redone"||chainState==="closed"){c.textContent="";c.appendChild(el("b",null,"Done"));return}
    if(left===null){c.textContent="";return}
    if(left<=0){c.textContent="Window closed";return}
    var s=Math.floor(left/1000),h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;
    c.textContent="Window closes in ";c.appendChild(el("b",null,h+"h "+("0"+m).slice(-2)+"m "+("0"+r).slice(-2)+"s"));
  }
  setInterval(tick,250);
  var TONE={detected:"warn",alerted:"warn",undoing:"info",partial:"warn",reversed:"ok",redone:"ok",closed:"ok",kept:"ok",expired:"warn"};
  function buildRow(r){
    var d=el("div","row work");d.appendChild(el("div","dot","\\u2713"));
    var m=el("div");m.appendChild(el("div","l",r.label));m.appendChild(el("div","s",""));d.appendChild(m);d.appendChild(el("div","a",r.amount?money(r.amount):"no charge"));return d;
  }
  function updateRow(n,r){
    var done=r.verified||(r.amount===0&&(r.state==="accepted"||r.state==="verified"));
    n.className="row"+(done?" ok":(r.state&&r.state!=="found"?" work":""))+(n.classList.contains("enter")?" enter":"");
    var s=n.querySelector(".s");
    s.textContent=r.verified?(r.refunded<r.amount?"Refunded "+money(r.refunded)+" of "+money(r.amount)+" · confirmed in Stripe":"Refunded "+money(r.refunded)+" · confirmed in Stripe")
      :r.amount===0&&done?"Corrected":r.state==="requested"?"Asking the merchant":r.state==="refund_pending"?"Waiting for Stripe":r.state==="failed"?"Could not be undone":r.state==="kept"?"Kept":"Flagged";
  }
  function buildMsg(h){
    var m=el("div","msg "+h.direction);
    m.appendChild(el("small",null,h.direction==="in"?"You · "+h.channel:"Proxy · "+h.channel));
    m.appendChild(document.createTextNode(h.text));return m;
  }

  /* ---- right ---- */
  function party(id){return PARTY[id]||{n:id,c:"#cfd6e2",i:String(id||"?").charAt(0).toUpperCase()}}
  function buildBubble(e){
    if(e.from==="stripe"){return el("div","sys","\\u2713 "+e.text)}
    var p=e.from==="proxy"?party("proxy"):{n:e._name||party(e._with).n,c:party(e._with).c,i:party(e._with).i};
    var row=el("div","chat "+(e.from==="proxy"?"proxy":"r"));
    var av=el("div","av",p.i);av.style.background=p.c;row.appendChild(av);
    var b=el("div","bub");var n=el("div","n",p.n);n.style.color=p.c;b.appendChild(n);b.appendChild(el("div",null,e.text));
    if(KIND[e.kind])b.appendChild(el("span","k",KIND[e.kind]));
    row.appendChild(b);return row;
  }

  /* ---- one render per poll ---- */
  var lastGoal="";
  function render(f){
    var task=f.task||{},chain=f.chain||null;
    serverNow=Date.parse(f.now)||Date.now();gotAt=Date.now();
    if(task.goal!==lastGoal){lastGoal=task.goal;$("goal").textContent=task.goal||""}
    var meta=$("asked");meta.textContent="";
    if(task.intended_dates){meta.appendChild(document.createTextNode("The human asked for "));meta.appendChild(el("strong",null,range(task.intended_dates)))}
    if(task.budget_total)meta.appendChild(document.createTextNode(" · under "+money(task.budget_total)));
    sync($("bookings"),f.bookings||[],function(b){return b.id},function(b){return buildBooking(b,task)});
    if(chain){
      windowEnd=chain.window_ends_at?Date.parse(chain.window_ends_at):0;chainState=chain.state;
      $("of").textContent="of "+money(chain.total||0);
      countTo(chain.recovered||0);
      $("barfill").style.width=(chain.total?Math.min(100,Math.round(100*(chain.recovered||0)/chain.total)):0)+"%";
      var st=$("state");st.textContent="";st.appendChild(el("span","pill "+(TONE[chain.state]||""),chain.state));
      sync($("rows"),chain.rows||[],function(r){return r.id},buildRow,updateRow);
    }else{
      $("of").textContent="";$("state").textContent="Watching for mistakes…";
    }
    sync($("thread"),f.human||[],function(h){return h.at+"|"+h.direction+"|"+h.text},buildMsg);
    var bubbles=[];
    (f.conversations||[]).forEach(function(c){(c.entries||[]).forEach(function(e){var x={};for(var k in e)x[k]=e[k];x._with=c.with;x._name=c.name;bubbles.push(x)})});
    bubbles.sort(function(a,b){return Date.parse(a.at)-Date.parse(b.at)});
    sync($("chat"),bubbles,function(e){return e._with+"|"+e.at+"|"+e.kind+"|"+e.text},buildBubble);
    var ce=$("chatEmpty");if(ce&&bubbles.length){ce.remove()}
  }

  var failures=0;
  function poll(){
    fetch(feedUrl,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(f){
      failures=0;var s=$("status");s.className="live";s.textContent=q.get("fixture")?"Replaying the demo story":"Live";render(f);
    }).catch(function(){
      failures++;var s=$("status");s.className="";s.textContent=failures>2?"Waiting for the demo feed…":s.textContent;
    }).then(function(){setTimeout(poll,1000)});
  }
  setNum(0);poll();
})();
</script>
</body>
</html>`;
