"""The issued letter PDF reads as an official letter: letterhead, reference, subject, signatory, registered office."""
import base64
import re
import zlib
from datetime import date

from app.services.letters import ENTITY_ADDRESS, ENTITY_CONTACT, build_pdf

FIELDS = {"country_code": "GB", "legal_entity": "TimeZ UK Ltd", "employee_name": "Asha Rao", "title": "Engineer",
          "department": "Platform", "employee_code": "E-101"}


def _pdf(to_whom: bool) -> bytes:
    return build_pdf(fields=FIELDS, title="Promotion letter", to_whom=to_whom, paragraphs=["You are <b>promoted</b>."],
                     reference_no="INF-GB/HR/PRM/2026/0007", on=date(2026, 11, 11), approved_by="Priya Nair",
                     doc_id="DOC-20261111-ABC123", version=2)


def _text(pdf: bytes) -> bytes:
    """The page content streams, decoded (ReportLab writes ASCII85 + Flate)."""
    out = []
    for raw in re.findall(rb"stream\r?\n(.*?)endstream", pdf, re.S):
        try:
            out.append(zlib.decompress(base64.a85decode(raw.strip(), adobe=True)))
        except Exception:  # noqa: BLE001 - not every stream is page text
            continue
    return b"\n".join(out)


def test_every_country_has_contact_and_address():
    assert set(ENTITY_CONTACT) == set(ENTITY_ADDRESS)


def test_addressed_letter_has_letterhead_subject_signatory_and_footer():
    raw = _pdf(to_whom=False)
    assert raw.startswith(b"%PDF")
    pdf = _text(raw)
    for text in (b"TimeZ UK Ltd", b"20 Finsbury Circus", b"hr.uk@timez.com", b"INF-GB/HR/PRM/2026/0007",
                 b"Subject:", b"Asha Rao", b"Yours sincerely", b"Priya Nair", b"Authorised Signatory",
                 b"Registered office", b"Company No. 10293847", b"DOC-20261111-ABC123", b"version 2"):
        assert text in pdf, text


def test_certificate_uses_a_centred_title_not_a_subject_line():
    pdf = _text(_pdf(to_whom=True))
    assert b"PROMOTION LETTER" in pdf
    assert b"Subject:" not in pdf
    assert b"To whom it may concern" in pdf
