import { type PlateCalibration, parsePlateDimensions } from '@peekaplate/contracts';
import { useState } from 'react';
import { TextField } from '../foundations/TextField';
import {
  type CalibrationPhoto,
  calibrationMatchesPhoto,
  confirmedPhotoCalibration,
} from './portionCalibration';

type Props = {
  value: PlateCalibration | null | undefined;
  photo: CalibrationPhoto | undefined;
  photoPending: boolean;
  photoUnavailable: boolean;
  busy: boolean;
  onChange: (calibration: PlateCalibration | null) => void;
};
const edges = [
  ['x', 'Left'],
  ['y', 'Top'],
  ['width', 'Width'],
  ['height', 'Height'],
] as const;

export function PortionCalibrationEditor({
  value,
  photo,
  photoPending,
  photoUnavailable,
  busy,
  onChange,
}: Props) {
  const [plateSize, setPlateSize] = useState(() =>
    value
      ? value.shape === 'round'
        ? String(value.width_mm / 10)
        : `${value.width_mm / 10} × ${value.depth_mm / 10}`
      : '',
  );
  const [boundaryInputs, setBoundaryInputs] = useState(() => {
    const boundary = calibrationMatchesPhoto(value, photo)
      ? value!.boundary
      : { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    return {
      x: String(Math.round(boundary.x * 1000) / 10),
      y: String(Math.round(boundary.y * 1000) / 10),
      width: String(Math.round(boundary.width * 1000) / 10),
      height: String(Math.round(boundary.height * 1000) / 10),
    };
  });
  const dimensions = parsePlateDimensions(plateSize);
  const validInputs = Object.values(boundaryInputs).every((input) => /^\d+(\.\d)?$/.test(input));
  const boundary = {
    x: Number(boundaryInputs.x) / 100,
    y: Number(boundaryInputs.y) / 100,
    width: Number(boundaryInputs.width) / 100,
    height: Number(boundaryInputs.height) / 100,
  };
  const candidate = validInputs ? confirmedPhotoCalibration(plateSize, photo, boundary) : undefined;
  const confirmed = Boolean(
    value &&
      candidate &&
      calibrationMatchesPhoto(value, photo) &&
      value.shape === candidate.shape &&
      value.width_mm === candidate.width_mm &&
      value.depth_mm === candidate.depth_mm &&
      edges.every(([edge]) => value.boundary[edge] === candidate.boundary[edge]),
  );
  const boundaryError = Boolean(photo && dimensions && !candidate);
  return (
    <fieldset className="pp-serving-calibration" disabled={busy}>
      <legend>Optional plate measurement</legend>
      <p className="pp-field__hint">
        Approximate until you confirm the measurements on the saved photo.
      </p>
      <TextField
        id="dish-plate-size"
        label="Plate size (cm)"
        disabled={!photo || photoPending}
        value={plateSize}
        placeholder="28 or 30 × 20"
        hint="Optional. Measured plate diameter, or width × depth. Use 3–100 cm, with up to one decimal place."
        error={
          plateSize.trim() && !dimensions
            ? 'Enter a diameter or width × depth from 3 to 100 cm.'
            : ''
        }
        onChange={(event) => {
          setPlateSize(event.target.value);
          onChange(null);
        }}
      />
      {photo ? (
        <>
          <p className="pp-field__hint">
            Use a top-down photo with the whole plate visible. Match the outline to the outer plate
            edges, leaving utensils and garnish outside it. Angled photos remain approximate.
          </p>
          <div className="pp-serving-calibration__photo">
            <img src={photo.url} alt="Saved original photo for plate measurement" />
            <div
              className="pp-serving-calibration__boundary"
              aria-hidden="true"
              hidden={boundaryError || !dimensions}
              style={{
                left: `${boundary.x * 100}%`,
                top: `${boundary.y * 100}%`,
                width: `${boundary.width * 100}%`,
                height: `${boundary.height * 100}%`,
                borderRadius: dimensions?.shape === 'round' ? '50%' : '0',
              }}
            />
          </div>
          <div className="pp-serving-calibration__edges">
            {edges.map(([edge, label]) => (
              <TextField
                key={edge}
                id={`dish-plate-${edge}`}
                label={`Plate boundary ${label.toLowerCase()} (%)`}
                type="number"
                min={edge === 'x' || edge === 'y' ? 0 : 5}
                max={edge === 'x' || edge === 'y' ? 95 : 100}
                step="0.1"
                disabled={!dimensions}
                value={boundaryInputs[edge]}
                onChange={(event) => {
                  setBoundaryInputs({ ...boundaryInputs, [edge]: event.target.value });
                  onChange(null);
                }}
              />
            ))}
          </div>
          {boundaryError && (
            <p className="pp-field__error" role="alert">
              Keep the whole boundary inside the photo. Width and height must each cover at least
              5%.
            </p>
          )}
        </>
      ) : (
        <p className="pp-field__hint" role="status">
          {photoPending
            ? 'Save the new photo before confirming its measurements.'
            : photoUnavailable
              ? 'The saved photo could not be read for measurement. Reopen the dish or replace its photo.'
              : 'Save your dish photo and wait for it to load before confirming its measurements.'}
        </p>
      )}
      <label className="s09-check" htmlFor="dish-portion-confirm">
        <input
          id="dish-portion-confirm"
          type="checkbox"
          checked={confirmed}
          disabled={!candidate || photoPending || busy}
          onChange={(event) => onChange(event.target.checked && candidate ? candidate : null)}
        />
        <span>I measured this plate and matched its boundary to this photo.</span>
      </label>
      {confirmed && (
        <p className="pp-field__hint" role="status">
          Measurements confirmed for this photo. Save the dish to include them in publication
          review.
        </p>
      )}
    </fieldset>
  );
}
