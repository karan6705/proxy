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
.steps{display:flex;gap:8px;margin-top:14px}
.steps:empty{display:none}
.step{flex:1;min-width:0;border:1px solid var(--hair);border-radius:12px;padding:8px 10px;background:#fff}
.st-head{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700}
.step .n{width:20px;height:20px;border-radius:50%;background:#F2F2F7;color:var(--muted);font-size:12px;display:grid;place-items:center;flex:none}
.st-sub{font-size:12.5px;color:var(--muted);margin-top:3px;line-height:1.3}
.step.active{border-color:var(--accent);background:var(--accent-soft)}
.step.active .n{background:var(--accent);color:#fff}
.step.active .st-sub{color:var(--accent-ink);font-weight:600}
.step.done{border-color:#BFE6CC;background:var(--green-soft)}
.step.done .n{background:var(--green);color:#fff}
.step.done .st-sub{color:var(--green);font-weight:600}
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
.card .amt .credit-back{color:var(--muted)}
.card .who{font-size:13px;color:var(--green);margin-top:3px;font-weight:500}
.waiting{display:flex;align-items:center;gap:10px;font-size:15px;color:var(--muted);padding:6px 6px}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid #D8D8DE;border-top-color:var(--accent);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.tm.typing .dots{letter-spacing:2px;color:var(--muted);animation:blink 1.2s infinite}
.ladder{position:sticky;top:12px;z-index:2;border-radius:14px;background:#F7F7F9;padding:10px 14px;margin-bottom:6px;box-shadow:0 -14px 0 0 var(--card),0 6px 12px -8px rgba(29,29,31,.18)}
.ladder-head{font-size:13px;font-weight:700;color:var(--muted);margin-bottom:4px}
.ladder.settled{position:static;box-shadow:none}
.asked-card{margin:10px 0 2px 36px;border:1.5px solid #C9C8F5;background:#FAFAFF;border-radius:14px;padding:10px 14px}
.asked-card .check-head{font-size:13px;font-weight:700;color:var(--accent-ink);margin-bottom:6px}
.opt{display:flex;align-items:center;gap:10px;font-size:15px;padding:5px 0}
.opt .on{width:22px;height:22px;border-radius:50%;background:#F2F2F7;display:grid;place-items:center;font-size:12px;font-weight:700;color:var(--muted)}
.opt.rec .on{background:var(--accent);color:#fff}
.opt .star{margin-left:auto;font-size:12px;font-weight:700;color:var(--accent-ink)}
.opt-note{font-size:13px;color:var(--muted);margin-top:4px}
.chose{display:flex;align-items:center;gap:8px;margin:8px 0 2px 36px;font-size:15px;font-weight:600;color:var(--green)}
.revert.credit{border-color:#D8D8DE;background:#FAFAFB}
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

/* The store story: a merchant's web return form, its label and the carrier's scan */
.wform{border:1px solid var(--hair);border-radius:18px;overflow:hidden}
.wform .wbar{display:flex;align-items:center;gap:6px;padding:8px 12px;background:#F2F2F7}
.wform .wbar i{width:9px;height:9px;border-radius:50%;background:#D1D1D6;display:inline-block}
.wform .url{flex:1;margin-left:8px;background:#fff;border-radius:8px;padding:4px 10px;font:13px ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted)}
.wform .wbody{padding:14px 16px 16px}
.wform h4{margin:0 0 4px;font-size:17px;letter-spacing:-.01em}
.fld{margin-top:10px}
.fld .fl{font-size:12.5px;font-weight:600;color:var(--muted);margin-bottom:4px}
.fld .in{display:flex;align-items:center;justify-content:space-between;gap:8px;border:1.5px solid var(--hair);border-radius:10px;padding:8px 11px;font-size:15px;min-height:38px;background:#fff}
.fld .in.empty{background:#FAFAFB}
.fld.on .in{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.fld .caret{display:inline-block;width:2px;height:17px;margin-left:2px;vertical-align:-3px;background:var(--accent);animation:blink 1s infinite}
.fld .chev{color:var(--muted);font-size:16px;line-height:1}
.wform .submit{margin-top:14px;text-align:center;border-radius:12px;padding:10px;font-size:15px;font-weight:600;background:#E5E5EA;color:var(--muted)}
.wform .submit.go{background:var(--accent);color:#fff}
.wform .submit.done{background:var(--green);color:#fff}
.wform .submit.no{background:var(--red);color:#fff}
.rlabel{display:grid;grid-template-columns:1fr 132px;gap:16px;align-items:center;border:2px dashed #C7C7CC;border-radius:16px;padding:14px 16px;background:#FFFEF7}
.rlabel .carrier{font-size:13px;font-weight:800;letter-spacing:.08em;color:var(--muted)}
.rlabel .rma{font:700 24px ui-monospace,"SF Mono",Menlo,monospace;margin:4px 0 6px;letter-spacing:.02em}
.rlabel .meta{font-size:14px;color:var(--muted);line-height:1.5}
.rlabel .meta b{color:var(--ink)}
.rlabel svg{width:132px;height:132px;display:block}
.track{border:1px solid var(--hair);border-radius:18px;padding:12px 16px}
.track .ev{display:grid;grid-template-columns:18px 1fr;gap:8px;font-size:15px;padding:5px 0}
.track .ev .dot{width:10px;height:10px;border-radius:50%;background:var(--green);margin-top:5px}
.track .ev .dot.grey{background:#C7C7CC}
.track .ev .t2{display:block;color:var(--muted);font-size:13px}

/* Start screen */
#start{position:absolute;inset:0;background:var(--bg);display:none;flex-direction:column;align-items:center;justify-content:center;gap:42px;z-index:5}
#start.on{display:flex}
#start h1{margin:0;font-size:54px;letter-spacing:-.035em;font-weight:700}
#start p.lead{margin:-24px 0 0;font-size:22px;color:var(--muted)}
.picks{display:grid;grid-template-columns:repeat(4,404px);gap:24px}
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
        <div class="money calm" id="money"><div class="label" id="moneyLabel">Watching your agent's receipts</div><div class="big"><span class="num zero" id="moneyNum">$0</span><span class="of" id="moneyOf"></span></div><div class="bar" id="moneyBar"><i></i></div><div class="note" id="moneyNote"></div><div class="steps" id="steps"></div></div>
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
    trip:{title:"The wrong-date trip",blurb:"The agent books NYC for Nov 3, not Nov 13, says it's done and leaves. Proxy catches it and gets the money back.",scenes:["The ask","The agent says done","Proxy spots the mistake","The phone buzzes","The human replies","The agents negotiate","You choose the offer","The money comes back","Rebooked for Nov 13"],talk:6,choose:7,money:8,redo:9},
    "trip-dmy":{title:"11/3: the date that means two things",blurb:"The human writes 11/3 meaning 11 March. The agent books Nov 3 without waiting; Proxy asks, hears Mar 11, and undoes it all.",scenes:["The ask","The agent books Nov 3","Proxy asks: Nov 3 or Mar 11?","The phone buzzes","The human replies","The agents negotiate","You choose the offer","The money comes back","Rebooked for Mar 11"],talk:6,choose:7,money:8,redo:9},
    ambiguous:{title:"The date that reads two ways",blurb:"The human writes 3/11. Proxy asks which date they meant before anything is booked.",scenes:["The ask","The agent reads 3/11","Proxy asks before booking","The human taps 1","Booked the right dates"],talk:0},
    store:{title:"The wrong charger",blurb:"The agent orders a USB-A 20W charger, not USB-C 65W. Proxy returns it like a person would: chat, form, label, refund.",scenes:["The ask","The agent says ordered","Proxy spots the wrong item","The phone buzzes","The human replies","The support chat","The return form","The return label","The drop-off scan","The money comes back","The right charger"],talk:6,each:[7]},
    plan:{title:"The annual plan",blurb:"The agent signs up for the annual plan instead of monthly. Proxy cancels it, gets the refund, and the agent re-subscribes monthly.",scenes:["The ask","The agent says done","Proxy spots the annual plan","The phone buzzes","The human replies","Proxy cancels with billing","The money comes back","Re-subscribed monthly"],talk:6,money:7,redo:8}
  };
  var NAMES={northwind:"Northwind Market support",hotel:"Harborview Hotel's agent",transfer:"Metro Transfer support",host:"Your host",saas:"Acme Cloud billing",airline:"Skyline Demo Air"};
  var STORE_NAMES={northwind:"Northwind Market"};
  /** Merchants that are our own simulation, even on the live server: labelled "Simulated store" wherever they appear. */
  var SIMULATED={northwind:true};
  function simTag(){return el("span","tag sim","Simulated store")}
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
  var credited={};
  var feed=null, story="trip", steps=[], cursor=-1, timer=null, lastOut=0, counter={shown:0,target:0,raf:0}, howBy={}, items={}, itemDiff=null;

  function detect(f){
    var es=f.entries||[];
    if(es.some(function(e){return e.data&&e.data.category==="saas"}))return "plan";
    if(es.some(function(e){return e.data&&e.data.category==="store"}))return "store";
    var askedDate=es.some(function(e){return e.kind==="text_out"&&/^You wrote /.test(e.text)});
    // trip-dmy: the agent booked before the date was confirmed (bookings before the human's first reply), or the alert is out.
    var firstIn=es.filter(function(e){return e.kind==="text_in"}).reduce(function(m,e){return m&&m<e.seq?m:e.seq},0);
    var bookedFirst=es.some(function(e){return (e.kind==="booking"||e.kind==="message")&&(!firstIn||e.seq<firstIn)});
    if(askedDate&&(bookedFirst||es.some(function(e){return e.data&&e.data.alert==="chain_opened"})))return "trip-dmy";
    if(askedDate)return "ambiguous";
    return "trip";
  }

  // ---- which scene each timeline entry belongs to
  function sceneOf(e,ctx){
    var k=e.kind;
    if(story==="store"){
      if(k==="wait")return 0;
      if(k==="intent")return 1;
      if(k==="booking")return 2;
      if(k==="mismatch")return 3;
      if(k==="text_in")return 5;
      if(k==="text_out"){
        if(e.data&&e.data.alert==="chain_opened")return 4;
        if(/^Got it/.test(e.text))return 5;
        if(/return label/i.test(e.text))return 8;
        if(/^Ordered the right/.test(e.text))return 11;
        if(/refunded|All done/i.test(e.text))return 10;
        return 6;
      }
      if(k==="protocol_out"||k==="protocol_in")return 6;
      if(k==="form_field")return 7;
      if(k==="return_label")return 8;
      if(k==="carrier_scan"||(k==="email_in"&&e.data&&e.data.return_received))return 9;
      if(k==="stripe_refund")return 10;
      if(k==="redo"||k==="chain")return 11;
      return 6;
    }
    if(story==="ambiguous"){
      if(k==="intent")return 1;
      if(k==="mismatch")return 3;
      if(k==="text_out")return ctx.firstIn&&e.seq>ctx.firstIn?4:3;
      if(k==="text_in")return 4;
      return 5;
    }
    var S=STORIES[story], MONEY=S.money||7, REDO=S.redo||8, CHOOSE=S.choose||S.talk;
    // After the human's choice, everything (the accept, the refunds, the other merchants) is the money coming back.
    var afterChoice=ctx.decision&&e.seq>ctx.decision;
    if(story==="trip-dmy"){
      // The date question, the human's answer and Proxy's re-check come before the alert.
      if(k==="text_out"&&/^You wrote |^Got it: .*already booked/.test(e.text))return 3;
      if(k==="text_in"&&e.seq===ctx.firstIn)return 3;
    }
    if(k==="intent")return 1;
    if(k==="wait")return 0; // live pacing lines; a presenter paces the story themselves
    if(k==="booking"||k==="message"||k==="self_undo")return 2;
    if(k==="mismatch")return 3;
    if(k==="stripe_refund"||k==="credit")return ctx.firstAlert&&e.seq>ctx.firstAlert?MONEY:2;
    if(k==="options"||k==="decision")return CHOOSE;
    if(k==="text_in")return ctx.options&&e.seq>ctx.options&&(!ctx.decision||e.seq<=ctx.decision+1)?CHOOSE:5;
    if(k==="text_out"){
      if(e.data&&e.data.alert==="chain_opened")return 4;
      if(!ctx.firstIn||e.seq<ctx.firstIn)return 4;
      if(/best offer:|^Okay: /.test(e.text))return CHOOSE;
      if(/^Got it/.test(e.text))return 5;
      if(/^Rebooked|^Re-subscribed/.test(e.text))return REDO;
      if(afterChoice||/refunded|All done|store credit/i.test(e.text))return MONEY;
      return S.talk;
    }
    if(k==="protocol_out"||k==="protocol_in"||k==="email_out"||k==="email_in")return afterChoice?MONEY:S.talk;
    if(k==="redo"||k==="chain")return REDO;
    return afterChoice?MONEY:S.talk;
  }
  function context(es){
    var c={firstAlert:0,firstIn:0,options:0,decision:0};
    es.forEach(function(e){
      if(!c.options&&e.kind==="options")c.options=e.seq;
      if(!c.decision&&e.kind==="decision")c.decision=e.seq;
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
      // Scenes shown one entry at a time, like the return form filling in field by field.
      if(S.each&&S.each.indexOf(s)>=0){list.forEach(function(e){out.push({scene:s,seqs:[e.seq]})});continue}
      if(s===S.talk){list.forEach(function(e){
        // Present mode: "Proxy is checking" gets its own step before each of Proxy's decisions.
        if(e.kind==="protocol_out"&&e.data&&e.data.why)out.push({scene:s,seqs:[],checks:[e.seq]});
        out.push({scene:s,seqs:[e.seq],checks:e.kind==="protocol_out"?[e.seq]:[]});
      });continue}
      if(S.choose&&s===S.choose&&list.length){
        // The options text is one step; the human's tap and Proxy's confirmation the next.
        var firstIn=list.findIndex(function(e){return e.kind==="text_in"});
        var ask=firstIn<0?list:list.slice(0,firstIn), ans=firstIn<0?[]:list.slice(firstIn);
        out.push({scene:s,seqs:ask.map(function(e){return e.seq})});
        if(ans.length)out.push({scene:s,seqs:ans.map(function(e){return e.seq})});
        continue;
      }
      if(S.choose&&s===S.money&&list.length){
        // One step per merchant as the money comes back, in order.
        var group=[],key=null;
        list.forEach(function(e){var m=(e.data&&e.data.merchant)||key;if(group.length&&m!==key){out.push({scene:s,seqs:group});group=[]}key=m;group.push(e.seq)});
        if(group.length)out.push({scene:s,seqs:group});
        continue;
      }
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
    var refunded={}, corrected={}; howBy={}; credited={}; items={}; itemDiff=null;
    (feed.entries||[]).forEach(function(e){
      if(e.data&&e.data.item)items[e.data.action_id]=String(e.data.item);
      if(e.kind==="mismatch"&&e.data&&e.data.field==="item"&&!itemDiff)itemDiff=shortDiff(String(e.data.actual||""),String(e.data.expected||""));
    });
    // A late receipt has no mismatch entry; the alert says the same thing.
    if(!itemDiff)(feed.entries||[]).forEach(function(e){var m=e.kind==="text_out"&&/ordered the wrong item \((.+), not (.+)\)/.exec(e.text);if(m&&!itemDiff)itemDiff=shortDiff(m[1],m[2])});
    es.forEach(function(e){
      if(e.kind==="stripe_refund"){refunded[e.data.action_id]=Number(e.data.amount||0);howBy[e.data.action_id]=e.data.how||null}
      if(e.kind==="credit")credited[e.data.action_id]=Number(e.data.amount||0);
      if(e.kind==="email_out"&&e.data&&e.data.correction)corrected[e.data.action_id]=1;
    });
    var spotted=es.some(function(e){return e.kind==="mismatch"||(e.kind==="text_out"&&e.data&&e.data.alert==="chain_opened")});
    renderChat(es,v.scene,byId,refunded,corrected,spotted);
    renderPhone(es);
    renderMoney(es,spotted,byId);
    renderSteps(es,byId);
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
    if(b.category==="store"&&items[b.id])mid.firstChild.textContent=items[b.id];
    var annual=/annual|yearly/i.test(String(b.raw||b.summary));
    var when=el("div","when",b.category==="saas"?(annual?"Billed annually":"Billed monthly"):b.category==="store"?(STORE_NAMES[b.merchant]||"Online order")+(SIMULATED[b.merchant]?" (simulated store)":""):range(b.dates));
    mid.appendChild(when);
    if(b.category==="message"){amt.textContent=opts.corrected?"Corrected":"Sent";if(opts.corrected)amt.style.color="var(--green)"}
    else if(credited[b.id]!==undefined){amt.appendChild(el("s",null,money(b.amount)));amt.appendChild(el("span","back credit-back","Kept as "+money(credited[b.id])+" credit"));opts.credit=true}
    else if(opts.refunded!==undefined){var s=el("s",null,money(b.amount));amt.appendChild(s);amt.appendChild(el("span","back","Refunded "+money(opts.refunded)))}
    else amt.textContent=money(b.amount);
    if(opts.refunded!==undefined&&howBy[b.id])mid.appendChild(el("div","who",howBy[b.id]));
    if(opts.corrected)mid.appendChild(el("div","who","Proxy emailed the right dates"));
    if(opts.credit)mid.appendChild(el("div","who","You chose store credit"));
    if(opts.bad){
      c.className+=opts.refunded!==undefined||opts.corrected||opts.credit?" bad fixed":" bad";
      var want=feed.task&&feed.task.intended_dates;
      var diff=b.category==="saas"?"Annual ≠ Monthly":b.category==="store"&&itemDiff?itemDiff.actual+" ≠ "+itemDiff.expected:(want&&b.dates?day(b.dates.start)+" ≠ "+day(want.start):"Doesn't match");
      when.appendChild(el("span","diff",diff));
    }
    if(opts.good){c.className+=" good";when.appendChild(el("span","ok",b.category==="saas"?"Monthly ✓":b.category==="store"?(itemDiff?itemDiff.expected:"Right item")+" ✓":day(b.dates&&b.dates.start)+" ✓"))}
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
        frag.appendChild(bot(story==="store"?"Ordered ✅":"Done! Here's what I "+(story==="plan"?"signed you up for":"booked")+" ✅",made.map(function(e){
          var b=asB(e);return card(b,{bad:spotted&&b.wrong!==false,refunded:refunded[b.id],corrected:corrected[b.id]});
        })));
      }
      // The agent's own fix during its session, said in its own words.
      es.filter(function(e){return e.kind==="self_undo"}).forEach(function(e){
        var b=byId[e.data.action_id], what=b&&b.category?b.category:"booking";
        var back=refunded[e.data.action_id];
        frag.appendChild(bot("I booked the "+what+" on the wrong date. Cancelling it myself, free within 24h \u2705"+(back!==undefined?" "+money(back)+" back":"")));
      });
      if(redo.length){
        var dates=feed.task&&feed.task.intended_dates;
        var msg=story==="plan"?"Re-subscribed on the monthly plan ✅":story==="store"?"Ordered the right one ✅":"Rebooked for "+range(dates)+" ✅";
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
    // Chips for the newest question that hasn't been answered yet (other texts may have arrived after it).
    var chips=$("chips"), opts=[], last=null;
    for(var i=texts.length-1;i>=0;i--){
      var t=texts[i];
      if(t.kind==="text_in")break;
      if((t.data&&t.data.alert==="chain_opened")||/Reply 1\b/.test(t.text)){last=t;break}
    }
    if(last){
      if(last.data&&last.data.alert==="chain_opened")opts=[["UNDO ALL","undo_all"],["PICK","pick"],["KEEP","keep"]];
      else{
        var n=(last.text.match(/Reply ([0-9, or]+)/)||["","1"])[1].match(/\d+/g)||["1"];
        opts=n.map(function(x){return [x,"choice"+x]});
        if(/KEEP PUSHING/.test(last.text))opts.push(["KEEP PUSHING","keep_pushing"]);
      }
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
    var body=kind.indexOf("choice")===0?{kind:"choice",choice:Number(kind.slice(6))}:kind==="keep_pushing"?{kind:"keep_pushing"}:{kind:kind,chain_id:feed.chain&&feed.chain.chain_id};
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
    // Store credit the human chose is shown as credit, never as money back.
    var credit=es.filter(function(e){return e.kind==="credit"}).reduce(function(t,e){return t+Number(e.data.amount||0)},0);
    $("moneyNote").textContent=(back?(sim?"Simulated payments: no real money moved.":"Every dollar here is confirmed in Stripe.")+(done?" The agent redid the task correctly.":""):"Proxy found the mistake. Nothing is back yet.")+(credit?" Plus "+money(credit)+" kept as store credit, not money back.":"");
    // Nothing back yet: show $0, not the booked total the panel showed before Proxy spotted the mistake.
    if(!back){counter.shown=counter.target=0;$("moneyNum").textContent="$0"}
    else setCount(back,false);
  }
  /** Proxy's plan as a row of steps, always in view: the agent's own fix, then each merchant in Proxy's order. */
  function renderSteps(es,byId){
    var box=$("steps"), frag=document.createDocumentFragment();
    var plan=es.filter(function(e){return e.kind==="plan"}).pop();
    var own=es.filter(function(e){return e.kind==="self_undo"});
    if(!plan&&!own.length){box.replaceChildren();return}
    var label=function(cat,m){return m==="host"?"Host":{flight:"Flight",hotel:"Hotel",transfer:"Transfer",saas:"Subscription",store:"Order",message:"Message"}[cat]||m};
    var chip=function(n,title,sub,cls){var c=el("div","step "+cls);var h=el("div","st-head");h.appendChild(el("span","n",n));h.appendChild(el("span","st-title",title));c.appendChild(h);c.appendChild(el("div","st-sub",sub));return c};
    own.forEach(function(e){var b=byId[e.data.action_id]||{};frag.appendChild(chip("✓",label(b.category||"flight",b.merchant),"Your agent fixed it, "+money(e.data.amount)+" back","done"))});
    var steps=[];try{steps=plan?JSON.parse(String(plan.data.steps||"[]")):[]}catch(x){steps=[]}
    var activeSet=false;
    steps.forEach(function(st,i){
      var refund=es.filter(function(e){return e.kind==="stripe_refund"&&e.data.action_id===st.action_id}).pop();
      var fixed=es.some(function(e){return e.kind==="email_in"&&e.data.action_id===st.action_id&&e.data.correction&&e.data.approved});
      var cred=es.filter(function(e){return e.kind==="credit"&&e.data.action_id===st.action_id}).pop();
      var askedYou=es.some(function(e){return e.kind==="options"&&e.data.action_id===st.action_id})&&!es.some(function(e){return e.kind==="decision"&&e.data.action_id===st.action_id});
      var touched=es.some(function(e){return e.seq>plan.seq&&e.data&&e.data.action_id===st.action_id&&e.kind!=="stripe_refund"});
      var title=label(st.category,st.merchant);
      if(refund)frag.appendChild(chip("✓",title,money(refund.data.amount)+" back","done"));
      else if(cred)frag.appendChild(chip("✓",title,money(cred.data.amount)+" store credit","done"));
      else if(askedYou){activeSet=true;frag.appendChild(chip(String(i+1),title,"Waiting for your choice","active"))}
      else if(fixed)frag.appendChild(chip("✓",title,"Right dates sent","done"));
      else if(touched&&!activeSet){activeSet=true;frag.appendChild(chip(String(i+1),title,st.how.charAt(0).toUpperCase()+st.how.slice(1)+"…","active"))}
      else frag.appendChild(chip(String(i+1),title,(activeSet||touched?"Waiting: ":"Next: ")+st.how,"next"));
    });
    box.replaceChildren(frag);
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
    if(b.category==="store")return itemDiff?"Wrong item: "+itemDiff.actual+", not "+itemDiff.expected:"Not the item you asked for";
    var want=feed.task&&feed.task.intended_dates;
    return want&&b.dates?"Wrong dates: "+day(b.dates.start)+", not "+day(want.start):"Doesn't match the request";
  }
  function titleOf(b){if(b&&items[b.id])return items[b.id];return b?String(b.summary||"").replace(/\s·\s(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}(?: to .*)?$/,""):""}
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
    // Sticky only while the negotiation is open; once the merchant accepts or denies, it scrolls with its thread.
    var closed=list.some(function(e){return e.kind==="protocol_in"&&(e.data.type==="accept"||e.data.type==="deny")});
    var full=Number(asked.data.order_amount||0), box=el("div","ladder"+(closed?" settled":""));
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
      var before=b?(b.category==="saas"?"Annual plan, ":b.category==="store"&&items[b.id]?items[b.id]+", ":(range(b.dates)?range(b.dates)+", ":""))+money(b.amount):"";
      c.appendChild(row2("Before",before));
      c.appendChild(row2("After",(b&&b.category==="store"?"Returned, ":"Cancelled, ")+money(d.amount)+" back"+(d.of&&d.of!==d.amount?" of "+money(d.of):""),"good"));
      var rounds=es.filter(function(x){return x.kind==="protocol_out"&&x.data.merchant===m}).reduce(function(t,x){return Math.max(t,Number(x.data.round||0))},0);
      var how=d.how?String(d.how)+(rounds&&/negotiated/.test(String(d.how))?", "+rounds+" rounds":""):rounds?"Proxy negotiated with the agent, "+rounds+" rounds":"Proxy emailed support";
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

  /** "USB-A 20W charger" vs "USB-C 65W charger" -> {actual:"USB-A 20W", expected:"USB-C 65W"}: the shared words go. */
  function shortDiff(actual,expected){
    var a=actual.split(" "), x=expected.split(" ");
    while(a.length>1&&x.length>1&&a[a.length-1].toLowerCase()===x[x.length-1].toLowerCase()){a.pop();x.pop()}
    return {actual:a.join(" "),expected:x.join(" ")};
  }
  /** The merchant's return form as a web page: its fields come from the "_open" entry, values as Proxy fills them. */
  function formCard(d){
    var box=el("div","wform"), bar=el("div","wbar");
    bar.appendChild(el("i"));bar.appendChild(el("i"));bar.appendChild(el("i"));bar.appendChild(el("span","url",String(d.form_url||"")));
    box.appendChild(bar);
    var body=el("div","wbody"), slots={}, n=0;
    var h4=el("h4",null,(STORE_NAMES[d.merchant]||"Store")+" · "+String(d.form_title||"Return form")+" ");
    if(SIMULATED[d.merchant])h4.appendChild(simTag());
    body.appendChild(h4);
    String(d.fields||"").split("|").filter(Boolean).forEach(function(spec){
      var i=spec.lastIndexOf(":"), label=spec.slice(0,i), w=el("div","fld"), inp=el("div","in empty");
      w.appendChild(el("div","fl",label));inp.appendChild(el("span","v",""));
      if(spec.slice(i+1)==="choice")inp.appendChild(el("span","chev","▾"));
      w.appendChild(inp);body.appendChild(w);slots[label]=w;n++;
    });
    var btn=el("div","submit","Submit return");body.appendChild(btn);box.appendChild(body);
    return {box:box,slots:slots,btn:btn,total:n,filled:0};
  }
  function fillForm(f,d){
    Object.keys(f.slots).forEach(function(k){f.slots[k].classList.remove("on");var c=f.slots[k].querySelector(".caret");if(c)c.remove()});
    if(d.field==="_submit"){f.btn.className="submit done";f.btn.textContent="Submitted ✓";return}
    if(d.field==="_rejected"){f.btn.className="submit no";f.btn.textContent="Not accepted";return}
    var slot=f.slots[String(d.label||"")];
    if(!slot)return;
    var inp=slot.querySelector(".in"), v=inp.querySelector(".v");
    v.textContent=String(d.value||"");inp.classList.remove("empty");slot.classList.add("on");
    v.appendChild(el("span","caret"));
    f.filled++;
    if(f.filled>=f.total)f.btn.className="submit go";
  }
  function labelCard(d){
    var c=el("div","rlabel"), left=el("div"), meta=function(label,value){var m=el("div","meta");m.appendChild(document.createTextNode(label+" "));m.appendChild(el("b",null,value));return m};
    left.appendChild(el("div","carrier",String(d.carrier||"").toUpperCase()+" · PREPAID RETURN"+(SIMULATED[d.merchant]?" · SIMULATED":"")));
    left.appendChild(el("div","rma",String(d.rma||"")));
    left.appendChild(meta("Order",String(d.ref||"")));
    left.appendChild(meta("Drop off by",day(d.drop_off_by)));
    left.appendChild(meta("At",String(d.drop_off_point||"")));
    left.appendChild(meta("Return to",(STORE_NAMES[d.merchant]||"the store")+" Returns"));
    c.appendChild(left);
    var NS="http://www.w3.org/2000/svg", size=Number(d.qr_size||0), svg=document.createElementNS(NS,"svg"), bg=document.createElementNS(NS,"rect"), path=document.createElementNS(NS,"path");
    svg.setAttribute("viewBox","0 0 "+size+" "+size);svg.setAttribute("shape-rendering","crispEdges");svg.setAttribute("role","img");svg.setAttribute("aria-label","Return label QR code");
    bg.setAttribute("width",String(size));bg.setAttribute("height",String(size));bg.setAttribute("fill","#fff");
    path.setAttribute("d",String(d.qr_path||""));path.setAttribute("fill","#1D1D1F");
    svg.appendChild(bg);svg.appendChild(path);c.appendChild(svg);
    return c;
  }
  function trackEvent(what,sub,grey){
    var r=el("div","ev"), t=el("div");r.appendChild(el("span","dot"+(grey?" grey":"")));
    t.appendChild(document.createTextNode(what));t.appendChild(el("span","t2",sub));r.appendChild(t);return r;
  }

  function renderItems(es,checks,byId){
    var box=$("items"), frag=document.createDocumentFragment(), groups={}, any=false, checkShown=false;
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
          var h=el("div","thread-head");h.appendChild(el("div","avatar av-merchant",(NAMES[m]||m).charAt(0)));h.appendChild(el("span",null,"Proxy and "+(NAMES[m]||m)));h.appendChild(el("span","sub",SIMULATED[m]?"Agent to agent · simulated store":"Agent to agent"));
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
      }else if(k==="form_field"){
        var f=groups["f"+d.action_id];
        if(!f){f=groups["f"+d.action_id]=formCard(d);frag.appendChild(f.box)}
        fillForm(f,d);any=true;
      }else if(k==="return_label"){
        frag.appendChild(labelCard(d));any=true;
      }else if(k==="carrier_scan"||(k==="email_in"&&d.return_received)){
        var tr=groups["s"+d.action_id];
        if(!tr){
          tr=groups["s"+d.action_id]=el("div","track");var th=el("div","check-head","Return tracking ");if(SIMULATED[m])th.appendChild(simTag());tr.appendChild(th);
          var lab=all.filter(function(x){return x.kind==="return_label"&&x.data.action_id===d.action_id})[0];
          if(lab)tr.appendChild(trackEvent("Label created, "+String(lab.data.rma),String(lab.data.carrier||"")+" · "+day(lab.at),true));
          frag.appendChild(tr);
        }
        tr.appendChild(k==="carrier_scan"?trackEvent(String(d.event||"Package scanned"),String(d.location||"")+" · "+day(e.at)+", "+clock(e.at)):trackEvent("Return received, refund approved "+money(d.amount),STORE_NAMES[m]||m));
        any=true;
      }else if(k==="options"||k==="decision"){
        // The question Proxy put to the human, and their answer, inside the merchant's thread.
        var tg=groups["t"+m];
        if(!tg){tg=groups["t"+m]={box:el("div","thread"),list:[]};var th=el("div","thread-head");th.appendChild(el("div","avatar av-merchant",(NAMES[m]||m).charAt(0)));th.appendChild(el("span",null,"Proxy and "+(NAMES[m]||m)));tg.box.appendChild(th);frag.appendChild(tg.box)}
        if(k==="options"){
          var oc=el("div","asked-card");oc.appendChild(el("div","check-head","Proxy asked you to choose"));
          var opts=[];try{opts=JSON.parse(String(d.options||"[]"))}catch(x){opts=[]}
          opts.forEach(function(o,i){var r=el("div","opt"+(d.recommended===i+1?" rec":""));r.appendChild(el("span","on",String(i+1)));r.appendChild(el("span",null,o.label));if(d.recommended===i+1)r.appendChild(el("span","star","Recommended"));oc.appendChild(r)});
          if(d.can_push)oc.appendChild(el("div","opt-note","or KEEP PUSHING"));
          tg.box.appendChild(oc);
        }else{
          var dc=el("div","chose");dc.appendChild(el("span","ok-dot","\u2713"));dc.appendChild(document.createTextNode(e.text));tg.box.appendChild(dc);
        }
        any=true;
      }else if(k==="credit"){
        var cc=el("div","revert credit"), cb=byId[d.action_id];
        var chh=el("div","revert-head");chh.appendChild(el("span","ok-dot","\u2713"));chh.appendChild(el("span",null,"Kept as credit: "+titleOf(cb)));cc.appendChild(chh);
        cc.appendChild(row2("Before",(cb&&range(cb.dates)?range(cb.dates)+", ":"")+money(d.of)));
        cc.appendChild(row2("After",money(d.amount)+" store credit, no money back","good"));
        cc.appendChild(row2("How","You chose store credit; Proxy accepted it with the agent"));
        cc.appendChild(row2("Why",wrongWhy(cb)));
        frag.appendChild(cc);any=true;
      }else if(k==="email_out"||k==="email_in"){
        var mg=groups["m"+m];
        if(!mg){mg=groups["m"+m]=el("div","mail");var mh=el("div","mail-head");mh.appendChild(el("span","env","✉️"));mh.appendChild(el("span",null,(d.correction?"Correction to ":"Email to ")+(NAMES[m]||m)));mg.appendChild(mh);frag.appendChild(mg)}
        var line=el("div","mail-line"+(k==="email_in"?" reply":""));
        line.appendChild(el("span","from",k==="email_out"?"Proxy: ":(NAMES[m]||m)+": "));line.appendChild(document.createTextNode(strip(e.text)));
        mg.appendChild(line);any=true;
        if(k==="email_in"&&d.correction&&d.approved)frag.appendChild(reverted(e,es,byId));
      }else if(k==="wait"){
        // Live pacing: shown only while it is the newest thing for its step.
        var later=all.some(function(x){return x.seq>e.seq&&x.data&&x.data.action_id===d.action_id});
        if(LIVE&&!PRESENT&&!later){var w=el("div","waiting");w.appendChild(el("span","spin"));w.appendChild(document.createTextNode(e.text));frag.appendChild(w);any=true}
      }else if(k==="stripe_refund"){
        frag.appendChild(reverted(e,es,byId));any=true;
      }else if(k==="mismatch"&&(story==="ambiguous"||story==="trip-dmy")&&d.said&&!checkShown){
        // Once: the intent check's own entry, not the per-booking mismatches found after the answer.
        checkShown=true;
        var c=el("div","check");c.appendChild(el("div","check-head","Intent check: your words against the plan"));
        var said=String(d.said||""), agent=String(d.understood||"");
        var rows=[["You wrote",said.replace(/\s*\(.*$/,"")],["Your agent read",agent],["It could also mean",(said.match(/\((.*)\)/)||["",""])[1].replace(agent.replace(/ to .*/,""),"").replace(/^ or | or $/,"")]];
        var got=es.filter(function(x){return x.kind==="text_out"&&/^Got it: /.test(x.text)})[0];
        if(got)rows.push(["You meant",got.text.replace(/^Got it: /,"").replace(/\. .*$/,"")+" ✅"]);
        rows.forEach(function(x){c.appendChild(row2(x[0],x[1]))});
        frag.appendChild(c);any=true;
      }
    });
    Object.keys(groups).forEach(function(key){
      var g=groups[key];
      if(!g.ladderSlot)return;
      var l=ladder(g.list);if(l)g.ladderSlot.replaceWith(l);
      // Live: while Proxy waits on the merchant's agent, it is "typing".
      var last=g.list[g.list.length-1], open=feed.chain&&["undoing","alerted","detected"].indexOf(feed.chain.state)>=0;
      if(LIVE&&!PRESENT&&last&&last.kind==="protocol_out"&&open){var ty=el("div","tm typing");ty.appendChild(el("div","avatar av-merchant",(NAMES[last.data.merchant]||"M").charAt(0)));var dots=el("div","t");dots.appendChild(el("span","dots","\u2022\u2022\u2022"));ty.appendChild(dots);g.box.appendChild(ty)}
    });
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
