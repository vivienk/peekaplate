"""Automatically deliver an explicit local artwork approval to the diner API.

Configure INGREDIENT_ICON_API_URL, INGREDIENT_ICON_VENUE_ID and
INGREDIENT_ICON_STAFF_TOKEN once in the review environment. Tokens stay in memory.
Durable, pinned requests make approval retries safe after network failures.
"""
import argparse
import base64
import io
import json
import os
import unicodedata
import uuid
from urllib.parse import urlencode, urlparse
from urllib.request import Request, build_opener
from urllib.error import HTTPError, URLError

from PIL import Image

from .errors import ExtractionError
from .ingredient_icon_generation import NoRedirect, request_lock, validate_request
from .ingredient_icons import IconStore, digest


class HostedIconDelivery:
    def __init__(self, api_url, venue_id, token):
        url = urlparse(api_url)
        local = url.hostname in {"localhost", "127.0.0.1"}
        if (url.scheme != "https" and not (local and url.scheme == "http")) or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in {"", "/"}:
            raise ValueError("Expected a trusted API origin")
        self.venue = str(uuid.UUID(venue_id))
        if not token or any(c.isspace() for c in token):
            raise ValueError("Configure a staff bearer token")
        self.base = api_url.rstrip("/")
        self.token = token

    @classmethod
    def from_environment(cls):
        values = [os.environ.get(k) for k in
                  ("INGREDIENT_ICON_API_URL", "INGREDIENT_ICON_VENUE_ID", "INGREDIENT_ICON_STAFF_TOKEN")]
        if not any(values):
            return None
        if not all(values):
            raise ValueError("Configure all three ingredient icon delivery settings")
        return cls(*values)

    def request(self, path, payload=None):
        data = None if payload is None else json.dumps(payload).encode()
        req = Request(self.base + path, data=data,
                      headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"})
        for attempt in range(3):
            try:
                with build_opener(NoRedirect()).open(req, timeout=20) as response:
                    raw = response.read(65_537)
                if len(raw) > 65_536:
                    raise ValueError("Oversized response")
                value = json.loads(raw)
                if not isinstance(value, dict) or "state" not in value:
                    raise ValueError("Invalid response")
                return value
            except HTTPError as error:
                if error.code < 500 or attempt == 2:
                    raise ExtractionError("Artwork delivery rejected; approval is retained locally. Reconcile authorization/version and retry the same approval.") from None
            except (URLError, OSError):
                if attempt == 2:
                    raise ExtractionError("Artwork delivery unavailable; retry the same approval to resume its pinned request.") from None
            except (ValueError, RecursionError):
                raise ExtractionError("Invalid artwork delivery response; retry the same approval.") from None

    def deliver(self, store, key, reason):
        asset = store.asset(key)
        if asset.origin != "generated":
            raise ValueError("Hosted delivery currently accepts generated PNG illustrations")
        generation = json.loads(asset.recipe)
        validate_request(generation)
        label = " ".join(unicodedata.normalize("NFKC", generation["label"]).lower().split())
        if store.resolve(key, generation["ingredient_id"]) is None:
            raise ValueError("Explicit matching artwork approval required")
        data = base64.b64decode(store._read("blobs", asset.asset_sha256)["base64"], validate=True)
        with Image.open(io.BytesIO(data)) as picture:
            if picture.format != "PNG":
                raise ValueError("Hosted delivery requires a reviewed PNG; no silent format conversion")
        target = digest({"api": self.base, "venue": self.venue, "asset": key})
        path = f"/venues/{self.venue}/ingredient-icons"
        with request_lock(store, target):
            if store._path("delivered", target).exists():
                return store._read("delivered", target)
            if store._path("delivery", target).exists():
                payload = store._read("delivery", target)
            else:
                current = self.request(path + "?" + urlencode({"label": label}))["state"]
                if current is not None and (not isinstance(current, dict) or current.get("label") != label
                                           or type(current.get("version")) is not int or current["version"] < 1):
                    raise ValueError("Invalid current artwork version")
                payload = {"commandId": str(uuid.uuid5(uuid.NAMESPACE_URL, target)),
                           "expectedVersion": current["version"] if current else 0,
                           "label": label, "reason": reason, "status": "approved",
                           "sha256": asset.asset_sha256, "pngBase64": base64.b64encode(data).decode(),
                           "sourceAssetId": key, "styleVersion": asset.style_version,
                           "rightsConfirmed": True, "recipe": asset.recipe}
                store._put("delivery", target, payload)
            # A retry keeps the original command/version; never overwrite a newer
            # review by silently rebasing after a conflict.
            state = self.request(path + "/review", payload)["state"]
            expected = {"label": label, "version": payload["expectedVersion"] + 1,
                        "status": "approved", "sha256": asset.asset_sha256}
            if state != expected:
                raise ValueError("Artwork delivery identity mismatch")
            store._put("delivered", target, state)
            return state


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalogue", required=True)
    parser.add_argument("--asset-id", required=True)
    parser.add_argument("--status", choices=["approved", "rejected"], required=True)
    parser.add_argument("--reviewer", required=True)
    parser.add_argument("--reason", required=True)
    args = parser.parse_args(argv)
    try:
        delivered = IconStore(args.catalogue).review(args.asset_id, status=args.status,
                                         reviewer=args.reviewer, reason=args.reason)
    except (ValueError, OSError, ExtractionError, KeyError, TypeError):
        parser.exit(1, "Artwork review/delivery did not complete; check configuration and retry the same decision.\n")
    print("Artwork approved and delivered to the diner API; food review gates are unchanged." if delivered
          else "Artwork decision saved locally. No hosted delivery occurred.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
