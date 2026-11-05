"""Private, unvalidated suggestions; deliberately separate from review candidates."""
import copy
import hashlib

from .menu_context import TRAILING_TRADEMARK_WARNING


def suggestion_record(dish, worker_id, index, page, *, cleaned=None, warnings=(), rejection=None, box_evidence=()):
    original=dish.model_dump(mode="json")
    decisions=[]
    for field,value in original.items():
        if field=="page_number" or value is None:
            continue
        if rejection:
            disposition="rejected" if field=="name" else "unvalidated"
            reason=rejection if field=="name" else "Dish rejected; this field was not accepted."
        elif cleaned is None:
            disposition="unvalidated"
            reason="Image-only or unaccepted suggestion; no OCR grounding is claimed."
        elif field=="name" and value!=cleaned.name and TRAILING_TRADEMARK_WARNING in warnings:
            disposition="replaced_by_source_text"
            reason="Only a model-only trailing trademark was removed; the remaining name matches a literal source entry."
        elif box_evidence and field in {"price_text","price_amount"}:
            disposition="supported_by_ocr_boxes" if getattr(cleaned,field)==value else "replaced_by_ocr_boxes"
            reason="Selected from exact OCR regions; provenance and row alignment still require review."
        elif getattr(cleaned,field)==value:
            disposition="supported_by_source_text"
            reason="Survived literal source-text grounding; still requires human verification."
        else:
            disposition="cleared" if getattr(cleaned,field) is None else "replaced"
            reason="Value changed during OCR grounding; inspect grounding_warnings."
        decision={"field":field,"suggested_value":value,"disposition":disposition,"reason":reason}
        if disposition=="replaced_by_source_text":
            decision["grounded_value"]=cleaned.name
        decisions.append(decision)
    record={"worker_id":worker_id,"suggestion_index":index,"cited_page_number":dish.page_number,
            "status":"unvalidated","original":original,"decisions":decisions,
            "grounding_warnings":list(warnings),"source_reference":None if page is None else {
                "page_number":page["page_number"],"segment_id":page.get("segment_id"),
                "image":page.get("image_reference")}}
    if box_evidence:
        record["box_evidence"]=copy.deepcopy(list(box_evidence))
    return record


def private_result(source, input_mode, pages, output):
    records=[]
    for record in output.get("suggestions",[]):
        value=dict(record)
        identity=f"{source.source_id}:{input_mode}:{record['worker_id']}:{record['suggestion_index']}"
        value["suggestion_id"]="suggestion:"+hashlib.sha256(identity.encode()).hexdigest()[:32]
        records.append(value)
    batches=output.get("batches",[])
    complete=sum(batch.get("model_status")=="complete" for batch in batches)
    status="complete" if batches and complete==len(batches) else "incomplete" if complete else "failed"
    return {"schema_version":1,"source_id":source.source_id,"input_mode":input_mode,"status":status,
            "pages":[{"page_number":page["page_number"],"segment_id":page.get("segment_id"),
                      "image":page.get("image_reference")} for page in pages],
            "suggestions":records,"sections":output.get("raw_sections",[]),"batches":batches,
            "warnings":["Private unvalidated suggestions, not approved facts or OCR evidence.",
                        "Image regions are actual whole-page bounds, not inferred dish rectangles."]}
