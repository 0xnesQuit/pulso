// Page shell and the single stylesheet (docs/DESIGN.md v2: always dark,
// 1 px hairline grids, Open Sauce Sans, dither only in the dial and the logo).
// Everything inline is covered by the per-response CSP nonce.

import { html, raw, type Safe } from "./html";
import { WORDMARK } from "./wordmark";

// The dial lights up from 00 round to 23 in ~500 ms: 24 staggered delays.
const REVEAL = Array.from({ length: 24 }, (_, i) => `.dial .h${i}{animation-delay:${i * 21}ms}`).join("");

const FONT = (weight: number, file: string): string =>
  `@font-face{font-family:"Open Sauce Sans";font-style:normal;font-weight:${weight};font-display:swap;src:url(/fonts/OpenSauceSans-${file}.woff2) format("woff2")}`;

const CSS = `
${FONT(300, "Light")}${FONT(400, "Regular")}${FONT(500, "Medium")}${FONT(600, "SemiBold")}
:root{
  color-scheme:dark;
  --bg:#0A0A0A;--surface:#111111;--line:#1F1F1F;--ink:#EDEDED;--muted:#8A8A8A;--faint:#4A4A4A;
  --phosphor:#8BE36B;--pulse:#FF5C5C;
  --sans:"Open Sauce Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --code:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  --gut:16px;
}
@media (min-width:720px){:root{--gut:40px}}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font-family:var(--sans);font-weight:400;font-size:16px;line-height:1.6;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
::selection{background:var(--ink);color:var(--bg)}
[hidden]{display:none!important}
.sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}

/* type */
h1{font-size:28px;line-height:1.15;font-weight:300;letter-spacing:-.015em;margin:0 0 16px}
h2{font-size:22px;line-height:1.3;font-weight:300;letter-spacing:-.01em;margin:0 0 20px}
h2 .muted{font-weight:300}
h3{font-size:17px;line-height:1.4;font-weight:400;margin:0 0 8px}
@media (min-width:720px){h1{font-size:34px}h2{font-size:24px}}
p,ul,ol{margin:0 0 14px;max-width:64ch}
li{margin:0 0 6px}
ul{padding-left:18px;list-style:square}
li::marker{color:var(--faint)}
strong{font-weight:500}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--faint);text-decoration-thickness:1px;text-underline-offset:3px}
a:hover{text-decoration-color:var(--ink)}
.muted{color:var(--muted)}
.small{font-size:14px}
.label{display:block;font-size:12px;line-height:1.4;font-weight:500;letter-spacing:.02em;color:var(--muted);margin:0 0 10px}
.lede{font-size:18px;line-height:1.55;color:var(--muted)}
.fig{font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:-.02em;line-height:1}
.unit{font-size:13px;font-weight:500;letter-spacing:0;color:var(--muted);margin-left:6px}
.error{color:var(--pulse)}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}

/* code */
code,pre,.secret{font-family:var(--code);font-size:13px}
code{overflow-wrap:anywhere}
p code,li code,label code{font-size:.85em;background:var(--surface);border:1px solid var(--line);border-radius:2px;padding:1px 4px}
pre{overflow-x:auto;padding:16px;margin:0 0 20px;background:var(--surface);border:1px solid var(--line);border-radius:2px;line-height:1.55;max-width:100%}
.secret{display:block;overflow-wrap:anywhere;padding:12px 14px;margin:8px 0 12px;background:var(--surface);border:1px solid var(--line);border-radius:2px}

/* shell */
.wrap{max-width:1200px;margin:0 auto;padding:0 var(--gut)}
header.top{border-bottom:1px solid var(--line)}
.top-in{display:flex;align-items:center;justify-content:space-between;gap:16px;height:64px}
.brand{display:block;flex:none;line-height:0;text-decoration:none}
.wordmark{display:block;width:${WORDMARK.width}px;height:${WORDMARK.height}px}
nav.main{display:flex;align-items:center;gap:20px;min-width:0}
.navlink{font-size:13px;font-weight:500;color:var(--muted);text-decoration:none;white-space:nowrap}
.navlink:hover,.navlink[aria-current=page]{color:var(--ink)}
@media (max-width:559px){.navlink{display:none}.wordmark{width:${WORDMARK.width * 0.75}px;height:${WORDMARK.height * 0.75}px}}
main.wrap{display:block;flex:1 0 auto;width:100%;padding-top:40px;padding-bottom:88px}
@media (min-width:720px){main.wrap{padding-top:56px;padding-bottom:112px}}
footer.foot{border-top:1px solid var(--line)}
.foot-in{display:flex;justify-content:space-between;align-items:center;gap:12px 24px;flex-wrap:wrap;padding-top:20px;padding-bottom:28px;font-size:12px;font-weight:500;color:var(--muted)}
.foot-in nav{display:flex;gap:20px;flex-wrap:wrap}
.foot-in a{color:var(--muted);text-decoration:none}
.foot-in a:hover{color:var(--ink)}
main.wrap>*+section{margin-top:72px}
@media (min-width:720px){main.wrap>*+section{margin-top:96px}}

/* controls */
button,.btn{-webkit-appearance:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:36px;padding:0 14px;margin:0;font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;text-decoration:none;cursor:pointer;border-radius:2px;border:1px solid var(--ink);background:var(--ink);color:var(--bg)}
button:hover,.btn:hover{background:#fff;border-color:#fff}
button.ghost,.btn.ghost{background:var(--surface);border-color:var(--line);color:var(--ink)}
button.ghost:hover,.btn.ghost:hover{border-color:var(--faint);background:var(--surface)}
button.danger{background:var(--pulse);border-color:var(--pulse);color:var(--bg)}
button.danger:hover{background:#ff7a7a;border-color:#ff7a7a}
button.ghost.danger{background:var(--surface);border-color:var(--line);color:var(--pulse)}
button.ghost.danger:hover{border-color:var(--pulse)}
button.sm,.btn.sm{height:30px;padding:0 10px;font-size:12px}
.btn.sq{width:36px;padding:0}
button:disabled,button:disabled:hover{opacity:.35;cursor:not-allowed;background:var(--ink);border-color:var(--ink)}
button.danger:disabled{background:var(--pulse);border-color:var(--pulse)}
.ico{width:10px;height:10px;flex:none;fill:none;stroke:currentColor;stroke-width:1.5}
input,select{font:inherit;font-size:16px;line-height:1.2;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:2px;height:40px;padding:0 12px;max-width:100%;min-width:0}
input:hover{border-color:var(--faint)}
input::placeholder{color:var(--faint)}
input[type=url],input[type=password],input.wide{width:100%}
input[type=date]{font-variant-numeric:tabular-nums;height:36px;font-size:16px}
label{display:block;font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--muted);margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.stack>*+*{margin-top:14px}
.confirm{margin-top:14px;padding:14px 16px;background:var(--surface);border:1px solid var(--line);border-left:2px solid var(--pulse)}
.confirm p:last-child{margin-bottom:0}
.confirm input+.row{margin-top:12px}
[role=status]:empty{display:none}

/* hairline grids: 1 px gaps over the line colour, so neighbours share one border */
.grid{display:grid;grid-template-columns:minmax(0,1fr);gap:1px;background:var(--line);border:1px solid var(--line);margin:0;padding:0;list-style:none;max-width:none}
.grid>*{background:var(--bg);min-width:0;margin:0;padding:20px 16px}
@media (min-width:720px){.grid>*{padding:24px}.g2{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(3,minmax(0,1fr))}.span2{grid-column:span 2}}
.grid p:last-child,.grid ul:last-child{margin-bottom:0}
.cell-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 16px!important;font-size:12px;font-weight:500;color:var(--muted)}
ol.steps{counter-reset:step}
ol.steps>li{counter-increment:step}
ol.steps>li::before{content:counter(step,decimal-leading-zero);display:block;font-size:12px;font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums;margin-bottom:28px}
.note{margin-top:16px}
.lede+.grid,.lede+ol.grid{margin-top:40px}

/* home */
.hero{display:grid;grid-template-columns:minmax(0,1fr);gap:40px;align-items:center}
.hero .row{margin-top:28px}
@media (min-width:960px){.hero{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:64px}.hero h1{font-size:34px}}
.frame{margin:0}
.banner{padding:12px 16px;margin:0 0 32px;border:1px solid var(--line);background:var(--surface);max-width:none}

/* narrow pages */
.narrow{max-width:560px}
.box{border:1px solid var(--line);padding:20px 16px;margin:24px 0 16px}
@media (min-width:720px){.box{padding:24px}}

/* panel */
.dayhead{display:flex;justify-content:space-between;align-items:flex-end;gap:20px 32px;flex-wrap:wrap;margin-bottom:28px}
.dayhead h1{margin:0 0 8px}
.status{display:flex;align-items:center;gap:4px 20px;flex-wrap:wrap;font-size:13px;font-weight:500;color:var(--muted);margin:0}
.sync{display:inline-flex;align-items:center;gap:8px}
.dot{display:inline-block;width:6px;height:6px;background:var(--faint);flex:none}
.dot.on{background:var(--phosphor)}
.picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.picker input{width:auto}
.devices{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);margin:0 0 28px;width:fit-content;max-width:100%}
.devices a{flex:1 1 auto;background:var(--surface);padding:8px 12px;font-size:13px;font-weight:500;text-decoration:none;color:var(--muted)}
.devices a[aria-current=true]{background:var(--bg);color:var(--ink)}
.devices a .muted{font-weight:400}
.board{grid-template-columns:repeat(2,minmax(0,1fr))}
.board .dialcell,.board .m-steps,.board .curvecell{grid-column:1/-1}
@media (min-width:960px){
  .board{grid-template-columns:repeat(4,minmax(0,1fr))}
  .board .dialcell{grid-column:1/3;grid-row:1/4}
  .board .m-steps,.board .m-cal,.board .m-bat{grid-column:3/5}
}
.dialcell{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;padding:28px 0!important}
.empty{text-align:center;color:var(--muted);margin:0 16px;max-width:36ch}
.legend{display:flex;gap:6px 18px;flex-wrap:wrap;justify-content:center;list-style:none;padding:0 16px;margin:0;font-size:12px;font-weight:500;color:var(--muted);max-width:none}
.legend li{display:flex;align-items:center;gap:8px;margin:0}
.sw{display:inline-block;width:8px;height:8px}
.sw-step{background:var(--phosphor)}.sw-hr{background:var(--pulse)}.sw-now{background:var(--ink)}
.sw-night{background:linear-gradient(var(--muted) 0 0) 0 0/2px 2px no-repeat,linear-gradient(var(--muted) 0 0) 4px 4px/2px 2px no-repeat,linear-gradient(var(--faint) 0 0) 4px 0/2px 2px no-repeat,linear-gradient(var(--faint) 0 0) 0 4px/2px 2px no-repeat}
.metric{display:flex;flex-direction:column;justify-content:space-between;gap:20px}
.metric .fig{font-size:44px}
.m-steps .fig{color:var(--phosphor)}
.fact .fig{font-size:22px}
.fig.none,.m-steps .fig.none{color:var(--faint)}
@media (max-width:479px){.m-cal .fig,.m-bat .fig{font-size:33px}}
@media (min-width:960px){.metric{min-height:150px}}
.curve{position:relative;padding-right:36px}
.curve svg{display:block;width:100%;height:112px;overflow:visible}
.curve .gl{stroke:var(--line);stroke-width:1;fill:none}
.curve .ln{stroke:var(--pulse);stroke-width:1;fill:none;stroke-linejoin:round}
.yl{position:absolute;right:0;font-size:12px;font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums;line-height:1}
.yl.hi{top:0}.yl.lo{top:100px}
.axis{display:flex;justify-content:space-between;margin-top:10px;font-size:12px;font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}
.tablewrap{border:1px solid var(--line)}
table.days{width:100%;border-collapse:collapse;font-size:15px}
table.days th{font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--muted);text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:bottom}
table.days td{padding:11px 16px;border-top:1px solid var(--line);vertical-align:baseline}
table.days tbody tr:first-child td{border-top:0}
table.days .n{text-align:right}
table.days td.n{font-weight:500;font-variant-numeric:tabular-nums}
table.days a{text-decoration:none}
table.days a:hover{text-decoration:underline}
table.days tr[aria-current=true] td{background:var(--surface)}
table.days tr[aria-current=true] td:first-child{box-shadow:inset 2px 0 0 var(--ink)}
@media (max-width:559px){table.days .hide-s{display:none}table.days th,table.days td{padding-left:12px;padding-right:12px}}
ul.hooks{list-style:none;padding:0;margin:0 0 16px;max-width:none;border-top:1px solid var(--line)}
ul.hooks li{border-bottom:1px solid var(--line);padding:12px 0;margin:0}
ul.hooks .url{overflow-wrap:anywhere;font-family:var(--code);font-size:13px;margin-bottom:4px}
ul.hooks .row{margin-top:8px}

/* the dial: 72×72 cells at an integer (or half) pixel size per cell */
.dial{--c:4.5;display:block;width:calc(72px * var(--c));max-width:100%;height:auto;overflow:visible}
@media (min-width:480px){.dial{--c:6}}
@media (min-width:960px){.dial{--c:5.5}}
@media (min-width:1200px){.dial{--c:7}}
.dial .trk{fill:var(--faint)}
.dial .steps{fill:var(--phosphor)}
.dial .hr{fill:var(--pulse)}
.dial .now{fill:var(--ink)}
.dial text{font-family:var(--sans);font-variant-numeric:tabular-nums}
.dial .lbl{fill:var(--muted);font-size:calc(12px / var(--c));font-weight:500}
.dial .big{fill:var(--pulse);font-size:10.5px;font-weight:500;letter-spacing:-.02em}
.dial .big.none{fill:var(--faint)}
.dial .cap{fill:var(--muted);font-size:calc(12px / var(--c));font-weight:500}
.dial .rv,.dial .bar{animation:px 40ms steps(1,jump-start) both}
${REVEAL}
.dial .live{animation:blink 1.2s steps(1,end) infinite}
@keyframes px{from{opacity:0}to{opacity:1}}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.dial .rv,.dial .bar,.dial .live{animation:none}}

/* docs */
.doc{display:grid;grid-template-columns:minmax(0,1fr);gap:32px}
.toc{display:flex;flex-wrap:wrap;gap:1px;background:var(--line);border:1px solid var(--line);align-self:start}
.toc .label{display:none}
.toc a{flex:1 1 auto;background:var(--bg);padding:8px 12px;font-size:13px;font-weight:500;color:var(--muted);text-decoration:none;white-space:nowrap}
.toc a:hover{color:var(--ink)}
@media (min-width:960px){
  .doc{grid-template-columns:220px minmax(0,1fr);gap:56px}
  .toc{position:sticky;top:24px;display:block;background:none;border:0;border-left:1px solid var(--line)}
  .toc .label{display:block;padding-left:16px}
  .toc a{display:block;padding:6px 16px;background:none}
}
.prose h2{margin-top:64px;padding-top:24px;border-top:1px solid var(--line)}
.prose h3{margin-top:32px}
.prose>h1+p{margin-top:0}

/* privacy: one hairline row per topic */
.split{display:grid;grid-template-columns:minmax(0,1fr);gap:8px;border-top:1px solid var(--line);padding:28px 0;margin:0}
.split:last-child{border-bottom:1px solid var(--line)}
.split h2{font-size:20px;margin:0 0 8px}
.split h2::before{content:counter(topic,decimal-leading-zero);counter-increment:topic;display:block;font-size:12px;font-weight:500;letter-spacing:.02em;color:var(--muted);margin-bottom:8px;font-variant-numeric:tabular-nums}
.topics{counter-reset:topic;margin-top:48px}
@media (min-width:960px){.split{grid-template-columns:280px minmax(0,1fr);gap:48px}}
`;

export interface PageOpts {
  title: string;
  nonce: string;
  body: Safe;
  script?: string;
  signedIn?: boolean;
  /** Request path, to mark the current nav link. */
  path?: string;
  /** Header actions that replace the default nav (e.g. the panel's sign-out button). */
  actions?: Safe;
}

const current = (path: string | undefined, href: string): string => (path === href ? "page" : "false");

function defaultNav(o: PageOpts): Safe {
  return html`<a class="navlink" href="/docs" aria-current="${current(o.path, "/docs")}">API belgesi</a><a class="navlink" href="/privacy" aria-current="${current(o.path, "/privacy")}">Gizlilik</a>${
    o.signedIn
      ? html`<a class="btn sm" href="/app">Panele git</a>`
      : o.path === "/login"
        ? ""
        : html`<a class="btn ghost sm" href="/login">Giriş yap</a>`
  }`;
}

export function page(o: PageOpts): string {
  return html`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0A0A0A">
<title>${o.title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/OpenSauceSans-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/OpenSauceSans-Light.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/OpenSauceSans-Medium.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${o.nonce}">${raw(CSS)}</style>
</head>
<body>
<header class="top">
<div class="wrap top-in">
  <a class="brand" href="${o.signedIn ? "/app" : "/"}">${raw(WORDMARK.svg)}</a>
  <nav class="main" aria-label="Ana menü">${o.actions ?? defaultNav(o)}</nav>
</div>
</header>
<main class="wrap">
${o.body}
</main>
<footer class="foot">
<div class="wrap foot-in">
  <span>Freeband hub</span>
  <nav aria-label="Alt menü"><a href="/">Ana sayfa</a><a href="/docs">API belgesi</a><a href="/privacy">Gizlilik</a></nav>
</div>
</footer>
${o.script ? html`<script nonce="${o.nonce}">${raw(o.script)}</script>` : ""}
</body>
</html>`.value;
}
