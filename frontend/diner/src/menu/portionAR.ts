import type { PublicPortion } from '@peekaplate/contracts';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bindPortionTilt, tiltAngles } from './portionTilt';

export function portionWorldWidth(size?: PublicPortion['physical_size']) {
  return size ? size.plate.width_mm / 1000 / size.plate.boundary.width : 0.3;
}

// Local review only. The caller imports this module behind the explicit DEV fixture gate.
export function bindPortionAR(
  controls: HTMLElement,
  source: () => HTMLImageElement | null,
  modelUrl: () => string | undefined,
  sampleNotice?: string,
  orientation?: { request: () => void; release: () => void },
  physicalSize?: PublicPortion['physical_size'],
  originalSource?: () => HTMLImageElement | null,
) {
  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'View on your table';
  controls.append(open);
  let closeCurrent: (() => void) | undefined;
  let disposed = false;

  const show = () => {
    if (disposed || closeCurrent) return;
    const image = source();
    if (!image?.complete || !image.naturalWidth) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'pp-ar';
    dialog.setAttribute('aria-label', 'Dish on your table');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `<video class="pp-ar__camera" muted playsinline aria-hidden="true"></video>
      <div class="pp-ar__canvas" tabindex="0" role="img" aria-label="Dish preview. Drag or use arrow keys to tilt. Home resets tilt."></div>
      <p class="pp-ar__tilt-hint">Drag to tilt the plate</p>
      <header class="pp-ar__header"><button class="pp-back pp-ar__back" type="button" data-action="close" aria-label="Back to preview"></button><button type="button" data-action="original" aria-pressed="false">Original photo</button><h2 class="pp-sr-only">Dish on your table</h2></header>
      <p class="pp-ar__rotate-hint" role="status">Rotate your phone sideways to view the dish.</p>
      <p class="pp-ar__scale-status" role="status"></p>
      <details class="pp-ar__settings"><summary>Adjust view</summary><div class="pp-ar__panel">
        <p class="pp-ar__message" role="status">Checking table AR support…</p>
        <p>Visual scale only. This is not a serving-size measurement.</p>
        <div class="pp-ar__actions">
          <button type="button" data-action="start" disabled>Start camera preview</button>
          <button type="button" data-action="place" hidden>Place dish</button>
          <button type="button" data-action="reset" hidden>Reposition</button>
          <button type="button" data-action="tilt-reset">Reset tilt</button>
          <button type="button" data-action="mode" hidden>Show 3D</button>
        </div>
        <label>Rotate dish <input aria-label="Rotate dish" type="range" min="-180" max="180" value="0" disabled></label>
        <label>Visual size <input aria-label="Visual size" type="range" min="50" max="150" value="100" disabled></label>
      </div></details>`;
    if (sampleNotice) {
      const notice = document.createElement('p');
      notice.className = 'pp-ar__sample-notice';
      notice.textContent = sampleNotice;
      dialog.querySelector('.pp-ar__panel')!.prepend(notice);
    }
    const button = (name: string) =>
      dialog.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!;
    const original = document.createElement('img');
    original.className = 'pp-ar__original';
    original.hidden = true;
    const originalPhoto = originalSource?.();
    button('original').hidden = !originalPhoto?.src;
    if (originalPhoto) {
      original.src = originalPhoto.currentSrc || originalPhoto.src;
      original.alt = originalPhoto.alt || 'Original dish photo';
      original.addEventListener('error', () => {
        original.alt = 'Original photo unavailable. Return to AR to continue.';
      });
    }
    dialog.append(original);
    button('original').addEventListener('click', () => {
      original.hidden = !original.hidden;
      button('original').textContent = original.hidden ? 'Original photo' : 'Return to AR';
      button('original').setAttribute('aria-pressed', String(!original.hidden));
      dialog.classList.toggle('pp-ar--original', !original.hidden);
      canvasHost.inert = !original.hidden;
    });
    const start = button('start');
    const place = button('place');
    const reset = button('reset');
    const mode = button('mode');
    const message = dialog.querySelector<HTMLElement>('.pp-ar__message')!;
    const scaleStatus = dialog.querySelector<HTMLElement>('.pp-ar__scale-status')!;
    const video = dialog.querySelector<HTMLVideoElement>('video')!;
    const canvasHost = dialog.querySelector<HTMLElement>('.pp-ar__canvas')!;
    const rotation = dialog.querySelector<HTMLInputElement>('[aria-label="Rotate dish"]')!;
    const size = dialog.querySelector<HTMLInputElement>('[aria-label="Visual size"]')!;
    video.muted = true;
    document.body.append(dialog);
    dialog.showModal();
    orientation?.request();
    button('close').focus();
    const abort = new AbortController();
    let live = true;
    let busy = false;
    let tracked = false;
    let xrSupported = false;
    let placed = false;
    let running = false;
    let session: XRSession | undefined;
    let hits: XRHitTestSource | undefined;
    let space: XRReferenceSpace | undefined;
    let stream: MediaStream | undefined;
    let renderer: THREE.WebGLRenderer | undefined;
    let model: THREE.Object3D | undefined;
    let use3d = false;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 20);
    const anchor = new THREE.Group();
    const content = new THREE.Group();
    anchor.add(content);
    anchor.visible = false;
    scene.add(anchor, new THREE.HemisphereLight(0xffffff, 0x666666, 3));
    const light = new THREE.DirectionalLight(0xffffff, 3);
    light.position.set(1, 3, 2);
    scene.add(light);
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    const width = portionWorldWidth(physicalSize);
    const height = width * (image.naturalHeight / image.naturalWidth);
    let cameraScale = 0.3 / width;
    const cutout = new THREE.Group();
    // Seven copies of the same captured cutout; darker back layers imply a thin rim.
    // No generated food pixels or changes to the calibrated plate dimensions.
    const geometry = new THREE.PlaneGeometry(width, height);
    for (let layer = 0; layer < 7; layer++) {
      const face = new THREE.Mesh(
        geometry,
        new THREE.MeshBasicMaterial({
          map: texture,
          color: new THREE.Color().setScalar(layer === 6 ? 1 : 0.35 + layer * 0.05),
          transparent: true,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      face.position.z = ((layer - 6) * width * 1.6) / 320;
      face.renderOrder = layer;
      cutout.add(face);
    }
    cutout.position.y = height / 2;
    content.add(cutout);
    const plate = physicalSize?.plate;
    const footprint = plate
      ? new THREE.Mesh(
          plate.shape === 'round'
            ? new THREE.RingGeometry(
                plate.width_mm / 2000 - 0.002,
                plate.width_mm / 2000,
                64,
              ).rotateX(-Math.PI / 2)
            : new THREE.PlaneGeometry(plate.width_mm / 1000, plate.depth_mm / 1000).rotateX(
                -Math.PI / 2,
              ),
          new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.45,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        )
      : undefined;
    if (footprint) {
      footprint.position.y = 0.001;
      footprint.visible = false;
      anchor.add(footprint);
    }
    const reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.055, 0.07, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    const tilt = bindPortionTilt(
      canvasHost,
      () => running && placed && !use3d && original.hidden === true,
      (x, y) => {
        const angles = tiltAngles(x, y);
        // Rotate only the appearance, never the measured footprint or its world anchor.
        cutout.rotation.set(
          THREE.MathUtils.degToRad(angles.pitch),
          THREE.MathUtils.degToRad(angles.yaw),
          THREE.MathUtils.degToRad(angles.roll),
          'XZY',
        );
        canvasHost.setAttribute(
          'aria-label',
          `Dish preview. Tilt ${Math.round(angles.pitch)} degrees forward, ${Math.round(angles.yaw)} degrees sideways. Drag or use arrow keys; Home resets tilt.`,
        );
      },
    );
    button('tilt-reset').addEventListener('click', () => tilt.reset());
    const disposeObject = (object: THREE.Object3D) => {
      const textures = new Set<THREE.Texture>();
      object.traverse((node) => {
        if (!(node instanceof THREE.Mesh)) return;
        node.geometry.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          for (const value of Object.values(material))
            if (value instanceof THREE.Texture) textures.add(value);
          material.dispose();
        }
      });
      const bitmaps = new Set<ImageBitmap>();
      for (const item of textures) {
        if (typeof ImageBitmap !== 'undefined' && item.image instanceof ImageBitmap)
          bitmaps.add(item.image);
        item.dispose();
      }
      // GLTFLoader owns decoded bitmaps; Three texture.dispose only releases GPU storage.
      // The cutout uses the shared HTMLImageElement, which must stay available underneath.
      for (const bitmap of bitmaps) bitmap.close();
    };
    const stopCamera = () => {
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = undefined;
      video.srcObject = null;
    };
    const resize = () => {
      if (!renderer || session) return;
      const bounds = canvasHost.getBoundingClientRect();
      camera.aspect = bounds.width / Math.max(1, bounds.height);
      camera.fov = THREE.MathUtils.radToDeg(
        2 * Math.atan(Math.min(bounds.width, bounds.height) / (2 * 900)),
      );
      camera.updateProjectionMatrix();
      renderer.setSize(bounds.width, bounds.height);
      if (placed && !tracked) placeDish();
    };
    const close = () => {
      if (!live) return;
      live = false;
      abort.abort();
      tilt.dispose();
      orientation?.release();
      stopCamera();
      hits?.cancel();
      renderer?.setAnimationLoop(null);
      const end = session?.end().catch(() => {});
      void Promise.resolve(end).finally(() => {
        disposeObject(scene);
        renderer?.dispose();
      });
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', close);
      dialog.close();
      dialog.remove();
      closeCurrent = undefined;
      if (!disposed && open.isConnected) {
        const collapsed = open.closest('details:not([open])');
        const target = collapsed?.querySelector<HTMLElement>('summary') ?? open;
        target.focus();
      }
    };
    closeCurrent = close;
    const hidden = () => {
      if (document.hidden && !session) close();
    };
    const updateScaleStatus = () => {
      const prefix = sampleNotice?.includes('shared sample cutout')
        ? 'Shared sample, not this dish · '
        : 'Review preview · ';
      scaleStatus.textContent =
        prefix +
        (plate
          ? `Owner plate: ${plate.width_mm / 10} × ${plate.depth_mm / 10} cm · ${tracked ? 'measured footprint; appearance approximate, device validation pending' : 'camera scale is approximate'}`
          : 'Approximate preview · owner plate calibration not supplied');
    };
    const changed = () => {
      content.rotation.y = THREE.MathUtils.degToRad(Number(rotation.value));
      content.scale.setScalar(
        tracked && physicalSize ? 1 : (cameraScale * Number(size.value)) / 100,
      );
    };
    rotation.addEventListener('input', changed);
    size.addEventListener('input', changed);
    button('close').addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      close();
    });
    dialog.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    for (const panel of dialog.querySelectorAll('.pp-ar__header, .pp-ar__settings')) {
      panel.addEventListener('beforexrselect', (event) => event.preventDefault());
    }
    window.addEventListener('resize', resize);
    window.addEventListener('pagehide', close);
    document.addEventListener('visibilitychange', hidden);

    const placeDish = () => {
      if (!running || (tracked && !reticle.visible)) return;
      if (tracked) anchor.position.setFromMatrixPosition(reticle.matrix);
      else {
        const viewport = canvasHost.getBoundingClientRect();
        const top =
          dialog.querySelector('.pp-ar__header')!.getBoundingClientRect().bottom - viewport.top;
        const bottom = viewport.height - 48;
        const right = viewport.width;
        const pixelsPerUnit =
          viewport.height / (2 * 0.85 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
        cameraScale =
          Math.min((right * 0.85) / width, ((bottom - top) * 0.9) / height) / pixelsPerUnit;
        anchor.position.set(
          (right / 2 - viewport.width / 2) / pixelsPerUnit,
          (viewport.height / 2 - (top + bottom) / 2) / pixelsPerUnit - (height * cameraScale) / 2,
          -0.85,
        );
      }
      // Keep the cutout upright at its contact point; it remains a flat image, not inferred geometry.
      anchor.quaternion.identity();
      placed = true;
      anchor.visible = true;
      reticle.visible = false;
      place.hidden = true;
      reset.hidden = false;
      rotation.disabled = false;
      size.disabled = tracked && !!physicalSize;
      if (footprint) footprint.visible = tracked;
      cutout.position.set(
        tracked && plate ? width * (0.5 - plate.boundary.x - plate.boundary.width / 2) : 0,
        tracked && plate ? height * (plate.boundary.y + plate.boundary.height - 0.5) : height / 2,
        0,
      );
      changed();
      updateScaleStatus();
      message.textContent = tracked
        ? 'Placed on the detected surface. Drag to tilt; Reposition finds a new table position.'
        : 'Approximate camera placement — no surface tracking. Drag to tilt; Reposition recentres the dish.';
    };
    place.addEventListener('click', placeDish);
    reset.addEventListener('click', () => {
      tilt.reset(false);
      placed = false;
      anchor.visible = false;
      reset.hidden = true;
      place.hidden = false;
      place.disabled = tracked;
      rotation.value = '0';
      size.value = '100';
      changed();
      if (!tracked) {
        placeDish();
        return;
      }
      message.textContent = tracked
        ? 'Move your phone slowly over a table. Wait for the placement ring.'
        : 'Manual camera preview — no surface tracking. Tap Place dish to position it.';
    });
    const activate = () => {
      running = true;
      start.hidden = tracked || !xrSupported;
      place.hidden = false;
      place.disabled = tracked;
      resize();
      renderer!.setAnimationLoop((_time, frame) => {
        if (!live) return;
        if (tracked && frame && hits && space && !placed) {
          const pose = frame.getHitTestResults(hits)[0]?.getPose(space);
          // Only approximately horizontal, upward-facing surfaces qualify as tables/floors.
          reticle.visible = !!pose && pose.transform.matrix[5]! > 0.85;
          if (reticle.visible && pose) reticle.matrix.fromArray(pose.transform.matrix);
          place.disabled = !reticle.visible;
          if (reticle.visible) placeDish();
        }
        renderer!.render(scene, camera);
      });
      message.textContent = tracked
        ? 'Move your phone slowly over a table. The dish will appear when a table is detected.'
        : 'Manual camera preview — no surface tracking. Tap Place dish to position it.';
    };
    const startCamera = async (useTracked = false) => {
      if (busy || !live) return;
      busy = true;
      tracked = useTracked;
      start.disabled = true;
      try {
        if (!renderer) {
          renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
          renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
          renderer.setClearColor(0x000000, 0);
          canvasHost.append(renderer.domElement);
          renderer.domElement.addEventListener('webglcontextlost', (event) => {
            event.preventDefault();
            close();
          });
        }
        if (tracked) {
          // Called directly from this click, before any await, preserving user activation.
          const next = await navigator.xr!.requestSession('immersive-ar', {
            requiredFeatures: ['hit-test', 'dom-overlay'],
            optionalFeatures: ['local-floor'],
            domOverlay: { root: dialog },
          });
          if (!live) {
            await next.end();
            return;
          }
          stopCamera();
          anchor.visible = false;
          placed = false;
          session = next;
          session.addEventListener('end', close, { once: true });
          renderer.xr.enabled = true;
          renderer.xr.setReferenceSpaceType('local');
          await renderer.xr.setSession(session);
          if (!live) return;
          space = await session.requestReferenceSpace('local');
          const viewer = await session.requestReferenceSpace('viewer');
          hits = await session.requestHitTestSource!({ space: viewer });
          if (!live) {
            hits?.cancel();
            return;
          }
          session.addEventListener('select', placeDish);
        } else {
          activate();
          placeDish();
          const next = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' } },
            audio: false,
          });
          if (!live) {
            for (const track of next.getTracks()) track.stop();
            return;
          }
          stream = next;
          video.srcObject = stream;
          await video.play();
          if (!live) return;
          for (const track of stream.getVideoTracks())
            track.addEventListener('ended', close, { once: true });
        }
        if (tracked) activate();
      } catch {
        if (!live) return;
        stopCamera();
        if (session) {
          // End listeners close the portal; the normal preview remains mounted underneath.
          void session.end().catch(close);
        } else {
          tracked = false;
          xrSupported = false;
          start.hidden = false;
          start.textContent = 'Try camera preview';
          scaleStatus.textContent =
            'Approximate preview · camera unavailable · open Adjust view to retry';
          message.textContent =
            'Camera or table AR could not start. Allow camera access and try again, or go Back to preview.';
        }
      } finally {
        busy = false;
        if (live) start.disabled = false;
      }
    };
    start.addEventListener('click', () => void startCamera(xrSupported && running));

    mode.addEventListener('click', () => {
      if (!model) return;
      tilt.reset(false);
      use3d = !use3d;
      dialog.querySelector<HTMLElement>('.pp-ar__tilt-hint')!.hidden = use3d;
      button('tilt-reset').hidden = use3d;
      model.visible = use3d;
      cutout.visible = !use3d;
      mode.textContent = use3d ? 'Show 2.5D' : 'Show 3D';
      dialog.dataset.visual = use3d ? '3d' : '2.5d';
    });
    dialog.dataset.visual = '2.5d';
    updateScaleStatus();
    const url = modelUrl();
    if (url) {
      mode.hidden = false;
      mode.disabled = true;
      mode.textContent = 'Loading 3D…';
      void (async () => {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]),
            credentials: 'same-origin',
          });
          if (!response.ok || !response.body) throw new Error('Model unavailable');
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              length += value.byteLength;
              if (length > 50_000_000) throw new Error('Model exceeds budget');
              chunks.push(value);
            }
          } finally {
            await reader.cancel();
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.length;
          }
          const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '');
          if (!live) {
            disposeObject(gltf.scene);
            return;
          }
          const bounds = new THREE.Box3().setFromObject(gltf.scene);
          const dimensions = bounds.getSize(new THREE.Vector3());
          const extent = Math.max(dimensions.x, dimensions.y, dimensions.z);
          if (!Number.isFinite(extent) || extent <= 0) {
            disposeObject(gltf.scene);
            throw new Error('Invalid model size');
          }
          gltf.scene.position.sub(bounds.getCenter(new THREE.Vector3()));
          gltf.scene.position.y += dimensions.y / 2;
          model = new THREE.Group();
          model.add(gltf.scene);
          // Generated mesh bounds are not a calibrated plate boundary. Keep appearance approximate.
          model.scale.setScalar(0.3 / extent);
          model.visible = false;
          content.add(model);
          mode.disabled = false;
          mode.textContent = 'Show 3D';
        } catch {
          if (live) {
            mode.textContent = '3D unavailable · showing 2.5D';
            mode.disabled = true;
          }
        }
      })();
    }
    // Camera preview needs no immersive-session gesture: show the dish immediately,
    // then let the browser handle permission. Surface tracking remains an optional upgrade.
    start.textContent = 'Try camera preview';
    if (isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function')
      void startCamera();
    else
      message.textContent =
        'Camera access needs a secure connection and a supported browser. Back returns to the 2.5D preview.';
    void (navigator.xr?.isSessionSupported('immersive-ar') ?? Promise.resolve(false))
      .then((supported) => {
        if (!live || !supported) return;
        xrSupported = true;
        start.textContent = 'Start table AR';
        start.hidden = false;
      })
      .catch(() => {});
  };
  open.addEventListener('click', show);
  return {
    show,
    dispose() {
      disposed = true;
      closeCurrent?.();
      open.removeEventListener('click', show);
      open.remove();
    },
  };
}
