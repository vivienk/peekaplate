import json
import os
import tempfile
from pathlib import Path

from pydantic import ValidationError

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.schemas import DishDraft


def save_drafts(drafts:list[DishDraft], output_path:str|Path)->None:
    if not drafts:
        raise ExtractionError("There are no drafts to save.")
    try:
        validated=[DishDraft.model_validate(draft.model_dump(warnings=False)) for draft in drafts]
        content=json.dumps([draft.model_dump(mode="json") for draft in validated], ensure_ascii=False, indent=2)+"\n"
    except (ValidationError, AttributeError, TypeError, ValueError):
        raise ExtractionError("Invalid drafts cannot be saved.") from None

    output_path=Path(output_path)
    temporary_path=None
    try:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_path.parent, delete=False) as temporary:
            temporary_path=Path(temporary.name)
            temporary.write(content)
        # Linking publishes the completed file atomically and refuses existing paths.
        os.link(temporary_path, output_path)
    except FileExistsError:
        raise ExtractionError("Output already exists; choose a new path to preserve the previous drafts.") from None
    except OSError:
        raise ExtractionError("Unable to save draft JSON.") from None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def save_json(value:dict, output_path:str|Path)->None:
    output_path=Path(output_path)
    temporary_path=None
    try:
        content=json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+"\n"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=output_path.parent, delete=False) as temporary:
            temporary_path=Path(temporary.name)
            temporary.write(content)
        os.link(temporary_path, output_path)
    except FileExistsError:
        raise ExtractionError("Output already exists; choose a new path to preserve the previous result.") from None
    except (OSError, TypeError, ValueError):
        raise ExtractionError("Unable to save private result JSON.") from None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
