"""Synthetic, offline-only checks for the private overlay experiment."""
import base64
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from peekaplate_processing.errors import ExtractionError
from peekaplate_processing.images import prepare_ocr_image
from peekaplate_processing.overlay_review import (
    MAX_REPORT_BYTES, MAX_SUGGESTIONS_BYTES, export_overlay_review, main, prepare_overlay_review,
)
from peekaplate_processing.review_candidates import prepare_review_candidates
from peekaplate_processing.schemas import MenuExtractionResult


def digest(value):
    return hashlib.sha256(value).hexdigest()


def region(text, left=10, top=10, width=80, height=12):
    return dict(text=text, left=left, top=top, width=width, height=height)


def fixture(prices=("8.50",), *, price_text="8.50", scalar=None, title="Soup", color="white",
            dimensions=(640,320), image_format="PNG"):
    with Image.new("RGB", dimensions, color) as image:
        output=io.BytesIO()
        image.save(output, format=image_format)
    data=output.getvalue()
    sha=digest(data)
    source_id=f"sha256:{sha}"
    upload, metadata=prepare_ocr_image(data)
    metadata.update(ocr_image_sha256=digest(upload), ocr_settings={"OCREngine":3},
                    ocr_coordinate_space="uploaded_image_pixels", ocr_region_status="available",
                    ocr_regions=[region(title)]+[region(p, 180+i*110, width=85) for i,p in enumerate(prices)])
    report=dict(schema_version=2, pipeline_version="3", status="complete", started_at="2026-01-01T00:00:00Z",
                source=dict(source_id=source_id, sha256=sha, kind="image", location="DO-NOT-OPEN.png",
                            retrieved_at="2026-01-01T00:00:00Z", size_bytes=len(data),
                            snapshot_base64=base64.b64encode(data).decode()),
                segments=[dict(segment_id=source_id+"#image-1", page_number=None, method="ocr_space_engine3",
                               status="ready", text="Soup", metadata=metadata)])
    image_ref=dict(path="/never/open/PRIVATE.png", path_scope="local_run", source_id=source_id,
                   source_page=1, sha256=sha, mime_type="image/png" if image_format=="PNG" else "image/jpeg",
                   width=dimensions[0], height=dimensions[1],
                   region=dict(scope="page", coordinate_space="image_pixels", left=0, top=0,
                               width=dimensions[0], height=dimensions[1]))
    original=dict(page_number=1, name=title, description=None, category=None, subcategory=None,
                  price_text=price_text, price_amount=scalar, price_currency=None, ingredients=None)
    row=dict(worker_id=1, suggestion_index=0, cited_page_number=1, status="unvalidated", original=original,
             decisions=[], grounding_warnings=[], source_reference=dict(page_number=1, segment_id=None, image=image_ref),
             suggestion_id="suggestion:NOT-A-RUN-IDENTITY")
    suggestions=dict(schema_version=1, source_id=source_id, input_mode="ocr_image", status="complete",
                     pages=[dict(page_number=1, segment_id=None, image=copy.deepcopy(image_ref))],
                     suggestions=[row], sections=[], batches=[], warnings=[])
    return report, suggestions


class OverlayReviewTests(unittest.TestCase):
    def result(self, **kwargs):
        return prepare_overlay_review(*fixture(**kwargs))

    def abstains(self, report, suggestions, reason=None):
        result=prepare_overlay_review(report, suggestions)
        self.assertEqual(result["status"], "unvalidated")
        for row in result["rows"]:
            self.assertEqual(row["disposition"], "abstained")
            self.assertEqual(row["proposed_price_parts"], [])
            self.assertIsNone(row["proposed_price_amount"])
            self.assertIsNone(row["proposed_price_currency"])
            if reason:
                self.assertEqual(row["reason"], reason)
        return result

    def test_exact_unicode_transcript_and_stored_order(self):
        report,suggestions=fixture(title="  🍲 e\u0301  Soup ")
        regions=report["segments"][0]["metadata"]["ocr_regions"]
        regions.append(region("  café 😀 ", 20, 100))
        regions.reverse()
        result=prepare_overlay_review(report,suggestions)
        transcript=result["transcript"]
        self.assertEqual(transcript["text"], "\n".join(r["text"] for r in regions))
        self.assertEqual(transcript["separator"], "\n")
        self.assertEqual(transcript["order_policy"], "stored_region_order")
        self.assertEqual(transcript["offset_unit"], "zero_based_unicode_codepoints_half_open")
        for index,record in enumerate(transcript["regions"]):
            raw=regions[index]
            self.assertEqual(record["saved_region_index"], index)
            self.assertEqual(record["box"], {k:raw[k] for k in ("left","top","width","height")})
            start,end=record["span"]["start"],record["span"]["end"]
            self.assertEqual(transcript["text"][start:end], raw["text"])
            self.assertEqual(end-start,len(raw["text"]))
        self.assertEqual(result,prepare_overlay_review(report,suggestions))

    def test_identity_changes_with_raw_region_and_original_text_and_image_and_suggestions(self):
        report,suggestions=fixture()
        baseline=prepare_overlay_review(report,suggestions)
        for change in ("region", "text", "image", "suggestions", "box", "order"):
            r,s=copy.deepcopy(report),copy.deepcopy(suggestions)
            if change=="region":r["segments"][0]["metadata"]["ocr_regions"][0]["text"]=" Soup "
            if change=="text":r["segments"][0]["text"]+=" original"
            if change=="image":r,s=fixture(color="blue")
            if change=="suggestions":s["warnings"].append("different saved input")
            if change=="box":r["segments"][0]["metadata"]["ocr_regions"][0]["left"]+=1
            if change=="order":r["segments"][0]["metadata"]["ocr_regions"].reverse()
            result=prepare_overlay_review(r,s)
            with self.subTest(change=change):
                self.assertNotEqual(result["overlay_id"],baseline["overlay_id"])
                self.assertNotEqual(result["transcript"]["transcript_id"],baseline["transcript"]["transcript_id"])

    def test_no_mutation_including_pydantic_and_standard_review_export(self):
        report,suggestions=fixture()
        report["drafts"]=[dict(name="Soup",source_id=report["source"]["source_id"],source_text="Soup")]
        report["evidence"]=[dict(draft_id="existing-production-id",draft_index=0,
                                 spans=[dict(segment_id=report["segments"][0]["segment_id"],start=0,end=4)])]
        model=MenuExtractionResult.model_validate(report)
        before=model.model_dump_json()
        old_suggestions=copy.deepcopy(suggestions)
        candidates=prepare_review_candidates(model).model_dump_json()
        prepare_overlay_review(model,suggestions)
        self.assertEqual(model.model_dump_json(),before)
        self.assertEqual(suggestions,old_suggestions)
        self.assertEqual(prepare_review_candidates(model).model_dump_json(),candidates)
        raw=copy.deepcopy(report)
        prepare_overlay_review(report,suggestions)
        self.assertEqual(report,raw)

    def test_mutated_pydantic_is_revalidated(self):
        report,suggestions=fixture()
        model=MenuExtractionResult.model_validate(report)
        model.source.source_id="bad"
        with self.assertRaises(ExtractionError):prepare_overlay_review(model,suggestions)

    def test_geometry_fail_closed_without_source_text_fallback(self):
        for change in ("missing", "unavailable", "invalid", "empty", "nan", "inf", "bool", "negative", "zero",
                       "outside", "duplicate", "collision", "newline", "blank", "unknown", "too_many"):
            report,suggestions=fixture()
            report["segments"][0]["text"]="Soup 8.50"
            metadata=report["segments"][0]["metadata"]
            if change=="missing":metadata.pop("ocr_regions")
            elif change in {"unavailable","invalid"}:metadata["ocr_region_status"]=change
            elif change=="empty":metadata["ocr_regions"]=[]
            elif change in {"nan","inf","bool","negative"}:metadata["ocr_regions"][0]["left"]={"nan":float("nan"),"inf":float("inf"),"bool":True,"negative":-1}[change]
            elif change=="zero":metadata["ocr_regions"][0]["height"]=0
            elif change=="outside":metadata["ocr_regions"][0]["width"]=1000
            elif change=="duplicate":metadata["ocr_regions"].append(copy.deepcopy(metadata["ocr_regions"][0]))
            elif change=="collision":metadata["ocr_regions"].append(region("collision",11))
            elif change=="newline":metadata["ocr_regions"][0]["text"]="Soup\n8.50"
            elif change=="blank":metadata["ocr_regions"][0]["text"]=" "
            elif change=="unknown":metadata["ocr_regions"][0]["invented_id"]="bad"
            elif change=="too_many":metadata["ocr_regions"]*=501
            with self.subTest(change=change):
                result=self.abstains(report,suggestions,"invalid_overlay_geometry")
                self.assertIsNone(result["transcript"])

    def test_missing_source_engine_and_upload_provenance_rejected(self):
        for change in ("source", "kind", "source_id", "size", "hash", "snapshot", "engine", "engine_bool", "method",
                       "failed", "error", "page", "segments", "upload_hash", "upload_width", "original_width", "format"):
            r,s=fixture()
            segment=r["segments"][0]
            metadata=segment["metadata"]
            if change=="source":r["source"]=None
            elif change=="kind":r["source"]["kind"]="pdf"
            elif change=="source_id":r["source"]["source_id"]="wrong"
            elif change=="size":r["source"]["size_bytes"]+=1
            elif change=="hash":r["source"]["sha256"]="0"*64
            elif change=="snapshot":r["source"]["snapshot_base64"]="bad!!"
            elif change=="engine":metadata["ocr_settings"]={}
            elif change=="engine_bool":metadata["ocr_settings"]["OCREngine"]=True
            elif change=="method":segment["method"]="text"
            elif change=="failed":segment["status"]="failed"
            elif change=="error":segment["error"]="PRIVATE"
            elif change=="page":segment["page_number"]=2
            elif change=="segments":r["segments"]*=2
            elif change=="upload_hash":metadata["ocr_image_sha256"]="0"*64
            elif change in {"upload_width","original_width"}:metadata[change]+=1
            elif change=="format":metadata["upload_format"]="PNG"
            with self.subTest(change=change),self.assertRaises(ExtractionError):prepare_overlay_review(r,s)

    def test_snapshot_bytes_hash_is_checked_independently_of_claimed_identity(self):
        r,s=fixture()
        raw=bytearray(base64.b64decode(r["source"]["snapshot_base64"]))
        raw[-1]^=1
        r["source"]["snapshot_base64"]=base64.b64encode(raw).decode()
        with self.assertRaises(ExtractionError):prepare_overlay_review(r,s)
        r,s=fixture()
        r["source"].update(source_id="sha256:"+"0"*64,sha256="0"*64)
        with self.assertRaises(ExtractionError):prepare_overlay_review(r,s)

    def test_jpeg_original_with_resized_upload_uses_distinct_coordinate_spaces(self):
        r,s=fixture(dimensions=(3000,1000),image_format="JPEG")
        metadata=r["segments"][0]["metadata"]
        self.assertEqual((metadata["upload_width"],metadata["upload_height"]),(2400,800))
        result=prepare_overlay_review(r,s)
        self.assertEqual(result["rows"][0]["disposition"],"numeric_agreement")
        self.assertNotEqual(result["transcript"]["upload_sha256"],r["source"]["sha256"])
        s["suggestions"][0]["source_reference"]["image"].update(width=2400,height=800)
        with self.assertRaises(ExtractionError):prepare_overlay_review(r,s)

    def test_suggestion_provenance_and_schema_mismatch_rejected(self):
        for change in ("text", "source", "page", "original_page", "image_hash", "image_source", "image_page", "width",
                       "crop", "page_hash", "missing_image", "unknown_original", "bad_amount", "unknown_top", "unknown_row", "too_many"):
            r,s=fixture()
            row=s["suggestions"][0]
            image=row["source_reference"]["image"]
            if change=="text":s["input_mode"]="ocr"
            elif change=="source":s["source_id"]="wrong"
            elif change=="page":row["cited_page_number"]=2
            elif change=="original_page":row["original"]["page_number"]=2
            elif change=="image_hash":image["sha256"]="0"*64
            elif change=="image_source":image["source_id"]="wrong"
            elif change=="image_page":image["source_page"]=2
            elif change=="width":image["width"]+=1
            elif change=="crop":image["region"]["left"]=1
            elif change=="page_hash":s["pages"][0]["image"]["sha256"]="0"*64
            elif change=="missing_image":row["source_reference"]["image"]=None
            elif change=="unknown_original":row["original"]["variant"]="invented"
            elif change=="bad_amount":row["original"]["price_amount"]=False
            elif change=="unknown_top":s["drafts"]=[]
            elif change=="unknown_row":row["approved"]=True
            elif change=="too_many":s["suggestions"]*=501
            with self.subTest(change=change),self.assertRaises(ExtractionError):prepare_overlay_review(r,s)

    def test_image_mode_allowed_and_paths_never_opened(self):
        r,s=fixture()
        s["input_mode"]="image"
        with patch("pathlib.Path.open",side_effect=AssertionError("Must not open any path")):
            self.assertEqual(prepare_overlay_review(r,s)["rows"][0]["disposition"],"numeric_agreement")

    def test_exact_title_only_no_composed_wrapped_or_inline_recovery(self):
        for labels in (("So","up"),("Soup 8.50",),("Soup!",),("Other",)):
            r,s=fixture()
            r["segments"][0]["metadata"]["ocr_regions"]=[region(label,10,10+i*30) for i,label in enumerate(labels)]+[region("8.50",180)]
            with self.subTest(labels=labels):self.abstains(r,s,"unsupported_or_unmatched_title")

    def test_title_normalizes_case_and_whitespace_only(self):
        r,s=fixture(title="  SOUP  ")
        s["suggestions"][0]["original"]["name"]="soup"
        self.assertEqual(prepare_overlay_review(r,s)["rows"][0]["disposition"],"numeric_agreement")

    def test_repeated_title_anywhere_and_repeated_suggestion_abstain(self):
        r,s=fixture()
        r["segments"][0]["metadata"]["ocr_regions"].append(region("sOuP",10,100))
        self.abstains(r,s,"repeated_or_competing_title")
        r,s=fixture()
        s["suggestions"].append(copy.deepcopy(s["suggestions"][0]))
        self.assertEqual(len(self.abstains(r,s)["rows"]),2)

    def test_intervening_label_other_title_and_left_reading_block(self):
        for extra in (region("Salad",110,width=50),region("cal",300),region("7.00",0,width=8),
                      region("Other",110,18,width=50),region("12.50",300,20)):
            r,s=fixture()
            r["segments"][0]["metadata"]["ocr_regions"].append(extra)
            with self.subTest(extra=extra):self.abstains(r,s)

    def test_competing_rows_sharing_tall_price_abstain(self):
        r,s=fixture()
        regs=r["segments"][0]["metadata"]["ocr_regions"]
        regs[1]["height"]=35
        regs.append(region("Salad",10,30))
        other=copy.deepcopy(s["suggestions"][0])
        other["original"]["name"]="Salad"
        s["suggestions"].append(other)
        self.abstains(r,s)

    def test_single_zero_and_null_scalar_fallback(self):
        for price_text,scalar in ((None,"0"),("0.00",None),("0.00","0")):
            result=self.result(prices=("0.00",),price_text=price_text,scalar=scalar)
            row=result["rows"][0]
            self.assertEqual(row["disposition"],"numeric_agreement")
            self.assertEqual(row["proposed_price_amount"],"0.00")
            self.assertIsNone(row["proposed_price_currency"])
        r,s=fixture(price_text=None,scalar=None)
        self.abstains(r,s,"missing_model_price_reading")

    def test_all_ordered_multi_prices_and_exact_literals_no_synthesized_fields(self):
        r,s=fixture(prices=(" $7.00 ","LG 12.00 USD"),price_text="7 / 12.00")
        s["suggestions"][0]["original"]["price_currency"]="USD"
        row=prepare_overlay_review(r,s)["rows"][0]
        self.assertEqual(row["disposition"],"numeric_agreement")
        self.assertEqual([p["literal"] for p in row["proposed_price_parts"]],[" $7.00 ","LG 12.00 USD"])
        self.assertIsNone(row["proposed_price_amount"])
        self.assertIsNone(row["proposed_price_currency"])
        self.assertNotIn("price_text",row)
        self.assertNotIn("variant",row)
        self.assertNotIn("size",row)
        for p in row["proposed_price_parts"]:
            transcript=prepare_overlay_review(r,s)["transcript"]
            self.assertEqual(transcript["text"][p["span"]["start"]:p["span"]["end"]],p["literal"])

    def test_sm_lg_prefixes_preserve_literal_evidence(self):
        result=self.result(prices=("SM7.00","LG 12.00"),price_text="7.00/12.00")
        row=result["rows"][0]
        self.assertEqual(row["disposition"],"numeric_agreement")
        self.assertEqual([p["literal"] for p in row["proposed_price_parts"]],["SM7.00","LG 12.00"])

    def test_saved_errors_and_complete_whitespace_model_sequences(self):
        for prices,model in ((("5.00","29.00"),"5.00 29.00"),
                             (("SM 13.00","LG 32.00"),"SM 13.00 LG 32.00")):
            r,s=fixture(prices=prices,price_text=model)
            s["errors"]=[]
            before=copy.deepcopy(s)
            row=prepare_overlay_review(r,s)["rows"][0]
            with self.subTest(model=model):
                self.assertEqual(row["disposition"],"numeric_agreement")
                self.assertEqual([p["literal"] for p in row["proposed_price_parts"]],list(prices))
                self.assertIsNone(row["proposed_price_amount"])
                self.assertIsNone(row["proposed_price_currency"])
                self.assertEqual(s,before)
        r,s=fixture(prices=("3","50"),price_text="3 50")
        self.abstains(r,s,"invalid_model_price_reading")

    def test_extra_ocr_price_partial_model_disagreement_and_order(self):
        for prices,model in ((("7.00","37.00"),"37.00"),(("3.50",),"4.50"),
                             (("7","12"),"7/13"),(("7","12"),"12/7")):
            r,s=fixture(prices=prices,price_text=model)
            with self.subTest(prices=prices,model=model):self.abstains(r,s,"numeric_disagreement")

    def test_contradictory_scalar_abstains_entire_row(self):
        for prices,model,scalar in ((("8.50",),"8.50","9"),(("7","12"),"7/12","7"),(("0",),"0","1")):
            r,s=fixture(prices=prices,price_text=model,scalar=scalar)
            with self.subTest(scalar=scalar):self.abstains(r,s,"contradictory_model_scalar")

    def test_malformed_numeric_literals_and_units_cannot_be_salvaged(self):
        invalid=(".50","3.","1,000","3.50.00","3.500","-7","+7","−7","7e2","7 kcal","7oz", "7 / -12", "3 50", "00.50")
        for literal in invalid:
            r,s=fixture(prices=(literal,),price_text="7")
            with self.subTest(literal=literal):self.abstains(r,s,"malformed_or_nonprice_row_cell")
        for literal in invalid:
            r,s=fixture(prices=("7",),price_text=literal)
            with self.subTest(model=literal):self.abstains(r,s,"invalid_model_price_reading")

    def test_non_numeric_scalar_cannot_corroborate(self):
        for scalar in ("$7", "SM7", "7 USD", "7/7", "7e0", "NaN", "Infinity"):
            r,s=fixture(prices=("7",),price_text=None,scalar=scalar)
            with self.subTest(scalar=scalar):self.abstains(r,s,"invalid_model_price_reading")

    def test_inline_title_repeat_is_not_silently_ignored(self):
        r,s=fixture()
        r["segments"][0]["metadata"]["ocr_regions"].append(region("Soup 9.50",10,100))
        self.abstains(r,s,"repeated_or_competing_title")

    def test_partially_overlapping_unit_after_price_blocks(self):
        r,s=fixture()
        r["segments"][0]["metadata"]["ocr_regions"].append(region("kcal",300,18))
        self.abstains(r,s)

    def test_original_slash_region_is_literal_not_invented(self):
        result=self.result(prices=("7.00 / 12.00",),price_text="7/12")
        row=result["rows"][0]
        self.assertEqual(row["disposition"],"numeric_agreement")
        self.assertEqual(len(row["proposed_price_parts"]),1)
        self.assertEqual(row["proposed_price_parts"][0]["literal"],"7.00 / 12.00")
        self.assertIsNone(row["proposed_price_amount"])

    def test_split_decimal_and_thousands_cells_abstain(self):
        for prices in (("3.","50"),("1,","000"),("-","7"),("7","kcal")):
            r,s=fixture(prices=prices,price_text="50")
            with self.subTest(prices=prices):self.abstains(r,s)

    def test_saved_ids_and_indices_are_not_used_to_join(self):
        r,s=fixture()
        first=prepare_overlay_review(r,s)["rows"][0]
        s["suggestions"][0].update(suggestion_id="unrelated",worker_id=99,suggestion_index=99)
        second=prepare_overlay_review(r,s)["rows"][0]
        # Exact-file identity changes, but never the numeric association itself.
        without_identity=lambda parts:[{k:v for k,v in p.items() if k!="transcript_id"} for p in parts]
        self.assertEqual(without_identity(first["proposed_price_parts"]),without_identity(second["proposed_price_parts"]))
        self.assertEqual(first["disposition"],second["disposition"])

    def test_keeps_originals_and_all_rows_with_explicit_unvalidated_disposition(self):
        r,s=fixture()
        other=copy.deepcopy(s["suggestions"][0]);other["original"]["name"]="Unknown"
        s["suggestions"].append(other)
        result=prepare_overlay_review(r,s)
        self.assertEqual(result["artifact_type"],"private_overlay_review")
        self.assertEqual(result["schema_version"],1)
        self.assertIn("not proof of the same run", " ".join(result["warnings"]))
        for i,row in enumerate(result["rows"]):
            self.assertEqual(row["status"],"unvalidated")
            self.assertEqual(row["suggestion"],s["suggestions"][i])
            self.assertTrue(row["reason"])
            self.assertNotIn("candidate_id",row)
            self.assertNotIn("draft_id",row)

    def test_file_hashes_bind_exact_bytes_not_just_parsed_json(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"pages.json";sp=root/"review-suggestions.json"
            rb=json.dumps(r).encode();sb=json.dumps(s).encode()
            rp.write_bytes(rb);sp.write_bytes(sb)
            a=export_overlay_review(rp,sp,root/"a.json")
            self.assertEqual(a["inputs"]["report_sha256"],digest(rb))
            self.assertEqual(a["inputs"]["suggestions_sha256"],digest(sb))
            sp.write_bytes(sb+b"\n")
            b=export_overlay_review(rp,sp,root/"b.json")
            self.assertNotEqual(a["overlay_id"],b["overlay_id"])
            self.assertNotEqual(a["transcript"]["transcript_id"],b["transcript"]["transcript_id"])

    def test_cli_create_only_0600_and_safe_success_message(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"pages.json";sp=root/"review-suggestions.json";out=root/"overlay-review.json"
            rp.write_text(json.dumps(r));sp.write_text(json.dumps(s))
            args=["--input",str(rp),"--suggestions",str(sp),"--output",str(out)]
            with patch("builtins.print") as printed:self.assertEqual(main(args),0)
            self.assertNotIn(str(root),str(printed.call_args_list))
            self.assertEqual(out.stat().st_mode & 0o777,0o600)
            before=out.read_bytes()
            with self.assertRaises(SystemExit) as error:main(args)
            self.assertEqual(error.exception.code,1)
            self.assertEqual(out.read_bytes(),before)

    def test_sanitized_cli_errors_and_no_output(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"PRIVATE-pages.json";sp=root/"suggestions.json";out=root/"out.json"
            sp.write_text(json.dumps(s))
            for content in (b"PRIVATE INVALID JSON",b'{"private":"SECRET"}',json.dumps(r).encode().replace(b'"OCREngine": 3',b'"OCREngine": 2')):
                rp.write_bytes(content)
                with patch("sys.stderr",new_callable=io.StringIO) as stderr,self.assertRaises(SystemExit):
                    main(["--input",str(rp),"--suggestions",str(sp),"--output",str(out)])
                self.assertNotIn("PRIVATE",stderr.getvalue())
                self.assertNotIn("SECRET",stderr.getvalue())
                self.assertNotIn(str(root),stderr.getvalue())
                self.assertNotIn("Traceback",stderr.getvalue())
                self.assertFalse(out.exists())

    def test_file_size_limits_and_duplicate_json_keys(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"pages.json";sp=root/"s.json";out=root/"out.json"
            for target,limit in ((rp,MAX_REPORT_BYTES),(sp,MAX_SUGGESTIONS_BYTES)):
                rp.write_text(json.dumps(r));sp.write_text(json.dumps(s))
                with target.open("wb") as handle:handle.truncate(limit+1)
                with self.assertRaises(ExtractionError):export_overlay_review(rp,sp,out)
                self.assertFalse(out.exists())
            rp.write_text(json.dumps(r));sp.write_text('{"schema_version":1,"schema_version":1}')
            with self.assertRaises(ExtractionError):export_overlay_review(rp,sp,out)

    def test_invalid_saved_json_constants_encoding_and_missing_files_are_sanitized(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"private.json";sp=root/"s.json";out=root/"out.json"
            sp.write_text(json.dumps(s))
            for content in (b'{"private":NaN}',b'{"private":Infinity}',b'\xff',b'[]',b'null'):
                rp.write_bytes(content)
                with self.assertRaises(ExtractionError) as caught:export_overlay_review(rp,sp,out)
                self.assertEqual(str(caught.exception),"Invalid saved overlay inputs; no overlay review was written.")
                self.assertFalse(out.exists())
            rp.unlink()
            with self.assertRaises(ExtractionError) as caught:export_overlay_review(rp,sp,out)
            self.assertNotIn(str(root),str(caught.exception))

    def test_module_cli_offline_subprocess(self):
        r,s=fixture()
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);rp=root/"p.json";sp=root/"s.json";out=root/"o.json"
            rp.write_text(json.dumps(r));sp.write_text(json.dumps(s))
            run=subprocess.run([sys.executable,"-m","peekaplate_processing.overlay_review","--input",str(rp),
                                "--suggestions",str(sp),"--output",str(out)],capture_output=True,text=True,env=os.environ.copy())
            self.assertEqual(run.returncode,0,run.stderr)
            self.assertIn("SOCKET_GUARD_ATTEMPTS=0",run.stdout)
            self.assertNotIn("PRIVATE",run.stdout+run.stderr)


if __name__=="__main__":unittest.main()
