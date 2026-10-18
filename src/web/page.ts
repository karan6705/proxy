// One self-contained page. Everything from the server is written with textContent, never innerHTML,
// because merchant and email text is untrusted.
export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy live</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1b1b18;--mute:#6b6a64;--line:#e3e1da;--ok:#1f7a4d;--warn:#b26b00;--bad:#b3261e;--info:#2d5fb4;--chip:#efede6}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#efede6;--mute:#9a988f;--line:#33322e;--ok:#4cc38a;--warn:#e0a03a;--bad:#f0746b;--info:#7ea6f0;--chip:#2a2a27}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;padding:16px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0}
.mute{color:var(--mute)}
main{display:grid;gap:16px;padding:16px;grid-template-columns:minmax(0,3fr) minmax(0,2fr)}
@media (max-width:820px){main{grid-template-columns:1fr}}
section{min-width:0}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mute);margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px}
.row{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--chip);font-size:12px}
.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.info{color:var(--info)}
.big{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
ul{list-style:none;margin:8px 0 0;padding:0}
li.action{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-top:1px solid var(--line)}
li.action .dot{width:10px;height:10px;border-radius:50%;background:var(--line);margin-top:6px;flex:none}
li.action .dot.verified{background:var(--ok)}li.action .dot.failed{background:var(--bad)}li.action .dot.pending{background:var(--warn)}
.left{display:flex;gap:10px;min-width:0}.left span.t{overflow-wrap:anywhere}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:6px 12px;border-radius:8px;cursor:pointer}
button.primary{background:var(--ink);color:var(--bg);border-color:var(--ink)}
button:disabled{opacity:.5;cursor:default}
.controls{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap}
.feed{max-height:70vh;overflow:auto}
.ev{display:grid;grid-template-columns:70px 92px 1fr;gap:8px;padding:4px 0;border-top:1px solid var(--line);font-size:13px}
.ev:first-child{border-top:0}.ev .o{overflow-wrap:anywhere}
.empty{color:var(--mute);padding:8px 0}
pre{white-space:pre-wrap;font-size:12px;margin:0;overflow-wrap:anywhere}
</style>
</head>
<body>
<header><h1>Proxy</h1><span class="mute" id="clock"></span><span class="mute">Merchants and their agents are our mocks. The clock is simulated.</span></header>
<main>
<section><h2>Undo chains</h2><div id="chains"></div><div id="score"></div></section>
<section><h2>Live events</h2><div class="card feed" id="feed"></div></section>
</main>
<script>
(function(){
var $=function(id){return document.getElementById(id)};
var money=function(c){return "$"+(c/100).toLocaleString("en-US",{maximumFractionDigits:0})};
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e}
function left(ms){if(ms==null)return "no deadline";if(ms<=0)return "window closed";var m=Math.floor(ms/60000),h=Math.floor(m/60);return (h>0?h+"h ":"")+(m%60)+"m left"}
var tone={detected:"warn",alerted:"warn",undoing:"info",partial:"warn",reversed:"ok",redo_requested:"info",redone:"ok",closed:"ok",kept:"ok",expired:"bad"};
var sel={},note={},showAll=false,OPEN=["detected","alerted","undoing","partial"];
var said={forwarded:"Sent. The orchestrator has the decision.",duplicate:"Already on it. A second tap does nothing.",too_late:"Too late: that window has closed.",kept:"Already kept.",undo_started:"The undo already started.",pick_list:"Choose at least one action.",already_handled:"Already handled.",clarify:"Not understood."};
function post(chain,kind,picks){
  return fetch("/web/reply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chain_id:chain,kind:kind,picks:picks})}).then(function(r){return r.json()}).then(function(j){
    var r=j&&j.result;note[chain]=!j.ok?(j.message||"Failed."):(r&&r.status==="forwarded"?said.forwarded:(r&&said[r.reason])||"Done.");
  }).catch(function(){note[chain]="Could not reach the server."});
}
function render(s){
  $("clock").textContent="Sim time "+new Date(s.now).toISOString().replace("T"," ").slice(0,16)+" UTC";
  var box=$("chains");box.textContent="";
  if(s.hidden_chains>0){
    var hid=el("div","mute","Showing the current run. "+s.hidden_chains+" chain"+(s.hidden_chains===1?"":"s")+" from earlier runs hidden. ");
    var a=el("a",null,"Show all");a.href="?all=1";a.style.color="inherit";hid.appendChild(a);box.appendChild(hid);
  }
  if(!s.chains.length)box.appendChild(el("div","empty","No chains yet. Nothing has gone wrong."));
  var ordered=s.chains.slice().reverse();
  var active=ordered.filter(function(c){return OPEN.indexOf(c.state)>=0});
  var earlier=ordered.filter(function(c){return OPEN.indexOf(c.state)<0});
  var shown=showAll?active.concat(earlier):active.length?active:earlier.slice(0,1);
  if(earlier.length&&active.length){
    var tg=el("button","",showAll?"Hide earlier chains":"Show "+earlier.length+" earlier chain"+(earlier.length===1?"":"s"));
    tg.onclick=function(){showAll=!showAll;render(s)};box.appendChild(tg);
  }
  shown.forEach(function(c){
    var card=el("div","card"),top=el("div","row");
    var l=el("div");l.appendChild(el("span","pill "+(tone[c.state]||""),c.state));l.appendChild(el("span","mute"," "+c.task_id));
    top.appendChild(l);top.appendChild(el("div","big",money(c.money_at_risk)));card.appendChild(top);
    var ms=c.window_ends_at?Date.parse(c.window_ends_at)-Date.parse(s.now):null;
    card.appendChild(el("div","mute",left(ms)+" · "+c.actions.length+" affected"));
    var ul=el("ul");
    c.actions.forEach(function(a,i){
      var li=el("li","action"),lf=el("div","left");
      if(s.controls&&sel[c.chain_id]&&sel[c.chain_id].on){
        var cb=document.createElement("input");cb.type="checkbox";cb.checked=!!sel[c.chain_id].set[i+1];
        cb.onchange=function(){sel[c.chain_id].set[i+1]=cb.checked};lf.appendChild(cb);
      }
      lf.appendChild(el("span","dot "+(a.stripe_verified?"verified":a.state==="failed"?"failed":a.state==="refund_pending"?"pending":"")));
      var t=el("span","t");t.appendChild(document.createTextNode((i+1)+". "+a.summary+" "));t.appendChild(el("span","mute",a.merchant+" · "+a.state+(a.stripe_verified?" · Stripe verified":"")));
      lf.appendChild(t);li.appendChild(lf);li.appendChild(el("span","",money(a.amount)));ul.appendChild(li);
    });
    card.appendChild(ul);
    var open=["detected","alerted","partial"].indexOf(c.state)>=0;
    if(s.controls&&open){
      var ctl=el("div","controls"),st=sel[c.chain_id]||(sel[c.chain_id]={on:false,set:{}});
      var u=el("button","primary","UNDO ALL");u.onclick=function(){u.disabled=true;post(c.chain_id,"undo_all")};
      var k=el("button","","KEEP");k.onclick=function(){k.disabled=true;post(c.chain_id,"keep")};
      if(!st.on){
        var p=el("button","","PICK");p.onclick=function(){st.on=true;st.set={}};
        ctl.appendChild(u);ctl.appendChild(p);ctl.appendChild(k);
      }else{
        var go=el("button","primary","Undo selected");go.onclick=function(){
          var n=Object.keys(st.set).filter(function(x){return st.set[x]}).map(Number);
          if(!n.length){note[c.chain_id]=said.pick_list;return}
          st.on=false;post(c.chain_id,"pick",n)};
        var no=el("button","","Cancel");no.onclick=function(){st.on=false;st.set={}};
        ctl.appendChild(go);ctl.appendChild(no);
        ctl.appendChild(el("span","mute","Tick the actions to undo"));
      }
      card.appendChild(ctl);
    }
    if(note[c.chain_id])card.appendChild(el("div","mute",note[c.chain_id]));
    box.appendChild(card);
  });
  var feed=$("feed");feed.textContent="";
  if(!s.events.length)feed.appendChild(el("div","empty","Waiting for events."));
  s.events.forEach(function(e){
    var r=el("div","ev");r.appendChild(el("span","mute",new Date(e.timestamp).toISOString().slice(11,19)));
    r.appendChild(el("span","pill",e.kind));r.appendChild(el("span","o",(e.tool_name?e.tool_name+": ":"")+(e.outcome||"")));feed.appendChild(r);
  });
  var sc=$("score");sc.textContent="";
  if(s.scoreboard){var card=el("div","card");card.appendChild(el("h2","","Scoreboard"));card.appendChild(el("pre","",JSON.stringify(s.scoreboard,null,2)));sc.appendChild(card)}
}
function tick(){fetch("/web/state"+location.search,{cache:"no-store"}).then(function(r){return r.json()}).then(render).catch(function(){}).then(function(){setTimeout(tick,2000)})}
tick();
})();
</script>
</body>
</html>`;
