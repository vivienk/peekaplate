import io

from PIL import Image, ImageDraw


def menu_image()->bytes:
    image=Image.new("RGB", (800, 500), "white")
    draw=ImageDraw.Draw(image)
    draw.text((40, 50), "MENU\n\nTomato Soup  8.50 CAD\nGarden Salad  10.00 CAD", fill="black", font_size=26)
    output=io.BytesIO()
    image.save(output, format="JPEG")
    image.close()
    return output.getvalue()


def make_pdf(pages:list[dict])->bytes:
    objects=[b"", b"", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]

    def add(value):
        objects.append(value)
        return len(objects)

    page_ids=[]
    for page in pages:
        commands=[]
        resources="/Font << /F1 3 0 R >>"
        if page.get("text"):
            commands.append("BT /F1 12 Tf 16 TL 40 760 Td")
            for line in page["text"].splitlines():
                escaped=line.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                commands.append(f"({escaped}) Tj T*")
            commands.append("ET")
        if page.get("image"):
            raw=page["image"]
            with Image.open(io.BytesIO(raw)) as image:width,height=image.size
            image_id=add(f"<< /Type /XObject /Subtype /Image /Width {width} /Height {height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(raw)} >>\nstream\n".encode()+raw+b"\nendstream")
            resources+=f" /XObject << /Im0 {image_id} 0 R >>"
            commands.append("q 500 0 0 650 40 50 cm /Im0 Do Q")
        stream="\n".join(commands).encode("ascii")
        content_id=add(f"<< /Length {len(stream)} >>\nstream\n".encode()+stream+b"\nendstream")
        page_id=add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << {resources} >> /Contents {content_id} 0 R >>".encode())
        page_ids.append(page_id)
    objects[0]=b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1]=f"<< /Type /Pages /Count {len(pages)} /Kids [{' '.join(f'{value} 0 R' for value in page_ids)}] >>".encode()
    output=bytearray(b"%PDF-1.4\n")
    offsets=[0]
    for index,value in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode()+value+b"\nendobj\n")
    start=len(output)
    output.extend(f"xref\n0 {len(offsets)}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:output.extend(f"{offset:010} 00000 n \n".encode())
    output.extend(f"trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode())
    return bytes(output)
