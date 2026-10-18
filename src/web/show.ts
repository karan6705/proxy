// The presentation page (/web/show): a bright 16:9 view that explains Proxy on stage in three panels.
//   Left   "Your agent"         the human's request and the agent's "Done!" with booking cards; Proxy's find turns the
//                                wrong field red ("Nov 3 ≠ Nov 13"); the rebooked cards follow
//   Middle "Your phone"          an iPhone with Proxy's iMessages (the alert buzzes in) and the human's replies;
//                                the reply chips send a reply through POST /web/reply, the same path as a real text
//   Right  "Behind the scenes"   the merchant conversations, support emails, payment receipts and the recovered total
// Sources:
//   /web/show                        follows the live run (GET /demo/feed), or shows the scenario picker when there is none
//   /web/show?scenario=<name>        plays an isolated recording of that scenario (GET /web/show/run, then its feed)
//   /web/show?present=1              presenter mode: starts paused; Space or Right arrow advances one step, Left goes back
//   &task_id=<id>                    any run's feed instead of a recording
// It is drawn at 1920x1080 and scaled to the window, so it reads the same in a 1080p recording and on a laptop.
// Everything from the feed is written with textContent, never innerHTML.
export const SHOW_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Proxy show</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 32 32%27%3E%3Crect width=%2732%27 height=%2732%27 rx=%279%27 fill=%27%235856D6%27/%3E%3C/svg%3E">
<style>
:root{
  --bg:#F5F5F7; --card:#FFFFFF; --ink:#1D1D1F; --muted:#6E6E73; --faint:#AEAEB2; --hair:#E5E5EA;
  --accent:#5856D6; --accent-ink:#4240B8; --accent-soft:#EFEEFD;
  --green:#1E9E4A; --green-soft:#E6F6EC; --red:#E0352B; --red-soft:#FDEDEC;
  --blue:#0A84FF; --bubble:#E9E9EB;
  --shadow:0 1px 2px rgba(29,29,31,.04),0 8px 28px rgba(29,29,31,.07);
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display",Inter,"Helvetica Neue",Arial,sans-serif;
}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--ink);font-family:var(--font);-webkit-font-smoothing:antialiased}
#stage{position:absolute;left:50%;top:50%;width:1920px;height:1080px;transform-origin:center center;display:grid;grid-template-rows:84px 1fr 56px;padding:0 56px}
header{display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:12px;font-size:26px;font-weight:700;letter-spacing:-.02em}
.mark{width:34px;height:34px;border-radius:10px;background:var(--accent);position:relative}
.mark::after{content:"";position:absolute;inset:9px;border:3px solid #fff;border-right-color:transparent;border-radius:50%;transform:rotate(-40deg)}
.title{font-size:22px;font-weight:600;color:var(--muted);letter-spacing:-.01em}
.pill{font-size:15px;font-weight:600;padding:7px 14px;border-radius:999px;background:var(--card);box-shadow:var(--shadow);color:var(--muted);display:flex;align-items:center;gap:8px}
.pill .dot{width:8px;height:8px;border-radius:50%;background:var(--faint)}
.pill.live .dot{background:var(--green)}
.cols{display:grid;grid-template-columns:1fr 452px 1fr;gap:44px;min-height:0}
.col{display:flex;flex-direction:column;min-height:0}
.col h2{margin:6px 4px 14px;font-size:17px;font-weight:600;color:var(--muted);letter-spacing:-.01em}
.panel{flex:1;min-height:0;background:var(--card);border-radius:28px;box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}
.scroll{flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin}
.scroll::-webkit-scrollbar{width:6px}.scroll::-webkit-scrollbar-thumb{background:var(--hair);border-radius:3px}
footer{display:flex;align-items:center;justify-content:center;gap:18px;font-size:16px;color:var(--muted)}
footer .hint{color:var(--faint)}
.empty{color:var(--faint);font-size:17px;padding:28px}

/* Your agent */
.chat-head{display:flex;align-items:center;gap:14px;padding:20px 26px;border-bottom:1px solid var(--hair)}
.avatar{width:40px;height:40px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:17px;flex:none}
.av-agent{background:linear-gradient(135deg,#FFB340,#FF7A59);color:#fff}
.av-proxy{background:var(--accent);color:#fff}
.av-merchant{background:#E8E2D9;color:#6B5E4E}
.chat-head .name{font-size:18px;font-weight:600}
.chat-head .sub{font-size:14px;color:var(--muted)}
.chat{padding:26px 26px 34px;display:flex;flex-direction:column;gap:22px}
.you{align-self:flex-end;max-width:78%;background:#F2F2F7;border-radius:22px 22px 6px 22px;padding:14px 18px;font-size:19px;line-height:1.4}
.bot{display:flex;gap:12px;align-items:flex-start}
.bot .avatar{width:32px;height:32px;font-size:14px;margin-top:2px}
.bot-body{flex:1;min-width:0}
.bot-text{font-size:19px;line-height:1.45;margin:4px 0 12px}
.cards{display:flex;flex-direction:column;gap:10px}
.card{display:grid;grid-template-columns:44px 1fr auto;align-items:center;gap:14px;padding:13px 16px;border:1px solid var(--hair);border-radius:16px;background:#fff;transition:border-color .4s,background .4s}
.card .icon{width:44px;height:44px;border-radius:12px;background:#F2F2F7;display:grid;place-items:center;font-size:22px}
.card .what{font-size:17px;font-weight:600;letter-spacing:-.01em}
.card .when{font-size:15px;color:var(--muted);margin-top:2px}
.card .amt{font-size:17px;font-weight:600;text-align:right;font-variant-numeric:tabular-nums}
.card .amt s{color:var(--faint);font-weight:500}
.card .back{display:block;font-size:14px;font-weight:600;color:var(--green)}
.card.bad{border-color:#F3B5B0;background:var(--red-soft)}
.card.bad .when{color:var(--red);font-weight:600}
.diff{display:inline-block;margin-left:8px;padding:2px 9px;border-radius:999px;background:var(--red);color:#fff;font-size:13px;font-weight:700}
.card.fixed{background:#fff;border-color:var(--hair)}
.card.fixed .when{color:var(--muted);font-weight:500}
.card.good{border-color:#BFE6CC}
.ok{display:inline-block;margin-left:8px;padding:2px 9px;border-radius:999px;background:var(--green-soft);color:var(--green);font-size:13px;font-weight:700}
.sys{align-self:center;font-size:15px;color:var(--accent-ink);background:var(--accent-soft);padding:7px 14px;border-radius:999px}

/* Your phone */
.phone-wrap{flex:1;display:flex;align-items:flex-start;justify-content:center;min-height:0}
.phone{width:430px;height:880px;border-radius:68px;background:#1C1C1E;padding:14px;box-shadow:0 30px 60px rgba(29,29,31,.18),0 0 0 2px #3A3A3C inset}
.phone.buzz{animation:buzz .5s ease-in-out}
@keyframes buzz{0%,100%{transform:translateX(0)}20%{transform:translateX(-5px) rotate(-.4deg)}40%{transform:translateX(5px) rotate(.4deg)}60%{transform:translateX(-4px)}80%{transform:translateX(3px)}}
.screen{position:relative;height:100%;border-radius:56px;background:#fff;overflow:hidden;display:flex;flex-direction:column}
.island{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:124px;height:36px;border-radius:20px;background:#000;z-index:2}
.status{height:54px;display:flex;align-items:center;justify-content:space-between;padding:6px 34px 0 40px;font-size:17px;font-weight:600}
.glyphs{display:flex;align-items:center;gap:7px}
.bars{display:flex;align-items:flex-end;gap:2px;height:12px}.bars i{width:3px;background:var(--ink);border-radius:1px;display:block}
.batt{width:26px;height:12px;border:1.5px solid var(--ink);border-radius:4px;padding:1.5px;position:relative}.batt::after{content:"";position:absolute;right:-4px;top:3px;width:2px;height:4px;background:var(--ink);border-radius:1px}.batt i{display:block;height:100%;width:78%;background:var(--ink);border-radius:1.5px}
.im-head{display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 0 10px;border-bottom:1px solid #F0F0F2;background:rgba(249,249,250,.95)}
.im-head .avatar{width:50px;height:50px;font-size:21px}
.im-head .who{font-size:13px;color:var(--ink)}
.im-back{position:absolute;left:18px;top:74px;color:var(--blue);font-size:30px;font-weight:300}
.msgs{padding:14px 14px 10px;display:flex;flex-direction:column;gap:6px}
.when-line{align-self:center;font-size:12px;color:var(--faint);margin:6px 0 4px}
.b{max-width:80%;padding:9px 14px;border-radius:19px;font-size:16px;line-height:1.35;white-space:pre-line;overflow-wrap:anywhere}
.b.in{align-self:flex-start;background:var(--bubble);color:var(--ink);border-bottom-left-radius:6px}
.b.out{align-self:flex-end;background:var(--blue);color:#fff;border-bottom-right-radius:6px}
.b.pop{animation:pop .35s ease-out}
@keyframes pop{from{transform:scale(.92);opacity:0}to{transform:none;opacity:1}}
.delivered{align-self:flex-end;font-size:11px;color:var(--faint);margin:-2px 4px 4px}
.chips{display:flex;gap:8px;justify-content:center;padding:10px 12px 4px;flex-wrap:wrap}
.chip{font:600 15px var(--font);color:var(--blue);background:#fff;border:1.5px solid var(--blue);border-radius:999px;padding:8px 16px;cursor:pointer}
.chip:hover{background:#EEF6FF}.chip:focus-visible{outline:3px solid #9CCBFF;outline-offset:2px}
.chip.sent{background:var(--blue);color:#fff}
.compose{display:flex;align-items:center;gap:10px;padding:8px 16px 26px}
.compose .plus{width:32px;height:32px;border-radius:50%;background:#F2F2F7;display:grid;place-items:center;color:var(--muted);font-size:22px}
.compose .field{flex:1;border:1px solid var(--hair);border-radius:18px;padding:7px 14px;color:var(--faint);font-size:15px}

/* Behind the scenes */
.money{padding:26px 30px 22px;border-bottom:1px solid var(--hair)}
.money .label{font-size:16px;color:var(--muted);font-weight:600}
.money .big{display:flex;align-items:baseline;gap:12px;margin-top:4px}
.money .num{font-size:68px;font-weight:700;letter-spacing:-.035em;color:var(--green);font-variant-numeric:tabular-nums;line-height:1.05}
.money .num.zero{color:var(--ink)}
.money .of{font-size:26px;color:var(--muted);font-weight:500}
.bar{height:8px;border-radius:4px;background:#EDEDF0;margin-top:14px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--green);border-radius:4px;transition:width .9s cubic-bezier(.2,.7,.2,1)}
.money .note{font-size:14px;color:var(--muted);margin-top:10px}
.money.calm .num{color:var(--ink);font-size:44px}
.money.safe .num{color:var(--green);font-size:52px}
.items{padding:22px 24px 30px;display:flex;flex-direction:column;gap:16px}
.thread{border:1px solid var(--hair);border-radius:20px;padding:16px 16px 18px}
.thread-head{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;margin-bottom:12px}
.thread-head .avatar{width:30px;height:30px;font-size:13px}
.thread-head .sub{font-weight:500;color:var(--muted);font-size:14px;margin-left:auto}
.tm{display:flex;gap:9px;align-items:flex-end;margin-top:8px}
.tm .avatar{width:26px;height:26px;font-size:11px}
.tm .t{max-width:82%;padding:9px 13px;border-radius:16px;font-size:15.5px;line-height:1.4;background:#F2F2F7}
.tm.proxy{flex-direction:row-reverse}
.tm.proxy .t{background:var(--accent-soft);color:#24237A}
.tm .kind{display:block;font-size:12px;font-weight:700;color:var(--muted);margin-bottom:2px}
.tm.proxy .kind{color:var(--accent-ink)}
.mail{border:1px solid var(--hair);border-radius:18px;padding:14px 16px}
.mail-head{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600}
.mail-head .env{width:30px;height:30px;border-radius:9px;background:#F2F2F7;display:grid;place-items:center;font-size:15px}
.mail-line{font-size:15px;line-height:1.4;margin-top:8px;color:var(--ink)}
.mail-line .from{font-weight:600;color:var(--muted)}
.mail-line.reply{color:var(--green)}
.receipt{display:grid;grid-template-columns:1fr auto;gap:4px 12px;border-radius:16px;padding:13px 16px;background:#FAFAFB;border:1px dashed #D8D8DE}
.receipt .r-what{font-size:15px;font-weight:600}
.receipt .r-amt{font-size:20px;font-weight:700;color:var(--green);text-align:right;font-variant-numeric:tabular-nums}
.receipt .r-meta{font-size:13px;color:var(--muted)}
.receipt .r-id{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-size:12.5px;color:var(--muted)}
.tag{display:inline-block;font-size:12px;font-weight:700;padding:2px 8px;border-radius:999px;background:var(--green-soft);color:var(--green);margin-right:6px}
.tag.sim{background:#F2F2F7;color:var(--muted)}
.line{font-size:15px;color:var(--muted);padding:2px 4px}
.checking{margin:10px 0 2px 36px;border:1.5px dashed #C9C8F5;background:#FAFAFF;border-radius:14px;padding:10px 14px}
.checking .check-head{font-size:13px;font-weight:700;color:var(--accent-ink);margin-bottom:4px}
.checking .reading{font-size:14px;padding:4px 0}
.checking .why{margin-top:6px;font-size:14px;font-weight:600;color:var(--accent-ink)}
.checking:not(.done) .check-head::after{content:"";display:inline-block;width:6px;height:6px;margin-left:6px;border-radius:50%;background:var(--accent);animation:blink 1s infinite}
@keyframes blink{50%{opacity:.2}}
.tm .typed{display:block;margin-top:4px;font-size:12.5px;color:var(--muted)}
.ladder{position:sticky;top:0;z-index:1;border-radius:14px;background:#F7F7F9;padding:10px 14px;margin-bottom:6px;box-shadow:0 6px 12px -8px rgba(29,29,31,.18)}
.ladder-head{font-size:13px;font-weight:700;color:var(--muted);margin-bottom:4px}
.rung{display:grid;grid-template-columns:92px 1fr 56px 104px;align-items:center;gap:10px;font-size:14px;padding:3px 0}
.rung .rl{color:var(--muted)}
.rung .rb{height:8px;border-radius:4px;background:#EDEDF0;overflow:hidden}
.rung .rb i{display:block;height:100%;background:var(--green);border-radius:4px}
.rung .rb i.credit{background:#C7C7CC}
.rung.asked .rb i{background:var(--accent)}
.rung .ra{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.rung .rs{font-size:12.5px;font-weight:700;color:var(--muted)}
.rung.won .rs{color:var(--green)}.rung.no .rs{color:var(--red)}
.revert{border:1px solid #BFE6CC;border-radius:18px;padding:13px 16px;background:#FBFEFC}
.revert-head{display:flex;align-items:center;gap:8px;font-size:15.5px;font-weight:600;margin-bottom:4px}
.ok-dot{width:20px;height:20px;border-radius:50%;background:var(--green);color:#fff;font-size:12px;display:grid;place-items:center}
.revert .reading{font-size:14.5px;padding:4px 0}
.revert .reading.good span:last-child{color:var(--green);font-weight:600}
.revert .r-meta{display:flex;justify-content:space-between;align-items:center;margin-top:6px}
.check{border:1px solid var(--hair);border-radius:18px;padding:14px 16px}
.check-head{font-size:15px;font-weight:600;margin-bottom:8px}
.reading{display:flex;justify-content:space-between;font-size:16px;padding:6px 0;border-top:1px solid #F2F2F5}
.reading:first-of-type{border-top:0}
.reading .r{color:var(--muted)}

/* Start screen */
#start{position:absolute;inset:0;background:var(--bg);display:none;flex-direction:column;align-items:center;justify-content:center;gap:42px;z-index:5}
#start.on{display:flex}
#start h1{margin:0;font-size:54px;letter-spacing:-.035em;font-weight:700}
#start p.lead{margin:-24px 0 0;font-size:22px;color:var(--muted)}
.picks{display:grid;grid-template-columns:repeat(3,420px);gap:28px}
.pick{background:var(--card);border-radius:26px;box-shadow:var(--shadow);padding:28px 30px;display:flex;flex-direction:column;gap:10px}
.pick h3{margin:0;font-size:24px;letter-spacing:-.02em}
.pick p{margin:0;font-size:17px;line-height:1.45;color:var(--muted);min-height:74px}
.pick .row{display:flex;gap:10px;margin-top:8px}
.btn{font:600 16px var(--font);padding:10px 18px;border-radius:999px;border:0;cursor:pointer;text-decoration:none}
.btn.primary{background:var(--accent);color:#fff}
.btn.quiet{background:#F2F2F7;color:var(--ink)}
.btn:focus-visible{outline:3px solid #B9B8F3;outline-offset:2px}
#start .livelink{font-size:17px;color:var(--accent-ink)}
#ready{position:absolute;left:50%;bottom:96px;transform:translateX(-50%);background:var(--ink);color:#fff;font-size:17px;padding:10px 20px;border-radius:999px;display:none;z-index:4}
#ready.on{display:block}
@media (prefers-reduced-motion:reduce){.phone.buzz,.b.pop{animation:none}.bar i{transition:none}}
</style>
</head>
<body>
<div id="stage">
  <header>
    <div class="brand"><span class="mark" aria-hidden="true"></span>Proxy</div>
    <div class="title" id="title"></div>
    <div class="pill" id="mode"><span class="dot"></span><span id="modeText">Live</span></div>
  </header>
  <div class="cols">
    <section class="col">
      <h2>Your agent</h2>
      <div class="panel">
        <div class="chat-head"><div class="avatar av-agent" aria-hidden="true">A</div><div><div class="name">Your agent</div><div class="sub">Books and buys on your behalf</div></div></div>
        <div class="scroll" id="chatScroll"><div class="chat" id="chat"></div></div>
      </div>
    </section>
    <section class="col">
      <h2>Your phone</h2>
      <div class="phone-wrap">
        <div class="phone" id="phone">
          <div class="screen">
            <div class="island"></div>
            <div class="status"><span id="clock">9:41</span><span class="glyphs"><span class="bars"><i style="height:4px"></i><i style="height:6px"></i><i style="height:9px"></i><i style="height:12px"></i></span><span class="batt"><i></i></span></span></div>
            <div class="im-back" aria-hidden="true">&#x2039;</div>
            <div class="im-head"><div class="avatar av-proxy" aria-hidden="true">P</div><div class="who">Proxy</div></div>
            <div class="scroll" id="msgScroll"><div class="msgs" id="msgs"></div></div>
            <div class="chips" id="chips"></div>
            <div class="compose"><span class="plus" aria-hidden="true">+</span><span class="field">iMessage</span></div>
          </div>
        </div>
      </div>
    </section>
    <section class="col">
      <h2>Behind the scenes</h2>
      <div class="panel">
        <div class="money calm" id="money"><div class="label" id="moneyLabel">Watching your agent's receipts</div><div class="big"><span class="num zero" id="moneyNum">$0</span><span class="of" id="moneyOf"></span></div><div class="bar" id="moneyBar"><i></i></div><div class="note" id="moneyNote"></div></div>
        <div class="scroll" id="itemScroll"><div class="items" id="items"></div></div>
      </div>
    </section>
  </div>
  <footer><span id="scene"></span><span class="hint" id="hint"></span></footer>
  <div id="ready">Press Space to start</div>
  <div id="start">
    <h1>Proxy, the undo layer for AI agents</h1>
    <p class="lead">Pick a story. Each one runs the real orchestrator with simulated payments.</p>
    <div class="picks" id="picks"></div>
    <a class="livelink" id="liveLink" href="/web/show?live=1">Follow the live run instead</a>
  </div>
</div>
<script>
(function(){
  "use strict";
  var q=new URLSearchParams(location.search);
  var PRESENT=q.get("present")==="1";
  var SCENARIO=q.get("scenario")||"";
  var TASK=q.get("task_id")||"";
  var LIVE=!SCENARIO&&!TASK;
  var STORIES={
    trip:{title:"The wrong-date trip",blurb:"The agent books NYC for Nov 3, not Nov 13, says it's done and leaves. Proxy catches it and gets the money back.",scenes:["The ask","The agent says done","Proxy spots the mistake","The phone buzzes","The human replies","The agents negotiate","The money comes back","Rebooked for Nov 13"],talk:6},
    ambiguous:{title:"The date that reads two ways",blurb:"The human writes 3/11. Proxy asks which date they meant before anything is booked.",scenes:["The ask","The agent reads 3/11","Proxy asks before booking","The human taps 1","Booked the right dates"],talk:0},
    plan:{title:"The annual plan",blurb:"The agent signs up for the annual plan instead of monthly. Proxy cancels it, gets the refund, and the agent re-subscribes monthly.",scenes:["The ask","The agent says done","Proxy spots the annual plan","The phone buzzes","The human replies","Proxy cancels with billing","The money comes back","Re-subscribed monthly"],talk:6}
  };
  var NAMES={hotel:"Harborview Hotel's agent",transfer:"Metro Transfer support",host:"Your host",saas:"Acme Cloud billing",airline:"Skyline Demo Air"};
  var ICONS={flight:"✈️",hotel:"🏨",transfer:"🚗",message:"✉️",saas:"☁️",store:"📦"};
  var MONTHS=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  var $=function(id){return document.getElementById(id)};
  function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined&&text!==null)e.textContent=String(text);return e}
  function money(c){return "$"+Math.round((c||0)/100).toLocaleString("en-US")}
  function day(d){if(!d)return "";var m=/^(\d{4})-(\d{2})-(\d{2})/.exec(d);return m?MONTHS[+m[2]-1]+" "+(+m[3]):d}
  function range(r){if(!r||!r.start)return "";return r.end&&r.end!==r.start?day(r.start)+" to "+day(r.end):day(r.start)}
  function strip(t){t=String(t||"").replace(/^[^:]{1,60}:\s+/,"");return t.charAt(0).toUpperCase()+t.slice(1)}

  // ---- scaling: drawn at 1920x1080, fitted to the window
  function fit(){var s=Math.min(innerWidth/1920,innerHeight/1080);$("stage").style.transform="translate(-50%,-50%) scale("+s+")"}
  addEventListener("resize",fit);fit();

  // ---- state
  var feed=null, story="trip", steps=[], cursor=-1, timer=null, lastOut=0, counter={shown:0,target:0,raf:0};

  function detect(f){
    var es=f.entries||[];
    if(es.some(function(e){return e.data&&e.data.category==="saas"}))return "plan";
    if(es.some(function(e){return e.kind==="text_out"&&/^You wrote /.test(e.text)}))return "ambiguous";
    return "trip";
  }

  // ---- which scene each timeline entry belongs to
  function sceneOf(e,ctx){
    var k=e.kind;
    if(story==="ambiguous"){
      if(k==="intent")return 1;
      if(k==="mismatch")return 3;
      if(k==="text_out")return ctx.firstIn&&e.seq>ctx.firstIn?4:3;
      if(k==="text_in")return 4;
      return 5;
    }
    if(k==="intent")return 1;
    if(k==="booking"||k==="message")return 2;
    if(k==="mismatch"||k==="self_undo")return 3;
    if(k==="stripe_refund")return ctx.firstAlert&&e.seq>ctx.firstAlert?7:3;
    if(k==="text_in")return 5;
    if(k==="text_out"){
      if(e.data&&e.data.alert==="chain_opened")return 4;
      if(!ctx.firstIn||e.seq<ctx.firstIn)return 4;
      if(/^Got it/.test(e.text))return 5;
      if(/^Rebooked|^Re-subscribed/.test(e.text))return 8;
      if(/refunded|All done/i.test(e.text))return 7;
      return 6;
    }
    if(k==="protocol_out"||k==="protocol_in"||k==="email_out"||k==="email_in")return 6;
    if(k==="redo"||k==="chain")return 8;
    return 6;
  }
  function context(es){
    var c={firstAlert:0,firstIn:0};
    es.forEach(function(e){
      if(!c.firstAlert&&e.kind==="text_out"&&e.data&&e.data.alert==="chain_opened")c.firstAlert=e.seq;
      if(!c.firstIn&&e.kind==="text_in")c.firstIn=e.seq;
    });
    return c;
  }
  /** Steps for presenting: one per scene, except the conversation scene, where every message is its own step. */
  function buildSteps(f){
    var es=(f.entries||[]).slice().sort(function(a,b){return a.seq-b.seq});
    var ctx=context(es), S=STORIES[story], out=[];
    for(var s=1;s<=S.scenes.length;s++){
      var list=es.filter(function(e){return sceneOf(e,ctx)===s});
      if(s===S.talk){list.forEach(function(e){
        // Present mode: "Proxy is checking" gets its own step before each of Proxy's decisions.
        if(e.kind==="protocol_out"&&e.data&&e.data.why)out.push({scene:s,seqs:[],checks:[e.seq]});
        out.push({scene:s,seqs:[e.seq],checks:e.kind==="protocol_out"?[e.seq]:[]});
      });continue}
      if(list.length||(story==="ambiguous"&&s===2))out.push({scene:s,seqs:list.map(function(e){return e.seq})});
    }
    return out;
  }

  // ---- what is visible now
  function visible(){
    var es=(feed&&feed.entries||[]).slice().sort(function(a,b){return a.seq-b.seq});
    if(LIVE&&!PRESENT){var all={};es.forEach(function(e){all[e.seq]=1});return {entries:es,scene:liveScene(es),checks:all}}
    var shown={}, checks={}, scene=0;
    for(var i=0;i<=cursor&&i<steps.length;i++){steps[i].seqs.forEach(function(n){shown[n]=1});(steps[i].checks||[]).forEach(function(n){checks[n]=1});scene=steps[i].scene}
    return {entries:es.filter(function(e){return shown[e.seq]}),scene:scene,checks:checks};
  }
  function liveScene(es){var ctx=context(es),m=0;es.forEach(function(e){m=Math.max(m,sceneOf(e,ctx))});return m}

  // ---- render
  function render(){
    if(!feed)return;
    var v=visible(), es=v.entries, S=STORIES[story];
    $("title").textContent=S.title;
    var byId={};(feed.bookings||[]).forEach(function(b){byId[b.id]=b});
    var refunded={}, corrected={};
    es.forEach(function(e){
      if(e.kind==="stripe_refund")refunded[e.data.action_id]=Number(e.data.amount||0);
      if(e.kind==="email_out"&&e.data&&e.data.correction)corrected[e.data.action_id]=1;
    });
    var spotted=es.some(function(e){return e.kind==="mismatch"||(e.kind==="text_out"&&e.data&&e.data.alert==="chain_opened")});
    renderChat(es,v.scene,byId,refunded,corrected,spotted);
    renderPhone(es);
    renderMoney(es,spotted,byId);
    renderItems(es,v.checks||{},byId);
    var n=S.scenes.length;
    $("scene").textContent=v.scene?"Scene "+v.scene+" of "+n+": "+S.scenes[v.scene-1]:(LIVE&&!PRESENT?"Waiting for your agent":"Ready");
    $("hint").textContent=PRESENT?(cursor<steps.length-1?"Space or → to continue, ← to go back":"End of the story. ← to go back"):"";
    $("ready").className=PRESENT&&cursor<0?"on":"";
  }

  function card(b,opts){
    var c=el("div","card"), icon=el("div","icon",ICONS[b.category]||"•"), mid=el("div"), amt=el("div","amt");
    // The line below shows the dates, so the title drops a trailing " · Nov 3" or " · Nov 3 to Nov 6".
    mid.appendChild(el("div","what",(b.category==="saas"?"Team plan · "+String(b.summary||"").replace(/^Saas · /i,""):String(b.summary||"")).replace(/\s·\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?: to (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})?$/,"")));
    var annual=/annual|yearly/i.test(String(b.raw||b.summary));
    var when=el("div","when",b.category==="saas"?(annual?"Billed annually":"Billed monthly"):range(b.dates));
    mid.appendChild(when);
    if(b.category==="message"){amt.textContent=opts.corrected?"Corrected":"Sent";if(opts.corrected)amt.style.color="var(--green)"}
    else if(opts.refunded!==undefined){var s=el("s",null,money(b.amount));amt.appendChild(s);amt.appendChild(el("span","back","Refunded "+money(opts.refunded)))}
    else amt.textContent=money(b.amount);
    if(opts.bad){
      c.className+=opts.refunded!==undefined||opts.corrected?" bad fixed":" bad";
      var want=feed.task&&feed.task.intended_dates;
      var diff=b.category==="saas"?"Annual ≠ Monthly":(want&&b.dates?day(b.dates.start)+" ≠ "+day(want.start):"Doesn't match");
      when.appendChild(el("span","diff",diff));
    }
    if(opts.good){c.className+=" good";when.appendChild(el("span","ok",b.category==="saas"?"Monthly ✓":day(b.dates&&b.dates.start)+" ✓"))}
    c.appendChild(icon);c.appendChild(mid);c.appendChild(amt);
    return c;
  }
  function bot(text,cards){
    var w=el("div","bot"), body=el("div","bot-body");
    w.appendChild(el("div","avatar av-agent","A"));
    body.appendChild(el("div","bot-text",text));
    if(cards&&cards.length){var cs=el("div","cards");cards.forEach(function(c){cs.appendChild(c)});body.appendChild(cs)}
    w.appendChild(body);return w;
  }
  function renderChat(es,scene,byId,refunded,corrected,spotted){
    var chat=$("chat"), frag=document.createDocumentFragment();
    var intent=es.filter(function(e){return e.kind==="intent"})[0];
    if(!intent){chat.replaceChildren(el("div","empty","Waiting for your agent's first message."));return}
    var d=intent.data||{};
    frag.appendChild(el("div","you",d.request||("Book my "+String(d.goal||"").replace(/^[A-Z](?=[a-z])/,function(c){return c.toLowerCase()}))));
    var made=es.filter(function(e){return e.kind==="booking"||e.kind==="message"});
    var redo=es.filter(function(e){return e.kind==="redo"});
    var asB=function(e){var b=byId[e.data.action_id];if(b)return Object.assign({raw:e.text},b);return {raw:e.text,id:e.data.action_id,category:e.data.category,summary:strip(e.text),amount:Number(e.data.amount||0),dates:e.data.start?{start:e.data.start,end:e.data.end||undefined}:undefined}};
    if(story==="ambiguous"){
      var showRead=(LIVE&&!PRESENT)||scene>=2;
      if(showRead)frag.appendChild(bot("On it. I read that as "+range({start:d.start,end:d.end})+", so I'll book that."));
      if(es.some(function(e){return e.kind==="mismatch"}))frag.appendChild(el("div","sys","Proxy told your agent to wait while it checks the date with you"));
      if(made.length){
        var end=made.filter(function(e){return e.data.end})[0];
        frag.appendChild(bot("Done! Booked for "+range({start:made[0].data.start,end:end?end.data.end:undefined})+" ✅",made.map(function(e){return card(asB(e),{good:true})})));
      }
    }else{
      if(made.length){
        frag.appendChild(bot("Done! Here's what I "+(story==="plan"?"signed you up for":"booked")+" ✅",made.map(function(e){
          var b=asB(e);return card(b,{bad:spotted&&b.wrong!==false,refunded:refunded[b.id],corrected:corrected[b.id]});
        })));
      }
      if(redo.length){
        var dates=feed.task&&feed.task.intended_dates;
        var msg=story==="plan"?"Re-subscribed on the monthly plan ✅":"Rebooked for "+range(dates)+" ✅";
        frag.appendChild(bot(msg,redo.map(function(e){return card(asB(e),{good:true})})));
      }
    }
    chat.replaceChildren(frag);
    follow($("chatScroll"));
  }

  function renderPhone(es){
    var box=$("msgs"), frag=document.createDocumentFragment(), texts=es.filter(function(e){return e.kind==="text_out"||e.kind==="text_in"});
    if(texts.length)frag.appendChild(el("div","when-line","Today "+clock(texts[0].at)));
    var outs=0, lastIn=-1;
    texts.forEach(function(e,i){if(e.kind==="text_in")lastIn=i});
    texts.forEach(function(e,i){
      var mine=e.kind==="text_in";
      var b=el("div","b "+(mine?"out":"in"),mine?e.text.replace(/^Human:\s*/,""):e.text);
      if(!mine)outs++;
      if(i===texts.length-1&&(!mine&&outs>lastOut))b.className+=" pop";
      frag.appendChild(b);
      if(mine&&i===lastIn)frag.appendChild(el("div","delivered",e.data&&e.data.via==="imessage"&&LIVE?"Sent from iPhone":"Delivered"));
    });
    box.replaceChildren(frag);
    if(outs>lastOut&&lastOut>=0&&texts.length){var p=$("phone");p.classList.remove("buzz");void p.offsetWidth;p.classList.add("buzz")}
    lastOut=outs;
    var last=es.length?es[es.length-1]:null;
    $("clock").textContent=last?clock(last.at):"9:41";
    renderChips(texts);
    follow($("msgScroll"));
  }
  function clock(at){try{return new Date(at).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZone:"America/New_York"}).replace(/\s?[AP]M$/,"")}catch(e){return "9:41"}}
  function renderChips(texts){
    var chips=$("chips"), last=texts[texts.length-1], opts=[];
    if(last&&last.kind==="text_out"){
      if(last.data&&last.data.alert==="chain_opened")opts=[["UNDO ALL","undo_all"],["PICK","pick"],["KEEP","keep"]];
      else if(/Reply 1 or 2/.test(last.text))opts=[["1","choice1"],["2","choice2"]];
    }
    if(PRESENT&&opts.length){var next=steps[cursor+1];if(!next||!next.seqs.some(function(n){return feed.entries.some(function(e){return e.seq===n&&e.kind==="text_in"})}))opts=[]}
    chips.replaceChildren.apply(chips,opts.map(function(o){
      var b=el("button","chip",o[0]);b.type="button";
      b.addEventListener("click",function(){reply(o[1],b)});
      return b;
    }));
  }
  function reply(kind,btn){
    if(PRESENT){advance(1);return}
    btn.classList.add("sent");
    var body=kind.indexOf("choice")===0?{kind:"choice",choice:Number(kind.slice(6))}:{kind:kind,chain_id:feed.chain&&feed.chain.chain_id};
    fetch("/web/reply",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(function(r){if(!r.ok)btn.classList.remove("sent");return poll()}).catch(function(){btn.classList.remove("sent")});
  }

  function renderMoney(es,spotted,byId){
    var box=$("money");
    if(story==="ambiguous"){
      var asked=es.some(function(e){return e.kind==="text_out"&&/^You wrote /.test(e.text)});
      box.className="money "+(asked?"safe":"calm");
      $("moneyLabel").textContent=asked?"Caught before booking":"Checking your words against the plan";
      $("moneyNum").textContent=asked?"$0 at risk":"…";$("moneyNum").className="num"+(asked?"":" zero");
      $("moneyOf").textContent="";$("moneyBar").style.display="none";
      $("moneyNote").textContent=asked?"Proxy asked before your agent booked anything.":"";
      return;
    }
    $("moneyBar").style.display="";
    var made=es.filter(function(e){return e.kind==="booking"||e.kind==="message"});
    var total=made.reduce(function(t,e){return t+Number(e.data.amount||0)},0);
    var back=es.filter(function(e){return e.kind==="stripe_refund"}).reduce(function(t,e){return t+Number(e.data.amount||0)},0);
    if(!spotted){
      box.className="money calm";$("moneyLabel").textContent="Watching your agent's receipts";
      setCount(0,true);$("moneyNum").textContent=made.length?money(total):"$0";$("moneyNum").className="num zero";
      $("moneyOf").textContent=made.length?"booked":"";$("moneyBar").firstChild.style.width="0";$("moneyNote").textContent="";
      return;
    }
    box.className="money";$("moneyLabel").textContent="Recovered";$("moneyNum").className="num"+(back?"":" zero");
    $("moneyOf").textContent="of "+money(total);
    $("moneyBar").firstChild.style.width=(total?Math.round(back/total*100):0)+"%";
    var sim=es.some(function(e){return e.kind==="stripe_refund"&&/simulated/i.test(e.text)});
    var done=es.some(function(e){return e.kind==="redo"});
    $("moneyNote").textContent=back?(sim?"Simulated payments: no real money moved.":"Every dollar here is confirmed in Stripe.")+(done?" The agent redid the task correctly.":""):"Proxy found the mistake. Nothing is back yet.";
    setCount(back,false);
  }
  function setCount(target,instant){
    if(instant){counter.shown=counter.target=target;return}
    if(target===counter.target)return;
    var from=counter.shown,start=performance.now(),dur=matchMedia("(prefers-reduced-motion: reduce)").matches?0:1100;
    counter.target=target;cancelAnimationFrame(counter.raf);
    (function tick(now){
      var t=dur?Math.min(1,(now-start)/dur):1, e=1-Math.pow(1-t,3);
      counter.shown=Math.round(from+(target-from)*e);
      $("moneyNum").textContent=money(counter.shown);
      if(t<1)counter.raf=requestAnimationFrame(tick);
    })(start);
  }

  function dur(ms){if(ms===null||ms===undefined||!isFinite(ms))return "";if(ms<=0)return "closed";var m=Math.round(ms/60000),h=Math.floor(m/60);return h>=48?Math.round(h/24)+" days":h?h+"h "+(m%60)+"m":m+"m"}
  function pctOf(a,b){return b?Math.round(a*100/b):0}
  function wrongWhy(b){
    if(!b)return "";
    if(b.category==="saas")return "Annual plan, not monthly";
    var want=feed.task&&feed.task.intended_dates;
    return want&&b.dates?"Wrong dates: "+day(b.dates.start)+", not "+day(want.start):"Doesn't match the request";
  }
  function titleOf(b){return b?String(b.summary||"").replace(/\s·\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?: to .*)?$/,""):""}
  function row2(label,value,cls){var r=el("div","reading"+(cls?" "+cls:""));r.appendChild(el("span","r",label));r.appendChild(el("span",null,value));return r}

  /** "Proxy is checking": the human's rules against the offer on the table, before Proxy answers. Typed fields only. */
  function checking(e,done,byId){
    var d=e.data||{}, c=el("div","checking"+(done?" done":""));
    c.appendChild(el("div","check-head",done?"Proxy checked":"Proxy is checking…"));
    var amt=Number(d.order_amount||0), offer=d.offer_amount===null||d.offer_amount===undefined?null:Number(d.offer_amount);
    if(d.type==="request_reversal"){
      c.appendChild(row2("Matches your request","❌ "+wrongWhy(byId[d.action_id])));
      c.appendChild(row2("Evidence","✅ request, receipt, timeline"));
    }else if(d.offer_kind==="store_credit"){
      c.appendChild(row2("On the table","Store credit "+money(offer)));
      c.appendChild(row2("No store credit",d.no_store_credit?"❌ you don't accept it":"✅ you allow it"));
    }else if(offer!==null){
      var p=pctOf(offer,amt);
      c.appendChild(row2("On the table",money(offer)+" refund ("+p+"%)"));
      c.appendChild(row2("Your minimum "+d.min_pct+"%",(p>=Number(d.min_pct)?"✅ ":"❌ ")+p+"% offered"));
      if(d.decision==="anchor")c.appendChild(row2("Rounds","✅ round "+d.round+" of 4, one left to accept"));
    }
    var left=dur(d.time_left_ms);
    if(left)c.appendChild(row2("Time left",left));
    if(done&&d.why)c.appendChild(el("div","why",String(d.why)));
    return c;
  }

  /** The offers so far, as a ladder: what Proxy asked for, then each counter and what Proxy did with it. */
  function ladder(list){
    var asked=list.filter(function(e){return e.kind==="protocol_out"&&e.data.type==="request_reversal"})[0];
    if(!asked)return null;
    var full=Number(asked.data.order_amount||0), box=el("div","ladder");
    box.appendChild(el("div","ladder-head","Offers"));
    var add=function(label,amount,kind,status,cls){
      var r=el("div","rung"+(cls?" "+cls:""));r.appendChild(el("span","rl",label));
      var bar=el("span","rb"),fill=el("i",kind==="store_credit"?"credit":null);fill.style.width=Math.max(4,pctOf(amount,full))+"%";bar.appendChild(fill);r.appendChild(bar);
      r.appendChild(el("span","ra",money(amount)));r.appendChild(el("span","rs",status));box.appendChild(r);
    };
    add("Proxy asked",full,"refund","Full refund","asked");
    list.forEach(function(e,i){
      if(e.kind!=="protocol_in"||e.data.type!=="counter")return;
      var next=list.slice(i+1).filter(function(x){return x.kind==="protocol_out"})[0];
      var dec=next?(next.data.decision||next.data.type):null;
      var a=Number(e.data.amount||0), credit=e.data.kind==="store_credit";
      var status=!next?"On the table":dec==="store_credit"?"Declined":dec==="anchor"?"Asked for more":dec==="below_minimum"?"Too low":dec==="accept_counter"?"Accepted":"";
      add(credit?"Store credit":pctOf(a,full)+"% refund",a,credit?"store_credit":"refund",status,dec==="accept_counter"?"won":dec==="store_credit"||dec==="below_minimum"?"no":"");
    });
    return box;
  }

  /** When a merchant is finished: what was reverted, how and why, with its receipt. */
  function reverted(e,es,byId){
    var d=e.data||{}, b=byId[d.action_id], m=d.merchant, c=el("div","revert");
    var head=el("div","revert-head");head.appendChild(el("span","ok-dot","✓"));head.appendChild(el("span",null,(e.kind==="stripe_refund"?"Reverted: ":"Corrected: ")+titleOf(b)));c.appendChild(head);
    if(e.kind==="stripe_refund"){
      var before=b?(b.category==="saas"?"Annual plan, ":(range(b.dates)?range(b.dates)+", ":""))+money(b.amount):"";
      c.appendChild(row2("Before",before));
      c.appendChild(row2("After","Cancelled, "+money(d.amount)+" back"+(d.of&&d.of!==d.amount?" of "+money(d.of):""),"good"));
      var rounds=es.filter(function(x){return x.kind==="protocol_out"&&x.data.merchant===m}).reduce(function(t,x){return Math.max(t,Number(x.data.round||0))},0);
      var how=m==="airline"?"Your agent cancelled it itself, free under the 24-hour rule":rounds?"Negotiated agent to agent, "+rounds+" rounds":"Proxy emailed support";
      c.appendChild(row2("How",how));
      c.appendChild(row2("Why",wrongWhy(b)));
      var sim=/simulated/i.test(e.text), rc=el("div","r-meta");
      rc.appendChild(el("span","tag"+(sim?" sim":""),sim?"Simulated payment":"Verified in Stripe"));
      rc.appendChild(el("span","r-id",d.refund_id?String(d.refund_id).slice(0,8)+"…":""));
      c.appendChild(rc);
    }else{
      c.appendChild(row2("Before","Said "+(b&&b.dates?day(b.dates.start):"the wrong date")));
      var want=feed.task&&feed.task.intended_dates;
      c.appendChild(row2("After","Told "+range(want),"good"));
      c.appendChild(row2("How","Correction email"));
      c.appendChild(row2("Why",wrongWhy(b)));
    }
    return c;
  }

  function renderItems(es,checks,byId){
    var box=$("items"), frag=document.createDocumentFragment(), groups={}, any=false;
    var shown={};es.forEach(function(e){shown[e.seq]=1});
    var all=(feed.entries||[]).slice().sort(function(a,b){return a.seq-b.seq});
    // Every entry Proxy checked before answering: its check card comes first, then (once shown) the message itself.
    var items=all.filter(function(e){return shown[e.seq]||(checks[e.seq]&&e.kind==="protocol_out")});
    items.forEach(function(e){
      var k=e.kind, d=e.data||{}, m=d.merchant;
      if(k==="protocol_out"||k==="protocol_in"){
        var g=groups["t"+m];
        if(!g){
          g=groups["t"+m]={box:el("div","thread"),list:[]};
          var h=el("div","thread-head");h.appendChild(el("div","avatar av-merchant",(NAMES[m]||m).charAt(0)));h.appendChild(el("span",null,"Proxy and "+(NAMES[m]||m)));h.appendChild(el("span","sub","Agent to agent"));
          g.box.appendChild(h);g.ladderSlot=el("div");g.box.appendChild(g.ladderSlot);frag.appendChild(g.box);
        }
        var proxy=k==="protocol_out";
        if(proxy&&d.why&&checks[e.seq])g.box.appendChild(checking(e,!!shown[e.seq],byId));
        if(!shown[e.seq])return;
        g.list.push(e);
        var row=el("div","tm"+(proxy?" proxy":""));
        row.appendChild(el("div","avatar "+(proxy?"av-proxy":"av-merchant"),proxy?"P":(NAMES[m]||m).charAt(0)));
        var t=el("div","t");t.appendChild(el("span","kind",proxy?"Proxy":NAMES[m]||m));
        // The merchant's own line is display only; the typed offer underneath is what Proxy acted on.
        t.appendChild(document.createTextNode(proxy?strip(e.text):(d.said||strip(e.text))));
        if(!proxy&&d.said)t.appendChild(el("span","typed","Read by Proxy: "+strip(e.text)));
        row.appendChild(t);g.box.appendChild(row);any=true;
      }else if(k==="email_out"||k==="email_in"){
        var mg=groups["m"+m];
        if(!mg){mg=groups["m"+m]=el("div","mail");var mh=el("div","mail-head");mh.appendChild(el("span","env","✉️"));mh.appendChild(el("span",null,(d.correction?"Correction to ":"Email to ")+(NAMES[m]||m)));mg.appendChild(mh);frag.appendChild(mg)}
        var line=el("div","mail-line"+(k==="email_in"?" reply":""));
        line.appendChild(el("span","from",k==="email_out"?"Proxy: ":(NAMES[m]||m)+": "));line.appendChild(document.createTextNode(strip(e.text)));
        mg.appendChild(line);any=true;
        if(k==="email_in"&&d.correction&&d.approved)frag.appendChild(reverted(e,es,byId));
      }else if(k==="stripe_refund"){
        frag.appendChild(reverted(e,es,byId));any=true;
      }else if(k==="mismatch"&&story==="ambiguous"){
        var c=el("div","check");c.appendChild(el("div","check-head","Intent check: your words against the plan"));
        var said=String(d.said||""), agent=String(d.understood||"");
        var rows=[["You wrote",said.replace(/\s*\(.*$/,"")],["Your agent read",agent],["It could also mean",(said.match(/\((.*)\)/)||["",""])[1].replace(agent.replace(/ to .*/,""),"").replace(/^ or | or $/,"")]];
        var got=es.filter(function(x){return x.kind==="text_out"&&/^Got it: /.test(x.text)})[0];
        if(got)rows.push(["You meant",got.text.replace(/^Got it: /,"").replace(/\. .*$/,"")+" ✅"]);
        rows.forEach(function(x){c.appendChild(row2(x[0],x[1]))});
        frag.appendChild(c);any=true;
      }
    });
    Object.keys(groups).forEach(function(key){var g=groups[key];if(g.ladderSlot){var l=ladder(g.list);if(l)g.ladderSlot.replaceWith(l)}});
    if(!any)frag.appendChild(el("div","empty",story==="ambiguous"?"Proxy reads the human's own words and checks them against what the agent logged.":"Merchant conversations, emails and refunds show up here."));
    box.replaceChildren(frag);
    follow($("itemScroll"));
  }
  function follow(sc){sc.scrollTop=sc.scrollHeight}

  // ---- presenting
  function advance(n){
    var next=Math.max(-1,Math.min(steps.length-1,cursor+n));
    if(next===cursor)return;
    cursor=next;render();
  }
  if(PRESENT)addEventListener("keydown",function(e){
    if(e.key===" "||e.key==="ArrowRight"||e.key==="PageDown"){e.preventDefault();advance(1)}
    else if(e.key==="ArrowLeft"||e.key==="PageUp"){e.preventDefault();advance(-1)}
  });

  // ---- loading
  function setMode(text,live){$("modeText").textContent=text;$("mode").className="pill"+(live?" live":"")}
  function feedUrl(task){return "/demo/feed"+(task?"?task_id="+encodeURIComponent(task):"")}
  function load(f){feed=f;story=SCENARIO&&STORIES[SCENARIO]?SCENARIO:detect(f);steps=buildSteps(f)}
  function poll(){
    return fetch(feedUrl(TASK),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(f){
      if(!f||!f.ok){if(!feed)showStart();return}
      var fresh=!feed;load(f);
      if(fresh&&!(f.entries||[]).length&&!q.get("live"))showStart();
      render();
    }).catch(function(){});
  }
  function showStart(){
    var picks=$("picks");
    if(!picks.children.length)Object.keys(STORIES).forEach(function(k){
      var S=STORIES[k], p=el("div","pick");
      p.appendChild(el("h3",null,S.title));p.appendChild(el("p",null,S.blurb));
      var row=el("div","row"), a=el("a","btn primary","Present");a.href="/web/show?present=1&scenario="+k;
      var b=el("a","btn quiet","Play");b.href="/web/show?scenario="+k;
      row.appendChild(a);row.appendChild(b);p.appendChild(row);picks.appendChild(p);
    });
    $("start").className="on";
  }
  function recording(){
    var name=STORIES[SCENARIO]?SCENARIO:"trip";
    setMode(PRESENT?"Presenting":"Replay",false);
    var task=TASK?Promise.resolve(TASK):fetch("/web/show/run?scenario="+name,{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){if(!j.ok)throw new Error(j.message);return j.task_id});
    return task.then(function(t){return fetch(feedUrl(t),{cache:"no-store"})}).then(function(r){return r.json()}).then(function(f){
      if(!f.ok)throw new Error(f.message||"no feed");
      load(f);cursor=PRESENT?-1:0;render();
      if(!PRESENT)timer=setInterval(function(){if(cursor>=steps.length-1){clearInterval(timer);return}advance(1)},2200);
    }).catch(function(e){$("chat").replaceChildren(el("div","empty","Could not load the "+name+" story: "+(e&&e.message||e)))});
  }

  if(LIVE&&!PRESENT){setMode("Live",true);poll();setInterval(poll,1000)}
  else if(LIVE&&PRESENT){
    // Presenting the live run: everything that has happened so far, one step at a time.
    setMode("Presenting",false);
    fetch(feedUrl(""),{cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(f){if(!f||!f.ok||!(f.entries||[]).length){showStart();return}load(f);cursor=-1;render()});
  }
  else recording();
})();
</script>
</body>
</html>
`;
