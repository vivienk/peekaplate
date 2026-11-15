"""Owner-confirmed plate boundaries tied to the exact oriented source photo."""
import math
from peekaplate_processing.errors import ExtractionError


def validate_plate(value, source_hash, image_size):
    if value is None:
        return None
    def require(condition):
        if not condition:
            raise ExtractionError('Invalid plate calibration or source-photo mismatch.')
    require(isinstance(value, dict) and set(value) == {'shape', 'width_mm', 'depth_mm', 'source_sha256', 'source_width_px', 'source_height_px', 'boundary', 'confirmed'})
    require(value['shape'] in ('round', 'rectangular') and value['confirmed'] is True)
    for key in ('width_mm', 'depth_mm'):
        require(type(value[key]) is int and 30 <= value[key] <= 1000)
    require(value['shape'] != 'round' or value['width_mm'] == value['depth_mm'])
    require(value['source_sha256'] == source_hash)
    require(type(value['source_width_px']) is int and type(value['source_height_px']) is int)
    require((value['source_width_px'], value['source_height_px']) == image_size)
    box = value['boundary']
    require(isinstance(box, dict) and set(box) == {'x', 'y', 'width', 'height'})
    for key in box:
        require(type(box[key]) in (int, float) and math.isfinite(box[key]))
    require(0 <= box['x'] < 1 and 0 <= box['y'] < 1)
    require(0.05 <= box['width'] <= 1 and 0.05 <= box['height'] <= 1)
    require(box['x'] + box['width'] <= 1 and box['y'] + box['height'] <= 1)
    return {**value, 'boundary': dict(box)}
