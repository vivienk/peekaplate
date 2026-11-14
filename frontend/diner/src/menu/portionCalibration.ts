import { type PlateCalibration, PlateCalibrationSchema } from '@peekaplate/contracts';

// Local owner-review tool. A photo and serving weight alone cannot establish physical scale.
export function createPlateCalibration() {
  const element = document.createElement('fieldset');
  element.hidden = true;
  element.innerHTML = `<legend>Plate measurements (optional)</legend>
    <p>Use a top-down photo with the whole plate visible. Mark the outer plate edges, excluding utensils and garnish. Angled photos remain approximate.</p>
    <div style="position:relative;max-width:360px"><img alt="Original photo for plate calibration" style="display:block;width:100%"><div data-boundary style="position:absolute;border:2px solid #ff6500;pointer-events:none;box-sizing:border-box"></div></div>
    <label>Plate shape <select aria-label="Plate shape"><option value="round">Round</option><option value="rectangular">Rectangular</option></select></label>
    <label>Plate width / diameter (cm) <input data-width aria-label="Plate width in centimetres" type="number" min="3" max="100" step="0.1"></label>
    <label>Plate depth (cm) <input data-depth aria-label="Plate depth in centimetres" type="number" min="3" max="100" step="0.1" disabled></label>
    <p>Plate boundary as percentages of the original photo:</p>
    ${['Left', 'Top', 'Width', 'Height'].map((name, i) => `<label>${name} (%) <input data-edge="${i}" aria-label="Plate boundary ${name.toLowerCase()} percent" type="number" min="${i < 2 ? 0 : 5}" max="100" step="0.1" value="${i < 2 ? 10 : 80}"></label>`).join('')}
    <label><input data-confirm type="checkbox">I measured this plate and confirmed its boundary on this photo</label>
    <p>Without confirmation, the preview uses approximate visual size.</p>
    <button type="button">Generate preview</button>`;
  const photo = element.querySelector('img')!;
  const shape = element.querySelector('select')!;
  const width = element.querySelector<HTMLInputElement>('[data-width]')!;
  const depth = element.querySelector<HTMLInputElement>('[data-depth]')!;
  const confirm = element.querySelector<HTMLInputElement>('[data-confirm]')!;
  const edges = [...element.querySelectorAll<HTMLInputElement>('[data-edge]')];
  const outline = element.querySelector<HTMLElement>('[data-boundary]')!;
  let url: string | undefined;
  let file: File | undefined;
  const redraw = () => {
    confirm.checked = false;
    depth.disabled = shape.value === 'round';
    const [x, y, w, h] = edges.map((input) => Number(input.value));
    Object.assign(outline.style, {
      left: `${x}%`,
      top: `${y}%`,
      width: `${w}%`,
      height: `${h}%`,
      borderRadius: shape.value === 'round' ? '50%' : '0',
    });
  };
  for (const input of [shape, width, depth, ...edges]) input.addEventListener('input', redraw);
  redraw();
  return {
    element,
    generate: element.querySelector('button')!,
    select(next: File) {
      file = next;
      if (url) URL.revokeObjectURL(url);
      url = URL.createObjectURL(next);
      photo.src = url;
      element.hidden = false;
      redraw();
    },
    async value(): Promise<PlateCalibration | undefined> {
      if (!confirm.checked) return undefined;
      if (!file) throw new Error('Choose the original dish photo.');
      await photo.decode();
      const hash = [
        ...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
      ]
        .map((n) => n.toString(16).padStart(2, '0'))
        .join('');
      const [x, y, w, h] = edges.map((input) => Number(input.value) / 100);
      const result = PlateCalibrationSchema.safeParse({
        shape: shape.value,
        width_mm: Math.round(Number(width.value) * 10),
        depth_mm: Math.round(Number(shape.value === 'round' ? width.value : depth.value) * 10),
        source_sha256: hash,
        source_width_px: photo.naturalWidth,
        source_height_px: photo.naturalHeight,
        boundary: { x, y, width: w, height: h },
        confirmed: true,
      });
      if (!result.success)
        throw new Error('Enter valid plate measurements and a boundary entirely inside the photo.');
      return result.data;
    },
    dispose() {
      if (url) URL.revokeObjectURL(url);
      element.remove();
    },
  };
}
