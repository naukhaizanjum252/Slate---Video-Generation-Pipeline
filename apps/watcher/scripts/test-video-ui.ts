/**
 * Local intro-compositor editor — a track-based timeline (NLE-style) for the
 * video-mode intro. Upload an intro clip (+ voiceover), drag the freeze block,
 * effects and sound clips on a timeline, and render with the REAL pipeline code
 * (buildIntroSpec) + the bundled assets.
 *
 * Needs ffmpeg + ffprobe on PATH (brew install ffmpeg).
 *   pnpm --filter @slate/watcher test-video-ui   →   http://localhost:5174
 *
 * Endpoints:
 *   GET  /          the editor page
 *   POST /probe     multipart single "file" → saves it, returns {id,duration,...}
 *   POST /render    JSON {introId, voiceoverId, spec} → renders → streams mp4
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import Busboy from 'busboy';
import { buildIntroSpec, type IntroSpec } from '../src/intro';
import { probeVideo } from '../src/video';
import { createLogger } from '../src/logger';

const log = createLogger('test-video-ui');
const PORT = Number(process.env.VIDEO_TEST_PORT) || 5174;
const HOST = process.env.VIDEO_TEST_HOST || '127.0.0.1';
const UPLOAD_DIR = path.join(os.tmpdir(), 'slate-introlab');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// NOTE: this is a template literal — the embedded client JS must avoid backticks
// and ${...} so it isn't interpreted by Node at load time.
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Slate · intro timeline editor</title>
<style>
  *{box-sizing:border-box}
  :root{
    --bg:#0b1018;--bg2:#0e141f;--panel:#141c2b;--panel2:#1a2333;--inset:#0f1623;
    --line:#26314a;--line-soft:#1d2638;--text:#e8edf7;--muted:#94a2be;--ghost:#5e6b86;
    --brand:#4d82f5;--brand-dim:#3a6fe0;--brand-soft:rgba(77,130,245,.14);
    --radius:14px;
    font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:var(--text)
  }
  html,body{margin:0}
  body{
    min-height:100vh;background:var(--bg);font-size:14px;
    background-image:radial-gradient(900px 500px at 88% -10%,rgba(77,130,245,.10),transparent 70%),radial-gradient(700px 460px at -4% 0,rgba(77,130,245,.05),transparent 60%);
    background-attachment:fixed;
  }
  ::selection{background:rgba(77,130,245,.3)}
  ::-webkit-scrollbar{width:11px;height:11px}
  ::-webkit-scrollbar-thumb{background:#2a3550;border-radius:7px;border:2px solid transparent;background-clip:content-box}
  ::-webkit-scrollbar-thumb:hover{background:#36456a;background-clip:content-box}

  /* top bar */
  .topbar{position:sticky;top:0;z-index:30;display:flex;align-items:center;gap:14px;
    padding:12px 22px;background:rgba(13,19,30,.82);backdrop-filter:blur(10px);border-bottom:1px solid var(--line-soft)}
  .brand{display:flex;align-items:center;gap:11px}
  .logo{display:grid;place-items:center;height:34px;width:34px;border-radius:10px;
    background:linear-gradient(140deg,#2a4fb0,#0c2350);box-shadow:0 0 0 1px rgba(77,130,245,.25),0 8px 22px -8px rgba(77,130,245,.5)}
  .brand-name{font-size:15px;font-weight:800;letter-spacing:-.01em;line-height:1}
  .brand-tag{font-size:11px;font-weight:600;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-top:3px}
  .spacer{flex:1}
  .status{font-size:12.5px;color:var(--muted);max-width:46ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}

  .wrap{max-width:1240px;margin:0 auto;padding:22px}
  .grid-top{display:grid;grid-template-columns:1fr;gap:16px;margin-bottom:16px}
  @media(min-width:900px){.grid-top{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)}}

  .panel{background:linear-gradient(180deg,var(--panel),var(--bg2));border:1px solid var(--line);border-radius:var(--radius);
    box-shadow:0 1px 0 rgba(255,255,255,.02) inset,0 20px 44px -28px rgba(0,0,0,.8)}
  .phead{display:flex;align-items:center;gap:8px;padding:13px 18px;border-bottom:1px solid var(--line-soft);
    font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
  .phead .dot{height:7px;width:7px;border-radius:50%;background:var(--brand);box-shadow:0 0 10px var(--brand)}
  .pbody{padding:16px 18px}

  .fields{display:flex;flex-wrap:wrap;gap:16px 22px}
  label.f{display:flex;flex-direction:column;font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.01em;gap:7px}
  label.f.row{flex-direction:row;align-items:center;gap:9px;padding-top:22px}
  .req{color:var(--brand);font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.05em}
  .hint{color:var(--ghost);font-weight:500}
  input[type=text],input[type=number],select{appearance:none;padding:8px 10px;border:1px solid var(--line);border-radius:9px;
    background:var(--inset);color:var(--text);font-size:13px;outline:none;transition:.15s}
  input[type=text]:focus,input[type=number]:focus,select:focus{border-color:var(--brand);box-shadow:0 0 0 3px var(--brand-soft)}
  input::placeholder{color:var(--ghost)}
  input[type=number]{width:104px}
  .propsgrid input[type=text]{width:210px}
  input[type=file]{font-size:12px;color:var(--muted);max-width:236px}
  input[type=file]::file-selector-button{margin-right:11px;padding:8px 13px;border-radius:9px;border:1px solid var(--line);
    background:var(--panel2);color:var(--text);font-weight:700;font-size:12px;cursor:pointer;transition:.15s}
  input[type=file]::file-selector-button:hover{border-color:var(--brand);color:#fff;background:#1f2c47}
  input[type=checkbox]{width:17px;height:17px;accent-color:var(--brand);cursor:pointer}

  button{background:var(--brand);color:#fff;border:0;border-radius:10px;padding:9px 18px;font-size:13.5px;font-weight:700;cursor:pointer;transition:.15s}
  button:hover{background:var(--brand-dim)}
  button.primary{box-shadow:0 8px 20px -8px rgba(77,130,245,.7)}
  button.sm{background:var(--panel2);color:var(--text);border:1px solid var(--line);padding:6px 12px;font-size:12px;font-weight:600;border-radius:9px}
  button.sm:hover{border-color:var(--brand);color:#fff;background:#1f2c47}
  button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
  button:disabled:hover{background:var(--brand)}

  .editor{margin-bottom:18px}
  .stage{padding:16px;background:radial-gradient(120% 120% at 50% 0,#0d1421,#080c14);border-bottom:1px solid var(--line-soft);
    display:flex;align-items:center;justify-content:center;min-height:120px}
  video{width:100%;max-height:62vh;border-radius:12px;background:#000;box-shadow:0 24px 60px -30px rgba(0,0,0,.9),0 0 0 1px var(--line)}

  .presets{display:flex;gap:9px;align-items:center;flex-wrap:wrap;padding:13px 18px;border-bottom:1px solid var(--line-soft);
    font-size:12px;font-weight:700;color:var(--muted)}
  .presets .lbl{text-transform:uppercase;letter-spacing:.08em;font-size:11px}
  .presets select,.presets input{padding:7px 9px;font-size:12px;font-weight:500}
  .presets input{width:150px}
  .presets .sep{color:var(--line);font-weight:400}

  /* timeline */
  .tl-wrap{overflow-x:auto;background:var(--inset);padding:12px;border-bottom:1px solid var(--line-soft)}
  .ruler{position:relative;height:20px;margin-left:110px;margin-bottom:2px}
  .tick{position:absolute;top:0;font-size:9px;color:var(--ghost);border-left:1px solid #2b3650;padding-left:3px;height:15px}
  .track{position:relative;height:40px;margin:7px 0;border-radius:9px;background:#0c131f;border:1px solid var(--line-soft)}
  .track .tlabel{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:10px;font-weight:800;color:var(--ghost);
    text-transform:uppercase;letter-spacing:.07em;z-index:2;pointer-events:none}
  .lane{position:absolute;left:110px;right:0;top:0;bottom:0}
  .blk{position:absolute;top:5px;height:30px;border-radius:7px;font-size:11px;font-weight:700;color:#fff;display:flex;align-items:center;
    justify-content:center;overflow:hidden;white-space:nowrap;user-select:none;box-shadow:0 2px 8px -2px rgba(0,0,0,.5)}
  .blk.clip{background:linear-gradient(180deg,#33405c,#283449);color:#aeb9d2;cursor:default;font-weight:600}
  .blk.freeze{background:linear-gradient(180deg,#4d82f5,#3a6fe0);cursor:grab}
  .blk.black{background:linear-gradient(180deg,#1a2742,#0e1830);cursor:default;color:#9fb0d0}
  .blk .rh{position:absolute;right:0;top:0;width:9px;height:100%;cursor:ew-resize;background:rgba(255,255,255,.28);border-radius:0 7px 7px 0}
  .blk .rh:hover{background:rgba(255,255,255,.5)}
  .mk{position:absolute;top:7px;height:26px;border-radius:7px;font-size:10px;font-weight:800;color:#fff;display:flex;align-items:center;
    justify-content:center;padding:0 8px;cursor:grab;user-select:none;box-shadow:0 2px 8px -2px rgba(0,0,0,.5);letter-spacing:.02em}
  .mk.flash{background:linear-gradient(180deg,#f7b13c,#e0921a);color:#241a06}
  .mk.glitch{background:linear-gradient(180deg,#a855f7,#8b2fe6)}
  .mk.text{background:linear-gradient(180deg,#16b894,#0f9678)}
  .mk .x2{margin-left:7px;cursor:pointer;opacity:.8;font-weight:800}
  .mk .x2:hover{opacity:1}
  .clipbar{position:absolute;top:5px;height:30px;border-radius:7px;font-size:11px;font-weight:700;color:#fff;display:flex;align-items:center;
    padding:0 9px;cursor:grab;user-select:none;overflow:hidden;white-space:nowrap;box-shadow:0 2px 8px -2px rgba(0,0,0,.5)}
  .clipbar .rh{position:absolute;right:0;top:0;width:9px;height:100%;cursor:ew-resize;background:rgba(255,255,255,.28)}
  .clipbar .rh:hover{background:rgba(255,255,255,.5)}
  .voiceover{background:linear-gradient(180deg,#4d82f5,#3a6fe0)}
  .music{background:linear-gradient(180deg,#64748b,#4a5566)}
  .grain{background:linear-gradient(180deg,#d2733a,#b4571f)}
  .boom{background:linear-gradient(180deg,#ef4444,#c8102e)}
  .click{background:linear-gradient(180deg,#4b5670,#363f54)}
  .arow{display:flex;align-items:center;gap:8px;margin:7px 0}
  .arow .meta{width:102px;flex:none;display:flex;align-items:center;gap:7px}
  .arow .akind{flex:1;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);overflow:hidden}
  .arow .lanebox{position:relative;flex:1;height:40px;border:1px solid var(--line-soft);border-radius:9px;background:#0c131f;overflow:hidden}
  .arow input.vol{width:50px;padding:5px 6px;font-size:11px}
  .arow .x{cursor:pointer;color:var(--ghost);font-weight:800;font-size:15px;line-height:1}
  .arow .x:hover{color:#ef6868}

  .toolbar{display:flex;flex-wrap:wrap;gap:22px;padding:14px 18px}
  .tgroup{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
  .tgl{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--ghost);margin-right:2px}

  .hidden{display:none}
</style></head><body>
<header class="topbar">
  <div class="brand">
    <span class="logo"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 8v8M8 10v4M16 10v4" stroke="#7aa2f7" stroke-width="1.6" stroke-linecap="round"/></svg></span>
    <div><div class="brand-name">Slate</div><div class="brand-tag">Intro Editor</div></div>
  </div>
  <div class="spacer"></div>
  <div id="status" class="status"></div>
  <button id="runBtn" class="primary" onclick="runRender()" disabled>Render</button>
</header>

<main class="wrap">
  <div class="grid-top">
    <section class="panel">
      <div class="phead"><span class="dot"></span>Source files</div>
      <div class="pbody fields">
        <label class="f">Intro clip <span class="req">required</span><input type="file" id="introFile" accept="video/*" /></label>
        <label class="f">Voiceover <span class="hint">optional audio</span><input type="file" id="voFile" accept="audio/*" /></label>
        <label class="f">Captions SRT <span class="hint">optional — else auto</span><input type="file" id="srtFile" accept=".srt,.vtt" /></label>
        <label class="f row">Auto-captions<input type="checkbox" id="autoCC" checked /></label>
      </div>
    </section>

    <section class="panel props hidden" id="props">
      <div class="phead"><span class="dot"></span>Properties</div>
      <div class="pbody fields propsgrid">
        <label class="f name">Subject name<input type="text" id="pName" placeholder="e.g. Sal Cangelosi" /></label>
        <label class="f">Zoom speed<input type="number" id="pZoom" step="0.01" min="1" /></label>
        <label class="f">Flash (s)<input type="number" id="pFlash" step="0.02" min="0" /></label>
        <label class="f">Glitch opacity<input type="number" id="pGlitch" step="0.05" min="0" max="1" /></label>
        <label class="f">Dot X (0-1)<input type="number" id="pTextX" step="0.02" min="0" max="1" title="where the pin dot points — put it on the subject" /></label>
        <label class="f">Dot Y (0-1)<input type="number" id="pTextY" step="0.02" min="0" max="1" title="where the pin dot points — put it on the subject" /></label>
        <label class="f row">Watermark<input type="checkbox" id="pWm" checked /></label>
      </div>
    </section>
  </div>

  <section class="panel editor hidden" id="editor">
    <div class="stage"><video id="out" controls></video></div>

    <div class="presets">
      <span class="lbl">Preset</span>
      <select id="presetSel"></select>
      <button class="sm" onclick="applySelectedPreset()">Apply</button>
      <button class="sm" onclick="deleteSelectedPreset()">Delete</button>
      <span class="sep">|</span>
      <input id="presetName" placeholder="new preset name" />
      <input id="presetChannel" placeholder="channel (optional)" />
      <button class="sm" onclick="savePreset()">Save preset</button>
    </div>

    <div class="tl-wrap">
      <div class="ruler" id="ruler"></div>
      <div class="track" id="videoTrack"><span class="tlabel">video</span><div class="lane" id="videoLane"></div></div>
      <div class="track" id="fxTrack"><span class="tlabel">effects</span><div class="lane" id="fxLane"></div></div>
      <div id="audioRows"></div>
    </div>

    <div class="toolbar">
      <div class="tgroup">
        <span class="tgl">Effects</span>
        <button class="sm" onclick="addFlash()">+ flash</button>
        <button class="sm" onclick="addGlitch()">+ glitch</button>
        <button class="sm" onclick="addText()">+ text</button>
      </div>
      <div class="tgroup">
        <span class="tgl">Sound</span>
        <button class="sm" onclick="addClip('click')">+ click</button>
        <button class="sm" onclick="addClip('boom')">+ boom</button>
        <button class="sm" onclick="addClip('grain')">+ grain</button>
        <button class="sm" onclick="addClip('music')">+ music</button>
        <button class="sm" onclick="addClip('voiceover')">+ voiceover</button>
      </div>
    </div>
  </section>
</main>

<script>
var PXPS = 64;            // pixels per second
var intro = null;        // {id,duration,width,height,hasAudio}
var vo = null;           // {id,duration}
var captionsId = null;   // uploaded SRT id (optional)
var spec = null;         // IntroSpec
var drag = null;         // active drag descriptor

function $(id){ return document.getElementById(id); }
function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
function r1(v){ return Math.round(v*10)/10; }

function total(){ return spec.pauseAtSec + spec.freezeDurationSec + Math.max(0.1, intro.duration - spec.pauseAtSec) + spec.blackSec; }
function seg2End(){ return spec.pauseAtSec + spec.freezeDurationSec + Math.max(0.1, intro.duration - spec.pauseAtSec); }

async function probe(file){
  var fd = new FormData(); fd.append('file', file);
  var r = await fetch('/probe', { method:'POST', body: fd });
  if(!r.ok) throw new Error(await r.text());
  return await r.json();
}

$('introFile').addEventListener('change', async function(e){
  var f = e.target.files[0]; if(!f) return;
  $('status').textContent = 'Reading clip...';
  try {
    intro = await probe(f);
    if(vo === null && $('voFile').files[0]) vo = await probe($('voFile').files[0]);
    spec = defaultSpec();
    $('props').classList.remove('hidden'); $('editor').classList.remove('hidden');
    $('runBtn').disabled = false;
    syncProps(); render();
    $('status').textContent = 'Clip ' + r1(intro.duration) + 's loaded. Drag things, then Render.';
  } catch(err){ $('status').textContent = 'Probe failed: ' + err; }
});
$('voFile').addEventListener('change', async function(e){
  var f = e.target.files[0]; if(!f){ vo = null; return; }
  try { vo = await probe(f); if(spec){ /* place a voiceover clip if none */ if(!spec.audio.some(function(a){return a.kind==='voiceover';})) addClip('voiceover'); render(); } }
  catch(err){ $('status').textContent = 'Voiceover probe failed: ' + err; }
});
$('srtFile').addEventListener('change', async function(e){
  var f = e.target.files[0]; if(!f){ captionsId = null; return; }
  try { var fd = new FormData(); fd.append('file', f); var r = await fetch('/upload', { method:'POST', body: fd });
    if(r.ok){ captionsId = (await r.json()).id; $('status').textContent = 'Captions SRT loaded.'; } }
  catch(err){ $('status').textContent = 'SRT upload failed: ' + err; }
});

function defaultSpec(){
  var voDur = vo ? vo.duration : 0;
  var T = clamp(intro.duration*0.2, 0.5, 4);
  var entrance = 1.0, exit = 0.9, black = 2.0, endTail = 3.0;
  var F = entrance + voDur + exit;
  var s = { pauseAtSec:T, freezeDurationSec:F, blackSec:black, zoom:1.2, flashSec:0.6,
            glitchDurationSec:exit, glitchOpacity:1.0,
            flashes:[{atSec:T}], glitches:[{atSec:T+entrance+voDur, opacity:1.0}],
            textStartSec:T+entrance, subjectName:'', textCenterX:0.5, textCenterY:0.4,
            hasText:true, hasWatermark:true, audio:[] };
  var s2 = T + F + Math.max(0.1, intro.duration - T);
  var totalD = s2 + black;
  s.audio.push({kind:'click', start:T, volume:1.0});
  s.audio.push({kind:'click', start:T+entrance+voDur, volume:1.0});
  s.audio.push({kind:'grain', start:Math.max(0,s2-endTail), duration:endTail, fadeInSec:endTail, volume:2.0});
  s.audio.push({kind:'boom', start:s2, volume:1.0});
  s.audio.push({kind:'music', start:0, duration:totalD, volume:0.5});
  if(voDur>0) s.audio.push({kind:'voiceover', start:T+entrance, duration:voDur, volume:1.0});
  return s;
}

function syncProps(){
  $('pName').value = spec.subjectName; $('pZoom').value = spec.zoom;
  $('pFlash').value = spec.flashSec;
  $('pGlitch').value = (spec.glitches && spec.glitches.length) ? spec.glitches[0].opacity : (spec.glitchOpacity != null ? spec.glitchOpacity : 1);
  $('pTextX').value = spec.textCenterX != null ? spec.textCenterX : 0.5;
  $('pTextY').value = spec.textCenterY != null ? spec.textCenterY : 0.4;
  $('pWm').checked = spec.hasWatermark !== false;
}
$('pName').addEventListener('input', function(){ spec.subjectName = this.value; });
$('pZoom').addEventListener('input', function(){ spec.zoom = parseFloat(this.value)||1; });
$('pFlash').addEventListener('input', function(){ spec.flashSec = parseFloat(this.value)||0; });
$('pGlitch').addEventListener('input', function(){ var v=parseFloat(this.value); spec.glitchOpacity = v; (spec.glitches||[]).forEach(function(g){ g.opacity = v; }); render(); });
$('pTextX').addEventListener('input', function(){ spec.textCenterX = clamp(parseFloat(this.value), 0, 1); });
$('pTextY').addEventListener('input', function(){ spec.textCenterY = clamp(parseFloat(this.value), 0, 1); });
$('pWm').addEventListener('change', function(){ spec.hasWatermark = this.checked; });

/* ---- drag ---- */
document.addEventListener('mousemove', function(e){ if(!drag) return; drag.apply((e.clientX - drag.x)/PXPS); render(); });
document.addEventListener('mouseup', function(){ if(drag){ drag=null; } });
function startDrag(e, apply){ e.preventDefault(); e.stopPropagation(); drag = { x:e.clientX, apply:apply }; }

/* drag handlers (read current values at mousedown, mutate spec on move) */
function dragFreezeMove(e){ var o=spec.pauseAtSec; startDrag(e, function(d){ spec.pauseAtSec = clamp(o+d, 0.2, intro.duration-0.3); var lo=spec.pauseAtSec, hi=spec.pauseAtSec+spec.freezeDurationSec; (spec.flashes||[]).forEach(function(f){ f.atSec=clamp(f.atSec,lo,hi); }); (spec.glitches||[]).forEach(function(g){ g.atSec=clamp(g.atSec,lo,hi); }); spec.textStartSec = clamp(spec.textStartSec, lo, hi); }); }
function dragFreezeSize(e){ var o=spec.freezeDurationSec; startDrag(e, function(d){ spec.freezeDurationSec = clamp(o+d, 0.5, 30); }); }
function dragBlackSize(e){ var o=spec.blackSec; startDrag(e, function(d){ spec.blackSec = clamp(o+d, 0, 10); }); }
function dragFlash(i,e){ var o=spec.flashes[i].atSec; startDrag(e, function(d){ spec.flashes[i].atSec = clamp(o+d, spec.pauseAtSec, spec.pauseAtSec+spec.freezeDurationSec); }); }
function dragGlitch(i,e){ var o=spec.glitches[i].atSec; startDrag(e, function(d){ spec.glitches[i].atSec = clamp(o+d, spec.pauseAtSec, spec.pauseAtSec+spec.freezeDurationSec); }); }
function dragText(e){ var o=spec.textStartSec; startDrag(e, function(d){ spec.textStartSec = clamp(o+d, spec.pauseAtSec, spec.pauseAtSec+spec.freezeDurationSec); }); }
function dragClipMove(i,e){ var o=spec.audio[i].start; startDrag(e, function(d){ spec.audio[i].start = clamp(o+d, 0, total()); }); }
function dragClipSize(i,e){ var o=spec.audio[i].duration||1; startDrag(e, function(d){ spec.audio[i].duration = clamp(o+d, 0.2, total()); }); }

function setVol(i,v){ spec.audio[i].volume = parseFloat(v)||0; }
function delClip(i){ spec.audio.splice(i,1); render(); }
/* add / delete visual effects. Flash + glitch are multi-instance (add as many as
   you like, each draggable); the name plate is a singleton (one name). */
function addFlash(){ if(!spec) return; if(!spec.flashes) spec.flashes=[]; if(!(spec.flashSec>0)) spec.flashSec=0.6; spec.flashes.push({atSec:spec.pauseAtSec}); render(); $('status').textContent='Flash added — drag it, then Render.'; }
function delFlash(i){ if(!spec||!spec.flashes) return; spec.flashes.splice(i,1); render(); $('status').textContent='Flash removed.'; }
function addGlitch(){ if(!spec) return; if(!spec.glitches) spec.glitches=[]; var hi=spec.pauseAtSec+spec.freezeDurationSec; spec.glitches.push({atSec:Math.max(spec.pauseAtSec,hi-0.6), opacity:(spec.glitchOpacity!=null?spec.glitchOpacity:1.0)}); render(); $('status').textContent='Glitch added — drag it, then Render.'; }
function delGlitch(i){ if(!spec||!spec.glitches) return; spec.glitches.splice(i,1); render(); $('status').textContent='Glitch removed.'; }
function addText(){ if(!spec) return; var wasOn=spec.hasText!==false; spec.hasText=true; var lo=spec.pauseAtSec, hi=spec.pauseAtSec+spec.freezeDurationSec; if(spec.textStartSec<lo||spec.textStartSec>hi) spec.textStartSec=lo+1; render(); $('status').textContent = wasOn ? 'Name plate is already on — click Render to preview.' : 'Name plate added — click Render to preview.'; }
function delText(){ if(!spec) return; spec.hasText=false; render(); $('status').textContent='Name plate removed.'; }
function addClip(kind){
  if(!spec) return;
  var c = { kind:kind, start: spec.pauseAtSec, volume: kind==='music'?0.5:(kind==='grain'?2.0:1.0) };
  if(kind==='music') c.duration = total();
  if(kind==='grain'){ c.duration = 3.0; c.fadeInSec = 3.0; }
  if(kind==='voiceover') c.duration = vo ? vo.duration : 3.0;
  spec.audio.push(c); render();
}

/* ---- render ---- */
function px(sec){ return Math.round(sec*PXPS); }
function render(){
  if(!spec||!intro) return;
  var totalD = total();
  // ruler
  var rul=''; for(var t=0;t<=Math.ceil(totalD);t++){ rul += '<span class="tick" style="left:'+px(t)+'px">'+t+'s</span>'; }
  $('ruler').innerHTML = rul; $('ruler').style.width = (px(totalD)+30)+'px';

  // video lane
  var T=spec.pauseAtSec, F=spec.freezeDurationSec, s2=seg2End();
  var vlane='';
  vlane += '<div class="blk clip" style="left:'+px(0)+'px;width:'+px(T)+'px">clip</div>';
  vlane += '<div class="blk freeze" style="left:'+px(T)+'px;width:'+px(F)+'px" onmousedown="dragFreezeMove(event)">FREEZE<div class="rh" onmousedown="dragFreezeSize(event)"></div></div>';
  vlane += '<div class="blk clip" style="left:'+px(s2-(intro.duration-T))+'px;width:'+px(intro.duration-T)+'px">clip</div>';
  vlane += '<div class="blk black" style="left:'+px(s2)+'px;width:'+px(spec.blackSec)+'px">BLACK<div class="rh" onmousedown="dragBlackSize(event)"></div></div>';
  $('videoLane').innerHTML = vlane;
  $('videoTrack').style.width = (px(totalD)+90)+'px';

  // fx lane (within freeze) — each effect optional, deletable via ×
  var fx='';
  var flashes=spec.flashes||[], glitches=spec.glitches||[];
  for(var fi=0; fi<flashes.length; fi++){
    fx += '<div class="mk flash" style="left:'+px(flashes[fi].atSec)+'px;width:'+Math.max(46,px(spec.flashSec))+'px" onmousedown="dragFlash('+fi+',event)" title="flash (drag)">flash<span class="x2" onmousedown="event.stopPropagation()" onclick="delFlash('+fi+')">×</span></div>';
  }
  for(var gj=0; gj<glitches.length; gj++){
    fx += '<div class="mk glitch" style="left:'+px(glitches[gj].atSec)+'px;width:62px" onmousedown="dragGlitch('+gj+',event)" title="glitch (drag)">glitch<span class="x2" onmousedown="event.stopPropagation()" onclick="delGlitch('+gj+')">×</span></div>';
  }
  if(spec.hasText!==false) fx += '<div class="mk text" style="left:'+px(spec.textStartSec)+'px;width:54px" onmousedown="dragText(event)" title="name text (drag)">text<span class="x2" onmousedown="event.stopPropagation()" onclick="delText()">×</span></div>';
  $('fxLane').innerHTML = fx;
  $('fxTrack').style.width = (px(totalD)+90)+'px';

  // audio rows — controls fixed on the left, lane aligned with the tracks above
  var rows='';
  for(var i=0;i<spec.audio.length;i++){
    var c=spec.audio[i];
    var hasDur = (c.kind==='music'||c.kind==='grain'||c.kind==='voiceover');
    var w = hasDur ? px(c.duration||1) : 14;
    var bar = '<div class="clipbar '+c.kind+'" style="left:'+px(c.start)+'px;width:'+Math.max(14,w)+'px" onmousedown="dragClipMove('+i+',event)">'+(hasDur?c.kind:'')+(hasDur?'<div class="rh" onmousedown="dragClipSize('+i+',event)"></div>':'')+'</div>';
    rows += '<div class="arow">'
         + '<div class="meta"><span class="akind">'+c.kind+'</span>'
         + '<input class="vol" title="volume" type="number" step="0.05" min="0" value="'+c.volume+'" onchange="setVol('+i+',this.value)" />'
         + '<span class="x" title="remove" onclick="delClip('+i+')">×</span></div>'
         + '<div class="lanebox" style="min-width:'+(px(totalD)+10)+'px">'+bar+'</div></div>';
  }
  $('audioRows').innerHTML = rows;
}

/* ---- render request ---- */
async function runRender(){
  if(!intro){ $('status').textContent='Upload an intro clip first.'; return; }
  var btn=$('runBtn'); btn.disabled=true; $('status').textContent='Rendering with ffmpeg...'; $('out').removeAttribute('src');
  try {
    var r = await fetch('/render', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ introId: intro.id, voiceoverId: vo?vo.id:null, captionsId: captionsId, autoCaptions: $('autoCC').checked, spec: spec }) });
    if(!r.ok){ $('status').textContent='Error: '+(await r.text()); return; }
    var b = await r.blob(); $('out').src = URL.createObjectURL(b); $('status').textContent='Done — preview below.';
  } catch(err){ $('status').textContent='Error: '+err; }
  finally { btn.disabled=false; }
}

/* ---- presets (relative style, reusable across clips) ---- */
var presetList = [];
function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
async function refreshPresets(){
  try {
    var r = await fetch('/presets'); presetList = await r.json();
    var opts = '<option value="">— preset —</option>';
    for(var i=0;i<presetList.length;i++){ var p=presetList[i]; opts += '<option value="'+p.id+'">'+esc(p.channel?(p.channel+' · '):'')+esc(p.name)+'</option>'; }
    $('presetSel').innerHTML = opts;
  } catch(e){}
}
function find(kind){ return spec.audio.find(function(a){ return a.kind===kind; }); }
function deriveParams(){
  var T=spec.pauseAtSec;
  var voc=find('voiceover'); var V=voc?(voc.duration||0):0;
  var entrance=clamp(spec.textStartSec - T, 0, spec.freezeDurationSec);
  var exit=Math.max(0, spec.freezeDurationSec - entrance - V);
  var grain=find('grain'), music=find('music'), boom=find('boom'), click=find('click');
  return { entranceSec:r1(entrance), exitSec:r1(exit), endTailSec:grain?(grain.duration||3):3, blackSec:spec.blackSec,
           zoom:spec.zoom, flashSec:spec.flashSec, glitchOpacity:spec.glitchOpacity,
           voVolume:voc?voc.volume:1, musicVolume:music?music.volume:0.5, grainVolume:grain?grain.volume:2,
           boomVolume:boom?boom.volume:1, clickVolume:click?click.volume:1,
           textCenterX:spec.textCenterX!=null?spec.textCenterX:0.5, textCenterY:spec.textCenterY!=null?spec.textCenterY:0.4,
           // Relative to the pause (T) so they re-apply correctly on clips of any length.
           flashes:(spec.flashes||[]).map(function(f){ return {rel:f.atSec-T}; }),
           glitches:(spec.glitches||[]).map(function(g){ return {rel:g.atSec-T, opacity:g.opacity}; }),
           // Preserve the EXACT audio layout (positions/durations/volumes) so a clip
           // dragged to the middle stays in the middle on re-apply.
           audio: spec.audio.map(function(a){ return Object.assign({}, a); }) };
}
function applyParams(p){
  if(!intro){ $('status').textContent='Load an intro clip first.'; return; }
  var V=vo?vo.duration:0;
  var T=spec?spec.pauseAtSec:clamp(intro.duration*0.2,0.5,4);
  var name=spec?spec.subjectName:'';
  var entrance=p.entranceSec||0, exit=p.exitSec||0, endTail=p.endTailSec||0, black=p.blackSec||0;
  var F=entrance+V+exit; var s2=T+F+Math.max(0.1,intro.duration-T); var totalD=s2+black;
  var audio;
  if(p.audio && p.audio.length){
    // Restore the saved layout verbatim — keep each clip's start so custom
    // positions survive. Only stretch music to the new total and the voiceover to
    // the loaded VO; drop voiceover clips if there's no VO loaded.
    audio = p.audio.filter(function(a){ return a.kind!=='voiceover' || V>0; }).map(function(a){
      var c = Object.assign({}, a);
      if(c.kind==='music') c.duration = totalD;
      if(c.kind==='voiceover') c.duration = V;
      c.start = clamp(c.start, 0, totalD);
      return c;
    });
  } else {
    audio=[
      {kind:'click',start:T,volume:p.clickVolume},
      {kind:'click',start:T+entrance+V,volume:p.clickVolume},
      {kind:'grain',start:Math.max(0,s2-endTail),duration:endTail,fadeInSec:endTail,volume:p.grainVolume},
      {kind:'boom',start:s2,volume:p.boomVolume},
      {kind:'music',start:0,duration:totalD,volume:p.musicVolume}
    ];
    if(V>0) audio.push({kind:'voiceover',start:T+entrance,duration:V,volume:p.voVolume});
  }
  var hi=T+F;
  var flashes = (p.flashes && p.flashes.length) ? p.flashes.map(function(f){ return {atSec:clamp(T+(f.rel||0),T,hi)}; }) : [{atSec:T}];
  var glitches = (p.glitches && p.glitches.length) ? p.glitches.map(function(g){ return {atSec:clamp(T+(g.rel||0),T,hi), opacity:(g.opacity!=null?g.opacity:p.glitchOpacity)}; }) : [{atSec:clamp(T+entrance+V,T,hi), opacity:p.glitchOpacity}];
  spec={pauseAtSec:T,freezeDurationSec:F,blackSec:black,zoom:p.zoom,flashSec:p.flashSec,
        glitchDurationSec:exit,glitchOpacity:p.glitchOpacity,flashes:flashes,glitches:glitches,
        textStartSec:T+entrance,subjectName:name,textCenterX:(p.textCenterX!=null?p.textCenterX:0.5),textCenterY:(p.textCenterY!=null?p.textCenterY:0.4),hasText:true,hasWatermark:(spec?spec.hasWatermark!==false:true),audio:audio};
  syncProps(); render();
}
function applySelectedPreset(){ var id=$('presetSel').value; var p=presetList.find(function(x){return x.id===id;}); if(!p){ $('status').textContent='Pick a preset to apply.'; return; } applyParams(p.params); $('status').textContent='Applied preset "'+p.name+'". Drag to fine-tune, then Render.'; }
async function savePreset(){
  if(!spec){ $('status').textContent='Load a clip and set things up first.'; return; }
  var name=$('presetName').value.trim(); if(!name){ $('status').textContent='Name the preset first.'; return; }
  var channel=$('presetChannel').value.trim();
  var r=await fetch('/presets',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,channel:channel,params:deriveParams()})});
  if(!r.ok){ $('status').textContent='Save failed: '+(await r.text()); return; }
  $('presetName').value=''; await refreshPresets(); $('status').textContent='Saved preset "'+name+'".';
}
async function deleteSelectedPreset(){ var id=$('presetSel').value; if(!id){ return; } await fetch('/presets/'+encodeURIComponent(id),{method:'DELETE'}); await refreshPresets(); $('status').textContent='Preset deleted.'; }
refreshPresets();
</script></body></html>`;

/** Save a single uploaded file to UPLOAD_DIR; resolve its path + original name. */
function saveSingleUpload(req: http.IncomingMessage): Promise<{ savedPath: string; filename: string } | null> {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024 } });
    let result: { savedPath: string; filename: string } | null = null;
    const writes: Promise<void>[] = [];
    bb.on('file', (_name, stream, info) => {
      if (!info.filename) {
        stream.resume();
        return;
      }
      const ext = path.extname(info.filename) || '.bin';
      const savedPath = path.join(UPLOAD_DIR, `${crypto.randomUUID()}${ext}`);
      const out = fs.createWriteStream(savedPath);
      stream.pipe(out);
      writes.push(
        new Promise<void>((res, rej) => {
          out.on('finish', () => res());
          out.on('error', rej);
          stream.on('error', rej);
        }),
      );
      result = { savedPath, filename: info.filename };
    });
    bb.on('close', () => {
      Promise.all(writes).then(() => resolve(result)).catch(reject);
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

/** Auto-generate an SRT from the voiceover via the OpenAI transcription API
 *  (fallback when no SRT is provided). Needs OPENAI_API_KEY; skips gracefully if
 *  unset or on error. No local install. */
async function autoCaption(voiceoverPath: string, outDir: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    log.warn('No OPENAI_API_KEY set — skipping auto-captions (upload an SRT instead).');
    return null;
  }
  try {
    const fd = new FormData();
    fd.append('file', new Blob([fs.readFileSync(voiceoverPath)]), path.basename(voiceoverPath));
    fd.append('model', process.env.OPENAI_STT_MODEL || 'whisper-1');
    fd.append('response_format', 'srt');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: fd,
    });
    if (!res.ok) {
      log.warn(`OpenAI transcription failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
      return null;
    }
    const srt = await res.text();
    const out = path.join(outDir, `auto-${crypto.randomUUID()}.srt`);
    fs.writeFileSync(out, srt);
    return out;
  } catch (err) {
    log.warn('Auto-caption (OpenAI) failed', err);
    return null;
  }
}

/** Save any uploaded file (e.g. an SRT) and return its id, without probing. */
async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const up = await saveSingleUpload(req);
    if (!up) {
      res.writeHead(400).end('No file uploaded.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: path.basename(up.savedPath) }));
  } catch (err) {
    res.writeHead(500).end(err instanceof Error ? err.message : String(err));
  }
}

async function handleProbe(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const up = await saveSingleUpload(req);
    if (!up) {
      res.writeHead(400).end('No file uploaded.');
      return;
    }
    const info = await probeVideo(up.savedPath);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({ id: path.basename(up.savedPath), duration: info.duration, width: info.width, height: info.height, hasAudio: info.hasAudio }),
    );
  } catch (err) {
    res.writeHead(500).end(err instanceof Error ? err.message : String(err));
  }
}

/** Resolve an upload id to its path, guarding against path traversal. */
function resolveUpload(id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null;
  const p = path.join(UPLOAD_DIR, path.basename(id));
  return fs.existsSync(p) ? p : null;
}

async function handleRender(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const { introId, voiceoverId, captionsId, autoCaptions, spec } = JSON.parse(body) as {
        introId: string;
        voiceoverId: string | null;
        captionsId?: string | null;
        autoCaptions?: boolean;
        spec: IntroSpec;
      };
      const introPath = resolveUpload(introId);
      if (!introPath) {
        res.writeHead(400).end('Intro clip not found — re-select the file.');
        return;
      }
      const voPath = voiceoverId ? resolveUpload(voiceoverId) : null;
      const outPath = path.join(UPLOAD_DIR, `out-${crypto.randomUUID()}.mp4`);

      // Captions: use the uploaded SRT, else auto-generate from the voiceover.
      let srtPath: string | null = captionsId ? resolveUpload(captionsId) : null;
      if (!srtPath && autoCaptions && voPath) {
        log.info('No SRT provided — auto-generating captions from the voiceover…');
        srtPath = await autoCaption(voPath, UPLOAD_DIR);
      }

      log.info(`Render — captions ${srtPath ? 'yes' : 'no'} — spec ${JSON.stringify(spec)}`);
      await buildIntroSpec(introPath, voPath, spec, outPath, srtPath);
      const stat = fs.statSync(outPath);
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': stat.size });
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => {
        try {
          fs.rmSync(outPath, { force: true });
        } catch {
          /* ignore */
        }
      });
    } catch (err) {
      log.error('Render failed', err);
      if (!res.headersSent) res.writeHead(500);
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
}

// ── Presets (relative style, reusable across clips; tagged per channel) ──
const PRESETS_FILE = path.join(__dirname, '..', 'intro-presets.json');
interface Preset {
  id: string;
  name: string;
  channel: string;
  params: Record<string, number>;
}
function loadPresets(): Preset[] {
  try {
    return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8')) as Preset[];
  } catch {
    return [];
  }
}
function savePresets(p: Preset[]): void {
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(p, null, 2));
}
function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(b));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(PAGE);
    return;
  }
  if (req.method === 'POST' && req.url === '/probe') {
    void handleProbe(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/upload') {
    void handleUpload(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/render') {
    void handleRender(req, res);
    return;
  }
  if (req.method === 'GET' && req.url === '/presets') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(loadPresets()));
    return;
  }
  if (req.method === 'POST' && req.url === '/presets') {
    readJson(req)
      .then((body) => {
        const b = body as { name?: string; channel?: string; params?: Record<string, number> };
        if (!b.name || !b.params) {
          res.writeHead(400).end('name and params are required');
          return;
        }
        const presets = loadPresets();
        const preset: Preset = { id: crypto.randomUUID(), name: b.name, channel: b.channel ?? '', params: b.params };
        presets.push(preset);
        savePresets(presets);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(preset));
      })
      .catch(() => res.writeHead(400).end('Invalid JSON'));
    return;
  }
  if (req.method === 'DELETE' && req.url && req.url.startsWith('/presets/')) {
    const id = decodeURIComponent(req.url.slice('/presets/'.length));
    savePresets(loadPresets().filter((p) => p.id !== id));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    return;
  }
  res.writeHead(404).end('Not found');
});

server.listen(PORT, HOST, () => {
  log.info(`Intro timeline editor at http://${HOST}:${PORT}  (ffmpeg required on PATH)`);
});
