"""Self-contained, review-only shallow-card viewer. No external requests."""
REVIEW_HTML = '''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dish presentation review</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f4ee;color:#252822;font:16px system-ui}main{max-width:760px;margin:auto;padding:24px}h1{font-size:26px}p{line-height:1.5}.controls{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0}button,a{font:inherit;padding:10px;border:1px solid #75796e;border-radius:8px;background:white;color:inherit}button:disabled{opacity:.5}button:focus-visible,a:focus-visible,#stage:focus-visible{outline:3px solid #416738;outline-offset:4px}
#stage{position:relative;aspect-ratio:1;overflow:hidden;border-radius:18px;background:#ebe7db;touch-action:pan-y;isolation:isolate}#original,#dish{width:100%;height:100%;object-fit:contain;display:block}#original{position:absolute;inset:0}#card{position:absolute;inset:0;background:radial-gradient(ellipse,#fffef9,#eae5d9);transform:perspective(900px) rotateX(0deg) rotateY(0deg);transition:transform 300ms ease-out;visibility:hidden}#stage.ready #card{visibility:visible}#stage.original #card{visibility:hidden}#dish{filter:drop-shadow(0 14px 9px #2223);transition:transform 300ms ease-out}#stage.tracking #card,#stage.tracking #dish{transition:transform 55ms linear}#stage[hidden]{display:none}#status{min-height:48px}small{display:block;line-height:1.5}
@media(prefers-reduced-motion:reduce){#card,#dish,#stage.tracking #card,#stage.tracking #dish{transition:none!important;transform:none!important}}
</style></head><body><main><h1>Dish presentation review</h1>
<p id="notice">Local review only · <strong>__MODE__</strong>. Not approved for publication. A supplied mask or generated PNG is required; this tool does not generate either.</p>
<div class="controls"><button id="compare" disabled aria-pressed="false">Show original photo</button><button id="reset">Reset view</button><a id="download" href="__ASSET__" download>Download output</a><a href="cutout.png" download>Download cutout PNG</a></div>
<div id="stage" tabindex="0" role="group" aria-label="Interactive dish preview" aria-describedby="instructions"><img id="original" src="fallback.jpg" alt="Original dish photograph"><div id="card"><img id="dish" alt="Review candidate"></div></div>
<p id="status" role="status">Original photo shown while the candidate loads.</p><p id="instructions">Move the pointer, drag horizontally on touch, or use arrow keys. Home resets. Vertical touch scrolling stays available. Motion is disabled with Reduce Motion.</p><small>Shallow 2.5D card effect, not a reconstructed 3D object. Generated images may change food details. Compare before approval.</small><p><a href="review-manifest.json">Processing evidence</a></p>
<script>
(function(){
'use strict';
var stage=document.getElementById('stage'),card=document.getElementById('card'),dish=document.getElementById('dish'),original=document.getElementById('original'),status=document.getElementById('status'),compare=document.getElementById('compare');
var query=matchMedia('(prefers-reduced-motion: reduce)'),ready=false,showOriginal=false,x=0,y=0,drag=null;
function render(){var off=query.matches||showOriginal||!ready;card.style.transform='perspective(900px) rotateX('+ (off?0:-y*3)+'deg) rotateY('+(off?0:x*3)+'deg)';dish.style.transform='translate('+(off?0:x*5)+'px,'+(off?0:y*3)+'px)';}
function reset(){drag=null;x=0;y=0;stage.classList.remove('tracking');render();}
function allowed(){return ready&&!showOriginal&&!query.matches;}
function clamp(n){return Math.max(-1,Math.min(1,n));}
function fail(){ready=false;reset();stage.classList.remove('ready');compare.disabled=true;if(!stage.hidden)status.textContent='Preview unavailable — showing the original photo.';}
original.addEventListener('error',function(){ready=false;reset();stage.hidden=true;compare.disabled=true;status.textContent='Original photo unavailable. Restore the fallback before reviewing.';});
dish.addEventListener('error',fail);
function loadCandidate(){
 if('__MODE__'==='fallback'){fail();return;}
 dish.src='__ASSET__';
 Promise.all([original.decode(),dish.decode()]).then(function(){ready=true;stage.classList.add('ready');compare.disabled=false;status.textContent='Review candidate loaded. Compare it with the original photo.';render();}).catch(fail);
}
compare.addEventListener('click',function(){showOriginal=!showOriginal;stage.classList.toggle('original',showOriginal);compare.setAttribute('aria-pressed',String(showOriginal));compare.textContent=showOriginal?'Show review candidate':'Show original photo';reset();status.textContent=showOriginal?'Original photo.':'Review candidate — not approved.';});
document.getElementById('reset').addEventListener('click',reset);
stage.addEventListener('pointerdown',function(e){if(e.pointerType!=='mouse'&&allowed()){drag={id:e.pointerId,x:e.clientX,y:e.clientY};}});
stage.addEventListener('pointermove',function(e){
 if(!allowed())return;
 var r=stage.getBoundingClientRect();if(!r.width||!r.height)return;
 if(e.pointerType==='mouse'){x=clamp((e.clientX-r.left)/r.width*2-1);y=clamp((e.clientY-r.top)/r.height*2-1);}
 else {if(!drag||e.pointerId!==drag.id)return;var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dy)>Math.abs(dx)&&Math.abs(dy)>8){reset();return;}x=clamp(dx/(r.width*.35));y=0;}
 stage.classList.add('tracking');render();
});
['pointerleave','pointercancel','blur'].forEach(function(name){stage.addEventListener(name,reset);});
window.addEventListener('pointerup',function(e){if(drag&&drag.id===e.pointerId)reset();});
stage.addEventListener('keydown',function(e){if(!allowed())return;var handled=true;if(e.key==='ArrowRight')x=clamp(x+1/6);else if(e.key==='ArrowLeft')x=clamp(x-1/6);else if(e.key==='ArrowDown')y=clamp(y+1/6);else if(e.key==='ArrowUp')y=clamp(y-1/6);else if(e.key==='Home')reset();else handled=false;if(handled){e.preventDefault();stage.classList.remove('tracking');render();}});
if(query.addEventListener)query.addEventListener('change',reset);else query.addListener(reset);
loadCandidate();
})();
</script></main></body></html>'''
