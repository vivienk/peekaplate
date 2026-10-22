import json
import re
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

from peekaplate_processing.errors import ExtractionError


class MenuHTMLParser(HTMLParser):

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.frames=[]
        self.lines=[]
        self.menu_lines=[]
        self.links=[]
        self.structured=[]
        self.script_parts=None

    def handle_starttag(self, tag, attrs):
        attrs=dict(attrs)
        if tag=="script" and attrs.get("type", "").lower()=="application/ld+json":
            self.script_parts=[]
        parent_hidden=self.frames[-1][1] if self.frames else False
        hidden=parent_hidden or tag in {"script", "style", "nav", "footer", "head"} or "hidden" in attrs or attrs.get("aria-hidden")=="true"
        style=attrs.get("style", "").replace(" ", "").lower()
        hidden=hidden or "display:none" in style or "visibility:hidden" in style
        scope=self.frames[-1][2] if self.frames else False
        scope=scope or bool(re.search(r"(?:^|[\s_-])menu(?:$|[\s_-])", attrs.get("id", "")+" "+attrs.get("class", ""), re.IGNORECASE))
        if tag in {"p", "div", "section", "article", "li", "tr", "br", "h1", "h2", "h3", "h4"} and not hidden:
            self.lines.append("\n")
            if scope:self.menu_lines.append("\n")
        if tag=="a" and attrs.get("href") and not hidden:
            self.links.append(attrs["href"])
        if tag=="img" and attrs.get("src") and "menu" in attrs.get("alt", "").lower() and not hidden:
            self.links.append(attrs["src"])
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.frames.append((tag, hidden, scope))

    def handle_endtag(self, tag):
        if tag=="script" and self.script_parts is not None:
            self.structured.append("".join(self.script_parts))
            self.script_parts=None
        for index in range(len(self.frames)-1, -1, -1):
            if self.frames[index][0]==tag:
                _,hidden,scope=self.frames[index]
                if not hidden and tag in {"p", "div", "section", "article", "li", "tr", "h1", "h2", "h3", "h4"}:
                    self.lines.append("\n")
                    if scope:self.menu_lines.append("\n")
                elif not hidden and tag in {"td", "th", "span", "strong", "em"}:
                    self.lines.append(" ")
                    if scope:self.menu_lines.append(" ")
                del self.frames[index:]
                break

    def handle_data(self, data):
        if self.script_parts is not None:
            self.script_parts.append(data)
        if not self.frames or not self.frames[-1][1]:
            self.lines.append(data)
            if self.frames and self.frames[-1][2]:self.menu_lines.append(data)


def extract_website(data:bytes, base_url:str)->dict:
    if len(data)>2_000_000:
        raise ExtractionError("HTML menu source exceeds the 2 MB limit.")
    try:
        html=data.decode("utf-8-sig")
    except UnicodeError:
        raise ExtractionError("Website menu must provide UTF-8 HTML or an exported menu file.") from None
    parser=MenuHTMLParser()
    try:
        parser.feed(html)
        parser.close()
    except (ValueError, RecursionError):
        raise ExtractionError("Unable to parse website menu HTML.") from None
    structured=[]
    for script in parser.structured:
        try:
            value=json.loads(script)
        except (ValueError, RecursionError):
            continue
        if has_menu_items(value):
            structured.append(script)
    pieces=parser.menu_lines if "".join(parser.menu_lines).strip() else parser.lines
    text="\n".join(line.strip() for line in "".join(pieces).splitlines() if line.strip())
    links=[]
    for link in parser.links:
        try:
            target=urljoin(base_url, link)
            path=urlsplit(target).path.lower()
        except ValueError:
            raise ExtractionError("Website contains a malformed menu link; provide the menu URL directly.") from None
        if "menu" in path or path.endswith((".pdf", ".png", ".jpg", ".jpeg", ".webp")):
            if target not in links:links.append(target)
    return {"text":text, "links":links[:3], "structured":bool(structured), "structured_texts":structured}


def has_menu_items(value, depth=0)->bool:
    if depth>20:
        return False
    if isinstance(value, dict):
        kind=value.get("@type")
        if kind=="MenuItem" or (isinstance(kind, list) and "MenuItem" in kind):
            return True
        return any(has_menu_items(item, depth+1) for item in value.values())
    return isinstance(value, list) and any(has_menu_items(item, depth+1) for item in value)
