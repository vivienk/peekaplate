import ipaddress
import math
import re
import socket
from http.client import HTTPConnection, HTTPSConnection, HTTPException
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit

from peekaplate_processing.errors import ExtractionError


MAX_SOURCE_BYTES=12_000_000


def read_file(path:str|Path)->bytes:
    try:
        with Path(path).open("rb") as source:
            data=source.read(MAX_SOURCE_BYTES+1)
    except (OSError, ValueError):
        raise ExtractionError("Unable to read the menu input file.") from None
    check_size(data)
    return data


def check_size(data:bytes)->None:
    if not data or len(data)>MAX_SOURCE_BYTES:
        raise ExtractionError("Source must be nonempty and at most 12 MB.")


def detect_kind(data:bytes, media_type:str="")->str:
    if data.startswith(b"%PDF-"):
        return "pdf"
    if data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF8", b"II*\0", b"MM\0*", b"BM")) or (data.startswith(b"RIFF") and data[8:12]==b"WEBP"):
        return "image"
    if media_type.split(";")[0].lower()=="text/html" or re.match(br"\s*<(?:!doctype|html|head|body|main|section|article|div|h[1-6]|table|p)\b", data, re.IGNORECASE):
        return "website"
    try:
        text=data.decode("utf-8-sig")
    except UnicodeError:
        raise ExtractionError("Unsupported source; use a PDF, supported menu image, HTML or UTF-8 text.") from None
    if "\0" in text or any(ord(value)<32 and value not in "\r\n\t" for value in text):
        raise ExtractionError("Unsupported binary menu source.")
    return "text"


def safe_location(url:str)->str:
    parts=urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def resolve_public_url(url:str)->tuple:
    try:
        parts=urlsplit(url)
        if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password or parts.fragment:
            raise ValueError
        port=parts.port or (443 if parts.scheme=="https" else 80)
        if port!=(443 if parts.scheme=="https" else 80):
            raise ValueError
        hostname=parts.hostname.encode("idna").decode()
        addresses=socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
        if not addresses:
            raise ValueError
        for address in addresses:
            parsed=ipaddress.ip_address(address[4][0])
            if not parsed.is_global or parsed.is_multicast or parsed.is_unspecified:
                raise ValueError
        return parts,hostname,port,addresses[0][4][0]
    except (ValueError, UnicodeError, OSError):
        raise ExtractionError("Menu URL must resolve only to public HTTP/HTTPS addresses on standard ports.") from None


def fetch_public(url:str, *, timeout:float=30)->tuple[bytes,str,str]:
    if not math.isfinite(timeout) or not 0<timeout<=120:
        raise ExtractionError("Website timeout must be greater than zero and at most 120 seconds.")
    for redirect in range(4):
        parts,hostname,port,address=resolve_public_url(url)
        connection_type=HTTPSConnection if parts.scheme=="https" else HTTPConnection
        connection=connection_type(hostname, port, timeout=timeout)
        # Pin the validated address while retaining the hostname for TLS verification.
        connection._create_connection=lambda *args, **kwargs:socket.create_connection((address, port), timeout=timeout)
        try:
            target=urlunsplit(("", "", parts.path or "/", parts.query, ""))
            connection.request("GET", target, headers={"User-Agent":"PeekaPlateMenuImport/0.1", "Accept-Encoding":"identity"})
            response=connection.getresponse()
            if response.status in {301, 302, 303, 307, 308}:
                location=response.getheader("Location")
                if not location or redirect==3:
                    raise ExtractionError("Menu URL exceeded the redirect limit or omitted its destination.")
                destination=urljoin(url, location)
                if parts.scheme=="https" and urlsplit(destination).scheme!="https":
                    raise ExtractionError("Menu URL redirected from HTTPS to an insecure destination.")
                url=destination
                continue
            if response.status!=200:
                raise ExtractionError(f"Menu website returned HTTP {response.status}.")
            if response.getheader("Content-Encoding", "identity").lower() not in {"", "identity"}:
                raise ExtractionError("Compressed website responses are not supported; request an uncompressed menu export.")
            data=response.read(MAX_SOURCE_BYTES+1)
            check_size(data)
            return data,response.getheader("Content-Type", ""),url
        except ExtractionError:
            raise
        except (OSError, HTTPException, ValueError):
            raise ExtractionError("Menu website request failed or timed out.") from None
        finally:
            connection.close()
    raise ExtractionError("Unable to fetch the menu URL.")
