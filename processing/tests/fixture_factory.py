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


def food_photo(width=2000, height=1500, orientation=None)->bytes:
    image=Image.new("RGB", (width, height), "#e8e2d6")
    draw=ImageDraw.Draw(image)
    draw.rectangle((width//12, height//12, width-width//12, height-height//12), fill="#8b5a2b")
    draw.ellipse((width//3, height//3, width*2//3, height*2//3), fill="#c0392b")
    draw.text((width//20, height//20), "SYNTHETIC FIXTURE", fill="white", font_size=max(12, width//24))
    output=io.BytesIO()
    if orientation is None:
        image.save(output, format="JPEG", quality=92)
    else:
        exif=Image.Exif()
        exif[0x0112]=orientation
        image.save(output, format="JPEG", quality=92, exif=exif)
    image.close()
    return output.getvalue()


def layered_photo(width=1280, height=960)->dict[str, bytes]:
    layers={}
    background=Image.new("RGB", (width, height), "#e8e2d6")
    draw=ImageDraw.Draw(background)
    draw.rectangle((width//12, height//12, width-width//12, height-height//12), fill="#8b5a2b")
    draw.text((width//20, height//20), "SYNTHETIC FIXTURE", fill="black", font_size=max(12, width//40))
    output=io.BytesIO()
    background.save(output, format="PNG")
    background.close()
    layers["background"]=output.getvalue()
    subject=Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw=ImageDraw.Draw(subject)
    draw.ellipse((width//4, height//4, width*3//4, height*3//4), fill=(192, 57, 43, 255))
    draw.text((width//20, height//2), "SYNTHETIC FIXTURE", fill=(255, 255, 255, 255), font_size=max(12, width//40))
    output=io.BytesIO()
    subject.save(output, format="PNG")
    subject.close()
    layers["subject"]=output.getvalue()
    accent=Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw=ImageDraw.Draw(accent)
    draw.rectangle((width//3, height//8, width//3+ width//8, height//8+height//8), fill=(241, 196, 15, 255))
    output=io.BytesIO()
    accent.save(output, format="PNG")
    accent.close()
    layers["accent"]=output.getvalue()
    return layers


def cutout_photo(width=1280, height=960)->bytes:
    image=Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw=ImageDraw.Draw(image)
    draw.ellipse((width//4, height//4, width*3//4, height*3//4), fill=(192, 57, 43, 255))
    output=io.BytesIO()
    image.save(output, format="PNG")
    image.close()
    return output.getvalue()


def presentation_photo(width=2048, height=2048, transparent_corners=True, has_alpha=True)->bytes:
    mode="RGBA" if has_alpha else "RGB"
    bg=(0, 0, 0, 0) if (has_alpha and transparent_corners) else (232, 226, 214, 255 if has_alpha else None)
    if not has_alpha:
        bg=(232, 226, 214)
    image=Image.new(mode, (width, height), bg)
    draw=ImageDraw.Draw(image)
    plate_color=(245, 245, 245, 255) if has_alpha else (245, 245, 245)
    food_color=(192, 57, 43, 255) if has_alpha else (192, 57, 43)
    draw.ellipse((width//8, height//8, width*7//8, height*7//8), fill=plate_color)
    draw.ellipse((width//4, height//4, width*3//4, height*3//4), fill=food_color)
    output=io.BytesIO()
    image.save(output, format="PNG")
    image.close()
    return output.getvalue()
