import type { PublicPortion } from '@peekaplate/contracts';
import {
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  Texture,
  WebGLRenderer,
} from 'three';

export type PortionRenderer = { update(x: number, y: number): void; dispose(): void };

async function readLayer(layer: PublicPortion['layers'][number], signal: AbortSignal) {
  const response = await fetch(layer.url, { signal, credentials: 'omit', redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('Layer unavailable');
  const reader = response.body.getReader();
  const bytes = new Uint8Array(layer.size_bytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > bytes.length) throw new Error('Layer exceeds budget');
      bytes.set(value, length - value.length);
    }
  } finally {
    await reader.cancel();
  }
  if (length !== bytes.length) throw new Error('Layer size mismatch');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  if (hash !== layer.sha256) throw new Error('Layer hash mismatch');
  signal.throwIfAborted();
  return bytes;
}

// Imported only by View Portion. One canvas, no idle render loop, explicit resource ownership.
export async function mount(
  element: HTMLElement,
  manifest: PublicPortion,
  signal: AbortSignal,
  onFailure: () => void,
): Promise<PortionRenderer> {
  signal.throwIfAborted();
  const renderer = new WebGLRenderer({ alpha: true, antialias: true });
  const scene = new Scene();
  const group = new Group();
  scene.add(group);
  const aspect = manifest.width / manifest.height;
  const camera = new OrthographicCamera(-aspect * 0.55, aspect * 0.55, 0.55, -0.55, 0.1, 10);
  camera.position.z = 2;
  const geometry = new PlaneGeometry(aspect, 1);
  const textures: Texture[] = [];
  const materials: MeshBasicMaterial[] = [];
  const bitmaps: ImageBitmap[] = [];
  let disposed = false;
  let visible = true;
  let resize: ResizeObserver | undefined;
  let intersection: IntersectionObserver | undefined;
  const canvas = renderer.domElement;
  canvas.className = 'pp-portion__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    resize?.disconnect();
    intersection?.disconnect();
    signal.removeEventListener('abort', dispose);
    canvas.removeEventListener('webglcontextlost', lost);
    document.removeEventListener('visibilitychange', draw);
    geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    for (const bitmap of bitmaps) bitmap.close();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  const lost = (event: Event) => {
    event.preventDefault();
    dispose();
    onFailure();
  };
  const draw = () => {
    if (disposed || !visible || document.hidden) return;
    try {
      renderer.render(scene, camera);
    } catch {
      dispose();
      onFailure();
    }
  };
  signal.addEventListener('abort', dispose, { once: true });
  canvas.addEventListener('webglcontextlost', lost);
  try {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    for (const layer of [...manifest.layers].sort((a, b) => a.depth - b.depth)) {
      const bytes = await readLayer(layer, signal);
      const bitmap = await createImageBitmap(new Blob([bytes]), { imageOrientation: 'flipY' });
      if (disposed || signal.aborted) {
        bitmap.close();
        throw new Error('Preview closed');
      }
      bitmaps.push(bitmap);
      if (bitmap.width !== manifest.width || bitmap.height !== manifest.height) {
        throw new Error('Layer dimensions mismatch');
      }
      const texture = new Texture(bitmap);
      texture.colorSpace = SRGBColorSpace;
      texture.needsUpdate = true;
      textures.push(texture);
      const material = new MeshBasicMaterial({ map: texture, transparent: layer.depth > 0 });
      materials.push(material);
      const mesh = new Mesh(geometry, material);
      mesh.position.z = layer.depth * 0.04;
      group.add(mesh);
    }
    signal.throwIfAborted();
    const size = () => {
      if (disposed) return;
      const width = Math.max(element.clientWidth, 1);
      const height = Math.max(element.clientHeight, 1);
      const viewport = width / height;
      const frameHeight = Math.max(1, aspect / viewport) * 1.1;
      camera.left = (-frameHeight * viewport) / 2;
      camera.right = (frameHeight * viewport) / 2;
      camera.top = frameHeight / 2;
      camera.bottom = -frameHeight / 2;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      draw();
    };
    size();
    if (disposed) throw new Error('Renderer unavailable');
    element.append(canvas);
    resize = new ResizeObserver(size);
    resize.observe(element);
    intersection = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
      draw();
    });
    intersection.observe(element);
    document.addEventListener('visibilitychange', draw);
    return {
      update(x, y) {
        if (disposed) return;
        group.rotation.set(
          (Math.max(-1, Math.min(1, y)) * Math.PI) / 60,
          (Math.max(-1, Math.min(1, x)) * Math.PI) / 60,
          0,
        );
        draw();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
