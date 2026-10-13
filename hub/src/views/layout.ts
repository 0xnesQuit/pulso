// Page shell and the single stylesheet (docs/DESIGN.md).
// Everything inline is covered by the per-response CSP nonce.

import { html, raw, type Safe } from "./html";

const LATIN =
  "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD";
const LATIN_EXT =
  "U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C4, U+2113, U+2C60-2C7F, U+A720-A7FF";

// Dial bars grow from 00 towards now: 24 staggered delays, ~600 ms in total.
const BAR_DELAYS = Array.from({ length: 24 }, (_, i) => `.h${i}{animation-delay:${i * 18}ms}`).join("");

const CSS = `
@font-face{font-family:"Archivo";font-style:normal;font-weight:100 900;font-stretch:62% 125%;font-display:swap;src:url(/fonts/archivo-latin-ext.woff2) format("woff2");unicode-range:${LATIN_EXT}}
@font-face{font-family:"Archivo";font-style:normal;font-weight:100 900;font-stretch:62% 125%;font-display:swap;src:url(/fonts/archivo-latin.woff2) format("woff2");unicode-range:${LATIN}}
:root{
  color-scheme:light dark;
  --bg:#F1F3F5;--ink:#16202B;--muted:rgb(22 32 43/.6);--dial:#D9DFE6;
  --saffron:#E2A013;--pomegranate:#D2344A;--night:rgb(18 26 43/.10);
}
@media (prefers-color-scheme:dark){:root{
  --bg:#121A2B;--ink:#E8ECF1;--muted:rgb(232 236 241/.6);--dial:#2A3348;
  --saffron:#F0B43A;--pomegranate:#F0566A;--night:rgb(0 0 0/.25);
}}
*{box-sizing:border-box}
html{background:var(--bg);color:var(--ink);-webkit-text-size-adjust:100%}
body{margin:0;font-family:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;font-variation-settings:"wdth" 100;font-size:17px;line-height:1.5}
.wrap{max-width:680px;margin:0 auto;padding:24px 16px 72px}
.num{font-variation-settings:"wdth" 62;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:.01em}
h1{font-size:30px;line-height:1.2;font-weight:600;margin:32px 0 12px}
h2{font-size:21px;line-height:1.3;font-weight:600;margin:56px 0 12px}
h3{font-size:17px;font-weight:600;margin:28px 0 8px}
p,ul,ol{margin:0 0 14px;max-width:62ch}
li{margin:0 0 6px}
a{color:inherit;text-decoration-thickness:1px;text-underline-offset:3px}
.muted{color:var(--muted)}
.small{font-size:15px}
.foot{font-size:13px}
.error{color:var(--pomegranate)}
.rule{border:0;border-top:1px solid var(--dial);margin:40px 0}
header.top{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
header.top .brand{font-weight:600;text-decoration:none}
header.top nav{display:flex;gap:20px;align-items:baseline;flex-wrap:wrap}
footer{margin-top:72px;padding-top:16px;border-top:1px solid var(--dial);display:flex;gap:20px;flex-wrap:wrap}
button,.button{font:inherit;font-size:17px;line-height:1.2;background:var(--ink);color:var(--bg);border:0;border-radius:2px;padding:11px 16px;cursor:pointer;text-decoration:none;display:inline-block}
button:disabled{opacity:.4;cursor:not-allowed}
button.text{background:none;color:var(--ink);padding:6px 0;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
button.danger{background:var(--pomegranate);color:#fff}
button.text.danger{background:none;color:var(--pomegranate)}
input,select{font:inherit;font-size:17px;color:var(--ink);background:transparent;border:1px solid var(--dial);border-radius:2px;padding:10px 11px;max-width:100%}
input[type=url],input[type=password],input.wide{width:100%}
label{display:block;margin:0 0 6px}
:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.stack>*+*{margin-top:12px}
[hidden]{display:none!important}
code,pre,.secret{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px}
pre{overflow-x:auto;padding:14px 16px;margin:0 0 16px;background:color-mix(in srgb,var(--dial) 45%,transparent);border-radius:2px;line-height:1.45}
.secret{display:block;word-break:break-all;padding:12px 0;border-top:1px solid var(--dial);border-bottom:1px solid var(--dial);margin:8px 0}
.title-row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;margin-top:32px}
.title-row h1{margin:0}
.devices{display:flex;gap:20px;flex-wrap:wrap;margin:10px 0 0}
.devices a[aria-current=true]{font-weight:600;text-decoration-thickness:2px}
.dial{display:block;width:80%;max-width:480px;margin:28px auto 8px;overflow:visible}
.dial .track{fill:none;stroke:var(--dial);stroke-width:2}
.dial .tick{stroke:var(--dial);stroke-width:2}
.dial .night{fill:var(--night)}
.dial .bar{stroke:var(--saffron);stroke-width:8;stroke-dasharray:1;stroke-dashoffset:0;animation:grow 180ms ease-out both}
.dial .hr{fill:var(--pomegranate)}
.dial .now{stroke:var(--ink);stroke-width:3;stroke-linecap:round}
.dial .label{fill:var(--muted);font-size:15px;font-variation-settings:"wdth" 62;font-weight:500}
.dial .big{fill:var(--ink);font-size:84px;font-variation-settings:"wdth" 62;font-weight:600}
.dial .cap{fill:var(--muted);font-size:17px}
${BAR_DELAYS}
@keyframes grow{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){.dial .bar{animation:none}}
.empty{text-align:center;margin:0 auto 8px;max-width:40ch}
.metrics{display:flex;gap:56px;flex-wrap:wrap;margin-top:24px}
.metric .value{font-size:56px;line-height:1}
.metric .label{color:var(--muted);font-size:15px;margin-top:4px}
.meta{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;color:var(--muted);font-size:15px;margin-top:20px}
.picker{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.picker label{margin:0}
.nav-days{display:flex;gap:20px;margin-top:12px}
table.days{width:100%;border-collapse:collapse;font-size:15px}
table.days th{font-weight:400;color:var(--muted);text-align:left;padding:8px 8px 8px 0}
table.days td{border-top:1px solid var(--dial);padding:10px 8px 10px 0;vertical-align:baseline}
table.days .n{text-align:right}
table.days td.n{font-size:20px}
table.days tr[aria-current=true] td:first-child{font-weight:600}
ul.hooks{list-style:none;padding:0;margin:0 0 16px;max-width:none}
ul.hooks li{border-top:1px solid var(--dial);padding:12px 0;margin:0}
ul.hooks .url{word-break:break-all}
.confirm{border-left:2px solid var(--pomegranate);padding:4px 0 4px 16px;margin-top:12px}
@media (max-width:480px){.metrics{gap:32px}.metric .value{font-size:48px}table.days .hide-s{display:none}}
`;

export interface PageOpts {
  title: string;
  nonce: string;
  body: Safe;
  script?: string;
  signedIn?: boolean;
  /** Extra header actions (e.g. sign-out button). */
  actions?: Safe;
}

export function page(o: PageOpts): string {
  return html`<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${o.title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin>
<style nonce="${o.nonce}">${raw(CSS)}</style>
</head>
<body>
<div class="wrap">
<header class="top">
  <a class="brand" href="${o.signedIn ? "/app" : "/"}">OpenBand</a>
  <nav>${o.actions ?? ""}</nav>
</header>
<main>
${o.body}
</main>
<footer class="foot muted">
  <a href="/">Ana sayfa</a>
  <a href="/docs">API belgesi</a>
  <a href="/privacy">Gizlilik</a>
</footer>
</div>
${o.script ? html`<script nonce="${o.nonce}">${raw(o.script)}</script>` : ""}
</body>
</html>`.value;
}
