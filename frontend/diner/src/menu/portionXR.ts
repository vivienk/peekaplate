import * as THREE from 'three';

/** No DOM overlay or hit-test requirement: Quest can supply room planes instead. */
export function portionXRSessionOptions(root: HTMLElement): XRSessionInit {
  return {
    optionalFeatures: [
      'local-floor',
      'hit-test',
      'plane-detection',
      'hand-tracking',
      'dom-overlay',
    ],
    domOverlay: { root },
  };
}

export function isQuestBrowser(userAgent: string) {
  return /OculusBrowser|Meta Quest/i.test(userAgent);
}

/** Intersect only inside a detected horizontal polygon, never an invented table. */
export function intersectTable(
  ray: THREE.Ray,
  matrix: THREE.Matrix4,
  polygon: ReadonlyArray<{ x: number; z: number }>,
): THREE.Vector3 | null {
  if (matrix.elements[5]! < 0.85 || polygon.length < 3) return null;
  const local = ray.clone().applyMatrix4(matrix.clone().invert());
  const point = local.intersectPlane(
    new THREE.Plane(new THREE.Vector3(0, 1, 0)),
    new THREE.Vector3(),
  );
  if (!point) return null;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.z > point.z !== b.z > point.z &&
      point.x < ((b.x - a.x) * (point.z - a.z)) / (b.z - a.z) + a.x
    )
      inside = !inside;
  }
  if (!inside) return null;
  point.applyMatrix4(matrix);
  return ray.origin.distanceTo(point) <= 4 ? point : null;
}

export type PortionXRFrame = XRFrame & {
  detectedPlanes?: Set<{ planeSpace: XRSpace; polygon: ReadonlyArray<{ x: number; z: number }> }>;
};

/** World-rendered controls remain available when the headset has no DOM overlay. */
export function createPortionXRPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 640;
  const context = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.64, 0.4),
    new THREE.MeshBasicMaterial({ map: texture, depthTest: false }),
  );
  mesh.renderOrder = 100;
  mesh.visible = false;
  let previous = '';
  const actions = ['place', 'mode', 'rotate', 'reset', 'original', 'close'] as const;
  return {
    mesh,
    update(status: string, scale: string, modelLabel: string) {
      const key = status + scale + modelLabel;
      if (previous === key) return;
      previous = key;
      context.fillStyle = '#162323';
      context.fillRect(0, 0, 1024, 640);
      context.fillStyle = '#ffffff';
      context.font = '30px sans-serif';
      context.fillText(status, 24, 44, 976);
      context.font = '24px sans-serif';
      context.fillText(scale, 24, 84, 976);
      const labels = [
        'Place on surface',
        modelLabel,
        'Rotate 30°',
        'Reposition',
        'Original / dish',
        'Back to preview',
      ];
      labels.forEach((label, index) => {
        const y = 110 + index * 86;
        context.fillStyle = '#304d4d';
        context.fillRect(20, y, 984, 74);
        context.fillStyle = '#ffffff';
        context.font = '30px sans-serif';
        context.fillText(label, 40, y + 48);
      });
      texture.needsUpdate = true;
    },
    select(ray: THREE.Ray) {
      const caster = new THREE.Raycaster();
      caster.ray.copy(ray);
      const hit = caster.intersectObject(mesh)[0];
      if (!mesh.visible || !hit?.uv) return undefined;
      const y = (1 - hit.uv.y) * 640 - 110;
      return y >= 0 && y % 86 <= 74 ? actions[Math.floor(y / 86)] : undefined;
    },
  };
}

/** Derive the current selecting input ray; never reuse another controller's pose. */
export function portionInputRay(frame: XRFrame, space: XRReferenceSpace, input?: XRInputSource) {
  const pose = input ? frame.getPose(input.targetRaySpace, space) : frame.getViewerPose(space);
  if (!pose) return null;
  const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
  return new THREE.Ray(
    new THREE.Vector3().setFromMatrixPosition(matrix),
    new THREE.Vector3(0, 0, -1).transformDirection(matrix),
  );
}
