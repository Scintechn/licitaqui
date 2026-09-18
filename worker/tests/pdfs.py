"""Minimal PDFs built in memory, so the fixtures are readable and versionable.

A scanned edital is the acceptance criterion of task C1 ("no_text, and no AI
call"), and a committed binary would be a fixture nobody can review. These
builders produce the two cases the extractor has to tell apart: pages with a
text layer, and pages that carry an image and no text at all — which is what
pdfplumber sees in a scan.
"""

from __future__ import annotations

# A 1×1 black pixel, uncompressed: enough for a page to have visible content
# and no text layer, the way a scan does.
_IMAGE_DATA = b"\x00\x00\x00"


def _build(objects: list[bytes]) -> bytes:
    """Assemble numbered objects into a PDF with a correct xref table."""
    out = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode()
    out += b"0000000000 65535 f \n"
    for offset in offsets[1:]:
        out += f"{offset:010d} 00000 n \n".encode()
    out += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    )
    return bytes(out)


def text_pdf(pages: list[str]) -> bytes:
    """A PDF whose pages carry the given lines of text."""
    objects: list[bytes] = [b"", b""]  # 1 = catalog, 2 = pages, filled in below
    page_ids: list[int] = []
    for text in pages:
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        stream = f"BT /F1 12 Tf 40 750 Td ({escaped}) Tj ET".encode("latin-1", "replace")
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content_id = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 "
            b"/BaseFont /Helvetica >> >> >> "
            b"/Contents %d 0 R >>" % content_id
        )
        page_ids.append(len(objects))
    kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Count %d /Kids [%s] >>" % (len(page_ids), kids)
    return _build(objects)


def scanned_pdf(page_count: int = 3) -> bytes:
    """A PDF with no text layer at all: every page is just an image, like a scan."""
    objects: list[bytes] = [b"", b""]
    objects.append(
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB "
        b"/BitsPerComponent 8 /Length %d >>\nstream\n%s\nendstream"
        % (len(_IMAGE_DATA), _IMAGE_DATA)
    )
    image_id = len(objects)
    page_ids: list[int] = []
    for _ in range(page_count):
        stream = b"q 595 0 0 842 0 0 cm /Im0 Do Q"
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream))
        content_id = len(objects)
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
            b"/Resources << /XObject << /Im0 %d 0 R >> >> /Contents %d 0 R >>"
            % (image_id, content_id)
        )
        page_ids.append(len(objects))
    kids = b" ".join(b"%d 0 R" % pid for pid in page_ids)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Count %d /Kids [%s] >>" % (len(page_ids), kids)
    return _build(objects)


def zip_of(*pdfs: bytes) -> bytes:
    """The same PDFs inside a ZIP, the way many agencies publish an edital."""
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for index, pdf in enumerate(pdfs, 1):
            archive.writestr(f"{index:02d}_anexo.pdf", pdf)
        archive.writestr("leiame.txt", "not a pdf")
    return buffer.getvalue()
