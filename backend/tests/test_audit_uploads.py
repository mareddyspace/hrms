"""Security audit: uploads (documents, HR case files, expense receipts) - size, type sniffing, spoofed content types,
path traversal and header injection in file names, and the download headers."""

from __future__ import annotations

import io
import os
import tempfile
import zipfile

import pytest
from sqlalchemy import select

from app.db import SessionLocal
from app.models import DocumentVersion

API = "/api/v1"
DOCS = f"{API}/documents"
PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
HTML = b"<html><script>alert(document.cookie)</script></html>"
SVG = b'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'
EXE = b"MZ\x90\x00" + b"\x00" * 200


@pytest.fixture(scope="module", autouse=True)
def storage_dir():
    old = os.environ.get("STORAGE_DIR")
    tmp = tempfile.mkdtemp(prefix="timez-audit-up-")
    os.environ["STORAGE_DIR"] = tmp
    yield tmp
    if old is None:
        os.environ.pop("STORAGE_DIR", None)
    else:
        os.environ["STORAGE_DIR"] = old


def upload(client, headers, data=PDF, content_type="application/pdf", **params):
    params = {"category": "Identity", "title": "Audit upload", "filename": "file.pdf"} | params
    return client.post(DOCS, headers={**headers, "Content-Type": content_type}, params=params, content=data)


def test_valid_pdf_is_accepted_and_served_safely(client, babu):
    res = upload(client, babu)
    assert res.status_code == 201, res.text
    dl = client.get(f"{DOCS}/{res.json()['id']}/download", headers=babu)
    assert dl.status_code == 200 and dl.content == PDF
    assert dl.headers["content-type"].startswith("application/pdf")
    assert dl.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in dl.headers.get("cache-control", "")
    assert dl.headers["content-disposition"].startswith("attachment")


@pytest.mark.parametrize("data,ctype", [
    (HTML, "text/html"), (HTML, "application/pdf"), (SVG, "image/svg+xml"), (SVG, "image/png"),
    (EXE, "application/octet-stream"), (EXE, "application/pdf"), (b"plain text", "text/plain"),
])
def test_dangerous_types_are_refused(client, babu, data, ctype):
    res = upload(client, babu, data=data, content_type=ctype)
    assert res.status_code == 415, (ctype, res.status_code, res.text)


@pytest.mark.parametrize("data,declared", [(PDF, "image/png"), (PNG, "application/pdf"), (PNG, "image/jpeg")])
def test_content_type_spoofing_is_refused(client, babu, data, declared):
    assert upload(client, babu, data=data, content_type=declared).status_code == 415


def test_octet_stream_is_sniffed_not_trusted(client, babu):
    res = upload(client, babu, data=PNG, content_type="application/octet-stream", filename="x.pdf")
    assert res.status_code == 201
    dl = client.get(f"{DOCS}/{res.json()['id']}/download", headers=babu)
    assert dl.headers["content-type"].startswith("image/png")


def test_empty_and_oversize_files(client, babu):
    assert upload(client, babu, data=b"").status_code in (413, 415, 422)
    big = PDF + b"0" * (10 * 1024 * 1024)
    assert upload(client, babu, data=big).status_code == 413


def test_zip_that_is_not_a_word_file_is_refused(client, babu):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("payload.sh", "rm -rf /")
    docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    assert upload(client, babu, data=buf.getvalue(), content_type=docx, filename="x.docx").status_code == 415


@pytest.mark.parametrize("name", ["../../../etc/passwd.pdf", "..\\..\\windows\\win.ini.pdf", "/abs/path.pdf",
                                  "a\r\nSet-Cookie: x=1.pdf", "<script>alert(1)</script>.pdf", "....//....//x.pdf",
                                  "%2e%2e%2fsecret.pdf", "CON.pdf", "x" * 255])
def test_file_names_are_cleaned(client, babu, storage_dir, name):
    res = upload(client, babu, filename=name)
    assert res.status_code in (201, 422), res.text
    if res.status_code != 201:
        return
    with SessionLocal() as db:
        v = db.scalar(select(DocumentVersion).where(DocumentVersion.document_id == res.json()["id"]))
    assert "/" not in v.file_name and "\\" not in v.file_name and "\r" not in v.file_name and "\n" not in v.file_name
    assert "<" not in v.file_name and ".." not in v.storage_path
    assert v.file_name not in v.storage_path  # stored under a generated id, never the user's name
    stored = os.path.realpath(os.path.join(storage_dir, v.storage_path))
    assert stored.startswith(os.path.realpath(storage_dir))
    dl = client.get(f"{DOCS}/{res.json()['id']}/download", headers=babu)
    cd = dl.headers["content-disposition"]
    assert "\r" not in cd and "\n" not in cd and "set-cookie" not in {k.lower() for k in dl.headers}


def test_storage_keys_cannot_escape():
    from app.services import storage

    for bad in ("../x", "..\\x", "/etc/passwd", "documents/../../x", "C:\\x", ""):
        with pytest.raises(storage.StorageError):
            storage.check_key(bad)


def test_case_file_upload_rules(client, babu):
    case = client.post(f"{API}/cases", headers=babu, json={"category": "Grievance", "anonymous": False,
                                                            "description": "Audit: evidence upload rules for cases."})
    assert case.status_code == 201, case.text
    url = f"{API}/cases/{case.json()['id']}/files"
    assert client.post(url, headers={**babu, "Content-Type": "text/html"}, content=HTML).status_code == 415
    assert client.post(url, headers={**babu, "Content-Type": "image/png"}, content=PDF).status_code == 415
    assert client.post(url, headers={**babu, "Content-Type": "application/pdf"},
                       content=PDF + b"0" * (5 * 1024 * 1024)).status_code == 413
    ok = client.post(url, headers={**babu, "Content-Type": "application/pdf"}, params={"filename": "../../x.pdf"}, content=PDF)
    assert ok.status_code == 201, ok.text
    assert "/" not in ok.text.split('"file_name":"')[-1].split('"')[0] if '"file_name"' in ok.text else True


def test_upload_for_someone_else_is_refused(client, babu, ram):
    assert upload(client, babu, employee_id="emp-ram").status_code in (403, 404)
    assert upload(client, ram, employee_id="emp-mahesh").status_code == 403  # managers don't upload for reports
