HARNESS_HTML="""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>2.5D feasibility harness — not the diner viewer</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 12px 16px; border-bottom: 1px solid #8884; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .note { font-size: 12px; opacity: .75; margin: 0; }
  #stage-wrap { padding: 16px; }
  #stage { position: relative; width: 100%; max-width: 520px; margin: 0 auto; transform-style: preserve-3d; }
  #stage:focus-visible { outline: 2px solid #2563eb; outline-offset: 4px; }
  #fallback { display: block; width: 100%; height: auto; border-radius: 8px; background: #8882; }
  #layers { position: absolute; inset: 0; transform-style: preserve-3d; }
  #layers img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .25s ease; }
  #layers.ready img.loaded { opacity: 1; }
  #status { margin: 12px 16px; font-size: 14px; }
  #status.error { color: #b91c1c; }
  #metrics { margin: 0 16px 16px; padding: 12px; font-size: 12px; overflow-x: auto; background: #8881; border-radius: 8px; }
  button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid #8886; background: #8882; color: inherit; cursor: pointer; }
  .row { display: flex; gap: 8px; align-items: center; margin: 0 16px 12px; }
  @media (prefers-reduced-motion: reduce) { #layers img { transition: none; } }
</style>
</head>
<body>
<header>
  <h1>Feasibility harness — not the diner viewer.</h1>
  <p class="note">Local sample for the 2.5D feasibility gate. The approved T0 dish photo is always shown; layers are additive and never replace it.</p>
</header>
<div id="stage-wrap">
  <div id="stage" tabindex="0" role="application" aria-label="2.5D feasibility stage">
    <img id="fallback" src="./fallback.jpg" alt="Approved dish photo">
    <div id="layers"></div>
  </div>
</div>
<p id="status" role="status">Loading spatial manifest…</p>
<div class="row">
  <button id="copy-metrics" type="button">Copy metrics</button>
  <span id="copy-state" class="note"></span>
</div>
<pre id="metrics">{}</pre>
<script>
(function(){
  "use strict";
  var MANIFEST_URL="./spatial-manifest.json";
  var FALLBACK_URL="./fallback.jpg";
  var RETRY_DELAY_MS=250;
  var FRAME_SAMPLES=120;
  var FALLBACK_ERROR="fallback_load_failed";
  var LAYER_ERROR="layer_load_failed";
  var CSS_ERROR="css_3d_unsupported";
  var UNAVAILABLE="Preview unavailable — showing the approved dish photo.";

  var stage=document.getElementById("stage");
  var fallback=document.getElementById("fallback");
  var layerHost=document.getElementById("layers");
  var statusNode=document.getElementById("status");
  var metricsNode=document.getElementById("metrics");
  var copyButton=document.getElementById("copy-metrics");
  var copyState=document.getElementById("copy-state");

  var motionQuery=window.matchMedia?window.matchMedia("(prefers-reduced-motion: reduce)"):null;
  var reducedMotion=Boolean(motionQuery&&motionQuery.matches);
  var metrics={
    schemaVersion:1,
    manifestFetchMs:0,
    manifestRetries:0,
    imageDecodeMs:Object.create(null),
    layerRetries:Object.create(null),
    firstRenderMs:0,
    averageFrameMs:0,
    p95FrameMs:0,
    viewport:{width:window.innerWidth, height:window.innerHeight, dpr:window.devicePixelRatio||1},
    reducedMotion:reducedMotion,
    layersLoaded:0,
    fallbackVisible:false,
    fallbackError:null,
    spatialVisible:false,
    spatialError:null,
    totalAssetBytes:0,
    budgetBytes:0
  };
  var manifest=null;
  var yaw=0;
  var pitch=0;
  var pointer={x:0,y:0};
  var keyboard={yaw:0,pitch:0};
  var frameSamples=[];
  var sampling=false;
  var firstRenderRecorded=false;

  function publish(){
    metricsNode.textContent=JSON.stringify(metrics,null,2);
    window.__peekaplateSpatialMetrics=metrics;
  }

  function setStatus(text,isError){
    statusNode.textContent=text;
    statusNode.className=isError?"error":"";
  }

  function clamp(value,limit){
    if(!(limit>0)){return 0;}
    if(value>limit){return limit;}
    if(value<-limit){return -limit;}
    return value;
  }

  function recordFirstRender(){
    if(firstRenderRecorded){return;}
    firstRenderRecorded=true;
    metrics.firstRenderMs=performance.now();
    publish();
  }
  function clearTransforms(){
    layerHost.style.transform="";
    layerHost.querySelectorAll("img").forEach(function(image){image.style.transform="";});
  }

  function syncReducedMotion(nextValue){
    var active=typeof nextValue==="boolean"?nextValue:Boolean(motionQuery&&motionQuery.matches);
    if(active===reducedMotion&&metrics.reducedMotion===active){return active;}
    reducedMotion=active;
    metrics.reducedMotion=active;
    if(reducedMotion){
      yaw=0;
      pitch=0;
      pointer.x=0;
      pointer.y=0;
      keyboard.yaw=0;
      keyboard.pitch=0;
      clearTransforms();
    }else if(manifest){
      render();
    }
    publish();
    return reducedMotion;
  }

  function onMotionChange(event){
    syncReducedMotion(event&&typeof event.matches==="boolean"?event.matches:Boolean(motionQuery&&motionQuery.matches));
  }

  if(motionQuery){
    if(typeof motionQuery.addEventListener==="function"){
      motionQuery.addEventListener("change",onMotionChange);
    }else if(typeof motionQuery.addListener==="function"){
      motionQuery.addListener(onMotionChange);
    }
  }

  function render(){
    if(syncReducedMotion()||!manifest){
      clearTransforms();
      return;
    }
    var maxYaw=manifest.motion.max_yaw_degrees;
    var maxPitch=manifest.motion.max_pitch_degrees;
    yaw=clamp(pointer.x*maxYaw+keyboard.yaw, maxYaw);
    pitch=clamp(-pointer.y*maxPitch+keyboard.pitch, maxPitch);
    keyboard.yaw=yaw-pointer.x*maxYaw;
    keyboard.pitch=pitch+pointer.y*maxPitch;
    // Normalized contribution of the combined rotation, so keyboard input moves layers too.
    var normX=maxYaw>0?yaw/maxYaw:0;
    var normY=maxPitch>0?-pitch/maxPitch:0;
    layerHost.style.transform="perspective(900px) rotateX("+pitch+"deg) rotateY("+yaw+"deg)";
    manifest.layers.forEach(function(layer){
      var element=layerHost.querySelector('[data-layer="'+layer.name+'"]');
      if(!element){return;}
      element.style.transform="translate("+(normX*layer.depth*8)+"px,"+(normY*layer.depth*4)+"px)";
    });
  }

  function onPointerMove(event){
    if(syncReducedMotion()||!manifest){return;}
    var rect=stage.getBoundingClientRect();
    if(!rect.width||!rect.height){return;}
    var maxYaw=manifest.motion.max_yaw_degrees;
    var maxPitch=manifest.motion.max_pitch_degrees;
    pointer.x=clamp(((event.clientX-rect.left)/rect.width)*2-1, 1);
    pointer.y=clamp(((event.clientY-rect.top)/rect.height)*2-1, 1);
    keyboard.yaw=clamp(pointer.x*maxYaw+keyboard.yaw,maxYaw)-pointer.x*maxYaw;
    keyboard.pitch=clamp(-pointer.y*maxPitch+keyboard.pitch,maxPitch)+pointer.y*maxPitch;
    render();
  }

  function onKeyDown(event){
    if(syncReducedMotion()||!manifest){return;}
    var step=0.5;
    var maxYaw=manifest.motion.max_yaw_degrees;
    var maxPitch=manifest.motion.max_pitch_degrees;
    var handled=true;
    if(event.key==="ArrowLeft"){keyboard.yaw=clamp(pointer.x*maxYaw+keyboard.yaw-step,maxYaw)-pointer.x*maxYaw;}
    else if(event.key==="ArrowRight"){keyboard.yaw=clamp(pointer.x*maxYaw+keyboard.yaw+step,maxYaw)-pointer.x*maxYaw;}
    else if(event.key==="ArrowUp"){keyboard.pitch=clamp(-pointer.y*maxPitch+keyboard.pitch+step,maxPitch)+pointer.y*maxPitch;}
    else if(event.key==="ArrowDown"){keyboard.pitch=clamp(-pointer.y*maxPitch+keyboard.pitch-step,maxPitch)+pointer.y*maxPitch;}
    else if(event.key==="Home"){keyboard.yaw=0;keyboard.pitch=0;pointer.x=0;pointer.y=0;}
    else{handled=false;}
    if(handled){event.preventDefault();render();}
  }

  stage.addEventListener("pointermove",onPointerMove);
  stage.addEventListener("keydown",onKeyDown);

  function delay(ms){
    return new Promise(function(resolve){setTimeout(resolve,ms);});
  }

  function decode(url){
    return new Promise(function(resolve,reject){
      var image=new Image();
      image.onload=function(){resolve(image);};
      image.onerror=function(){reject(new Error("image_load_failed"));};
      image.src=url;
    });
  }

  function fetchManifest(attempt){
    var started=performance.now();
    return fetch(MANIFEST_URL,{cache:"no-store"}).then(function(response){
      if(!response.ok){throw new Error("manifest_http_"+response.status);}
      return response.json();
    }).then(function(value){
      metrics.manifestFetchMs=performance.now()-started;
      publish();
      return value;
    }).catch(function(error){
      if(attempt>=1){throw error;}
      metrics.manifestRetries+=1;
      publish();
      return delay(RETRY_DELAY_MS).then(function(){return fetchManifest(attempt+1);});
    });
  }

  function loadFallback(){
    return decode(FALLBACK_URL).then(function(){
      fallback.src=FALLBACK_URL;
      metrics.fallbackVisible=true;
      metrics.fallbackError=null;
      publish();
      recordFirstRender();
    }).catch(function(){
      metrics.fallbackVisible=false;
      metrics.fallbackError=FALLBACK_ERROR;
      metrics.spatialVisible=false;
      layerHost.style.display="none";
      setStatus("Dish photo unavailable.",true);
      publish();
      throw new Error(FALLBACK_ERROR);
    });
  }

  function failSpatial(reason){
    metrics.spatialVisible=false;
    metrics.spatialError=reason;
    layerHost.style.display="none";
    setStatus(UNAVAILABLE,true);
    publish();
  }

  function loadLayer(layer,rank,attempt){
    var started=performance.now();
    var url=attempt===0?layer.path:layer.path+"?retry=1";
    return decode(url).then(function(image){
      metrics.imageDecodeMs[layer.name]=performance.now()-started;
      image.dataset.layer=layer.name;
      image.alt="";
      // Stable depth rank decides paint order so closely spaced or delayed layers cannot collide.
      image.style.zIndex=String(rank);
      layerHost.appendChild(image);
      return image;
    }).catch(function(error){
      if(attempt>=1){throw error;}
      var previousRetries=Object.prototype.hasOwnProperty.call(metrics.layerRetries,layer.name)?metrics.layerRetries[layer.name]:0;
      metrics.layerRetries[layer.name]=previousRetries+1;
      publish();
      return delay(RETRY_DELAY_MS).then(function(){return loadLayer(layer,rank,attempt+1);});
    });
  }

  function startFrameSampling(){
    if(sampling){return;}
    sampling=true;
    var previous=null;
    function tick(now){
      if(previous!==null){frameSamples.push(now-previous);}
      previous=now;
      if(frameSamples.length<FRAME_SAMPLES){
        requestAnimationFrame(tick);
        return;
      }
      var sorted=frameSamples.slice().sort(function(a,b){return a-b;});
      var total=sorted.reduce(function(sum,value){return sum+value;},0);
      metrics.averageFrameMs=total/sorted.length;
      metrics.p95FrameMs=sorted[Math.max(0,Math.ceil(0.95*sorted.length)-1)];
      publish();
    }
    requestAnimationFrame(tick);
  }

  function start(){
    loadFallback().then(function(){
      return fetchManifest(0);
    }).then(function(value){
      manifest=value;
      metrics.totalAssetBytes=value.measurements.total_asset_bytes;
      metrics.budgetBytes=value.measurements.budget_bytes;
      stage.style.aspectRatio=value.fallback.width+" / "+value.fallback.height;
      fallback.src=value.fallback.path;
      publish();
      if(!(window.CSS&&window.CSS.supports&&window.CSS.supports("transform","rotateY(1deg)"))){
        failSpatial(CSS_ERROR);
        return;
      }
      var ordered=value.layers.map(function(layer,index){return {name:layer.name,depth:layer.depth,index:index};});
      ordered.sort(function(a,b){return a.depth!==b.depth?a.depth-b.depth:a.index-b.index;});
      var ranks=Object.create(null);
      ordered.forEach(function(entry,rank){ranks[entry.name]=rank+1;});
      var jobs=[];
      value.layers.forEach(function(layer){jobs.push(loadLayer(layer,ranks[layer.name],0));});
      return Promise.all(jobs).then(function(images){
        metrics.layersLoaded=value.layers.length;
        layerHost.classList.add("ready");
        images.forEach(function(image){image.classList.add("loaded");});
        metrics.spatialVisible=true;
        setStatus("Spatial layers loaded. Move the pointer or use the arrow keys.",false);
        publish();
        recordFirstRender();
        render();
        startFrameSampling();
      }).catch(function(){
        failSpatial(LAYER_ERROR);
      });
    }).catch(function(error){
      if(error&&error.message===FALLBACK_ERROR){return;}
      setStatus(UNAVAILABLE,false);
      publish();
    });
  }

  copyButton.addEventListener("click",function(){
    var text=JSON.stringify(metrics,null,2);
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(function(){copyState.textContent="Copied.";}).catch(function(){copyState.textContent="Copy failed; select the JSON below.";});
      return;
    }
    copyState.textContent="Copy failed; select the JSON below.";
  });

  publish();
  start();
})();
</script>
</body>
</html>
"""
