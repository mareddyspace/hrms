"""Sample data for the employee experience pages (migration 0037): an asset inventory with the demo people's laptops,
a few open asset requests, immigration / ID documents (the same samples as the portal's local mode) and the privacy
centre's retention policy, consents and data requests.

Insert-only and idempotent: every row has a fixed id and is skipped when it exists (or when its tag / category / number
is already used), so running it against a live database adds only what is missing and never changes a person's data.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Asset, AssetRequest, Employee, ImmigrationDocument, PrivacyConsent, PrivacyRequest, RetentionRule

IT_PERSON = "demo-admin"
HR_PERSON = "demo-hr-admin"


def _h(at: date, action: str, by: str | None, by_name: str, status: str | None = None, note: str | None = None) -> dict[str, Any]:
    return {"at": datetime.combine(at, time(10, 0), tzinfo=timezone.utc).isoformat(), "action": action, "by": by,
            "by_name": by_name, "note": note, "status": status}


def _name(db: Session, emp_id: str | None) -> str:
    emp = db.get(Employee, emp_id) if emp_id else None
    return emp.full_name if emp else "System"


# id, tag, name, category, holder (None = in stock), assigned_on, condition, country
ASSETS: tuple[tuple[str, str, str, str, str | None, str | None, str, str], ...] = (
    ("asset-1", "LT-4821", "Dell Latitude 7440", "Laptop", "emp-mahesh", "2024-01-08", "Good", "IN"),
    ("asset-2", "HS-1190", "Jabra Evolve2 65 headset", "Headset", "emp-mahesh", "2024-01-08", "Good", "IN"),
    ("asset-mahesh-id", "ID-IN-0418", "Office ID card", "ID card", "emp-mahesh", "2024-01-08", "Good", "IN"),
    ("asset-priya-1", "LT-6120", "Lenovo ThinkPad T14", "Laptop", "emp-priya", "2023-01-09", "Good", "IN"),
    ("asset-oliver-1", "LT-UK-0412", "MacBook Pro 14", "Laptop", "emp-oliver", "2022-09-12", "Good", "GB"),
    ("asset-oliver-2", "MB-UK-0077", "Pixel 8 test phone", "Phone", "emp-oliver", "2024-03-04", "Good", "GB"),
    ("asset-ram-1", "LT-3307", "Dell XPS 13", "Laptop", "emp-ram", "2021-06-14", "Fair", "IN"),
    ("asset-ram-2", "MN-2210", "Dell 27\" monitor", "Monitor", "emp-ram", "2022-02-01", "Good", "IN"),
    ("asset-hr-1", "LT-5102", "Lenovo ThinkPad X1 Carbon", "Laptop", HR_PERSON, "2023-04-03", "Good", "IN"),
    ("asset-admin-1", "LT-UK-0388", "MacBook Air 13", "Laptop", IT_PERSON, "2022-05-16", "Good", "GB"),
    ("asset-stock-1", "LT-7001", "Dell Latitude 7440", "Laptop", None, None, "New", "IN"),
    ("asset-stock-2", "LT-7002", "Lenovo ThinkPad T14", "Laptop", None, None, "Good", "IN"),
    ("asset-stock-3", "MN-3001", "Dell 24\" monitor", "Monitor", None, None, "New", "IN"),
    ("asset-stock-4", "MN-3002", "Dell 27\" monitor", "Monitor", None, None, "Good", "IN"),
    ("asset-stock-5", "HS-2001", "Jabra Evolve2 65 headset", "Headset", None, None, "New", "IN"),
    ("asset-stock-6", "DK-1001", "Dell WD19 docking station", "Docking station", None, None, "New", "IN"),
    ("asset-stock-7", "KB-1001", "Logitech MX keys and mouse", "Keyboard and mouse", None, None, "New", "IN"),
    ("asset-stock-8", "LT-UK-0501", "MacBook Pro 14", "Laptop", None, None, "New", "GB"),
    ("asset-stock-9", "MB-UK-0090", "iPhone 15", "Phone", None, None, "New", "GB"),
    ("asset-repair-1", "LT-6890", "HP EliteBook 840", "Laptop", None, None, "Damaged", "IN"),
)


def _seed_assets(db: Session, today: date) -> dict[str, int]:
    stats = {"assets_added": 0, "asset_requests_added": 0}
    tags = set(db.scalars(select(Asset.tag)))
    it_name = _name(db, IT_PERSON)
    for aid, tag, name, category, holder, on, condition, country in ASSETS:
        if db.get(Asset, aid) is not None or tag in tags:
            continue
        if holder and db.get(Employee, holder) is None:
            holder = None
        assigned = date.fromisoformat(on) if holder and on else None
        added = (assigned or today - timedelta(days=60)) - timedelta(days=7)
        hist = [_h(added, "Added to inventory", IT_PERSON, it_name, "in_stock")]
        status = "in_stock"
        if aid == "asset-repair-1":
            status = "in_repair"
            hist.append(_h(today - timedelta(days=9), "Sent for repair", IT_PERSON, it_name, "in_repair", "Hinge cracked."))
        if holder and assigned:
            status = "assigned"
            hist.append(_h(assigned, f"Issued to {_name(db, holder)}", IT_PERSON, it_name, "assigned"))
        db.add(Asset(id=aid, tag=tag, name=name, category=category, status=status, employee_id=holder if status == "assigned" else None,
                     assigned_on=assigned if status == "assigned" else None, condition=condition, country_code=country,
                     history=hist))
        tags.add(tag)
        stats["assets_added"] += 1
    db.flush()

    def req(rid: str, emp_id: str, kind: str, category: str, item: str, reason: str, status: str, days_ago: int,
            asset_id: str | None = None, steps: list[tuple[str, str | None, str, str | None]] | None = None) -> None:
        emp = db.get(Employee, emp_id)
        if db.get(AssetRequest, rid) is not None or emp is None:
            return
        if asset_id and db.get(Asset, asset_id) is None:
            return
        raised = today - timedelta(days=days_ago)
        first = {"new": "Requested", "repair": "Reported for repair", "lost": "Reported lost", "return": "Return requested"}[kind]
        hist = [_h(raised, first, emp.id, emp.full_name, "Pending manager" if kind == "new" and emp.manager_id else "Pending IT", reason)]
        for action, by, st, note in steps or []:
            hist.append(_h(raised + timedelta(days=1), action, by, _name(db, by), st, note))
        closed = status in ("Fulfilled", "Resolved", "Returned", "Rejected", "Cancelled")
        db.add(AssetRequest(id=rid, employee_id=emp.id, kind=kind, category=category, item=item, reason=reason,
                            asset_id=asset_id, status=status,
                            manager_id=emp.manager_id if status == "Pending manager" else None,
                            decided_by=(steps or [(None, None, None, None)])[-1][1] if steps else None,
                            decision_note=(steps or [(None, None, None, None)])[-1][3] if steps else None,
                            closed_on=raised + timedelta(days=1) if closed else None, history=hist,
                            created_at=datetime.combine(raised, time(10, 0), tzinfo=timezone.utc)))
        stats["asset_requests_added"] += 1

    req("areq-seed-1", "emp-mahesh", "new", "Monitor", "Second monitor", "Working on the payroll reports needs a second screen.",
        "Pending manager", 2)
    req("areq-seed-2", "emp-priya", "new", "Docking station", "Docking station", "Hot-desking on Tuesdays; need a dock for the laptop.",
        "Pending IT", 4, steps=[("Manager approved", "emp-ram", "Pending IT", "Fine, go ahead.")])
    req("areq-seed-3", "emp-oliver", "repair", "Phone", "Pixel 8 test phone (MB-UK-0077)", "Screen flickers after the last update.",
        "Pending IT", 1, asset_id="asset-oliver-2")
    req("areq-seed-4", "emp-mahesh", "new", "Headset", "Headset", "The old headset microphone stopped working on calls.",
        "Fulfilled", 300, asset_id="asset-2",
        steps=[("Manager approved", "emp-ram", "Pending IT", None), ("Fulfilled", IT_PERSON, "Fulfilled", "Issued HS-1190.")])
    return stats


def _seed_immigration(db: Session, today: date) -> int:
    rel = lambda days: today + timedelta(days=days)  # noqa: E731
    added = 0
    numbers = {(d.doc_type, d.number, d.issuing_country) for d in db.scalars(select(ImmigrationDocument))}

    def doc(emp_id: str | None, doc_type: str, number: str, country: str, issue: date, expiry: date, sponsor: str | None = None,
            renewal: bool = False, pending: bool = False) -> None:
        nonlocal added
        if not emp_id:
            return
        did = f"idd-{emp_id}-{doc_type.replace('/', '').replace(' ', '').lower()}"
        if db.get(ImmigrationDocument, did) is not None or (doc_type, number, country) in numbers or db.get(Employee, emp_id) is None:
            return
        hr_name = _name(db, HR_PERSON)
        hist = [_h(issue if not pending else rel(-2), "Added", emp_id if pending else HR_PERSON,
                   _name(db, emp_id) if pending else hr_name, "pending" if pending else "verified")]
        if renewal:
            hist.append(_h(rel(-6), "Renewal started", emp_id, _name(db, emp_id)))
        db.add(ImmigrationDocument(id=did, employee_id=emp_id, doc_type=doc_type, number=number, issuing_country=country,
                                   issue_date=issue, expiry_date=expiry, sponsor=sponsor, renewal_in_progress=renewal,
                                   verification="pending" if pending else "verified",
                                   verified_by=None if pending else HR_PERSON, verified_on=None if pending else issue,
                                   updated_by=emp_id if pending else HR_PERSON, history=hist))
        numbers.add((doc_type, number, country))
        added += 1

    d = date.fromisoformat
    doc("emp-mahesh", "Passport", "Z4821937", "India", d("2019-03-11"), d("2029-03-10"))
    doc("emp-mahesh", "Visa", "B1B2-55017342", "United States", d("2022-01-05"), rel(64))
    doc("emp-priya", "Passport", "T6120458", "India", d("2021-09-14"), d("2031-09-13"))
    doc("emp-oliver", "Passport", "548208261", "United Kingdom", d("2021-05-04"), d("2031-05-03"))
    doc(HR_PERSON, "Passport", "W9017325", "India", d("2018-07-02"), d("2028-07-01"))
    doc(IT_PERSON, "Passport", "533829104", "United Kingdom", d("2021-05-20"), d("2031-05-19"))

    demo = {"emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", HR_PERSON, "demo-recruiter", "demo-ceo", IT_PERSON}

    def people(code: str, n: int) -> list[str]:
        rows = db.scalars(select(Employee.id).where(Employee.country_code == code, Employee.employment_status == "Active")
                          .order_by(Employee.id)).all()
        return ([r for r in rows if r not in demo] + [None, None, None])[:n]  # type: ignore[list-item]

    ae1, ae2, ae3 = people("AE", 3)
    doc(ae1, "Passport", "P8812094", "India", d("2020-02-14"), d("2030-02-13"))
    doc(ae1, "Emirates ID", "784-1990-4821937-2", "United Arab Emirates", d("2024-11-02"), rel(22), "TimeZ FZ-LLC")
    doc(ae1, "Visa", "201/2024/7/118204", "United Arab Emirates", d("2024-11-01"), rel(21), "TimeZ FZ-LLC")
    doc(ae2, "Emirates ID", "784-1987-1130554-8", "United Arab Emirates", d("2023-06-10"), rel(310), "TimeZ FZ-LLC")
    doc(ae3, "Work permit", "MOHRE-4419027", "United Arab Emirates", d("2024-10-20"), rel(48), "TimeZ FZ-LLC", renewal=True)
    doc(ae3, "Passport", "P3390218", "Philippines", d("2022-04-04"), d("2032-04-03"), pending=True)
    sa1, sa2 = people("SA", 2)
    doc(sa1, "Residence ID/Iqama", "2398104472", "Saudi Arabia", d("2025-01-12"), rel(81), "TimeZ Arabia LLC")
    doc(sa1, "Passport", "K1180397", "Pakistan", d("2019-12-01"), d("2029-11-30"))
    doc(sa2, "Residence ID/Iqama", "2471003856", "Saudi Arabia", d("2024-08-30"), rel(-5), "TimeZ Arabia LLC")
    de1, de2 = people("DE", 2)
    doc(de1, "Aufenthaltstitel", "Y7H40L2K9", "Germany", d("2023-03-15"), rel(140))
    doc(de2, "National ID", "L01X00T47", "Germany", d("2018-05-09"), rel(37))
    gb1, gb2 = people("GB", 2)
    doc(gb1, "BRP/UK right-to-work", "ZU1907752", "United Kingdom", d("2021-12-06"), rel(-30))
    doc(gb2, "Passport", "551204873", "United Kingdom", d("2016-10-26"), rel(10))
    return added


RETENTION = (
    ("rt-1", "Payroll and tax records", 8, "years", "Legal obligation"),
    ("rt-2", "Recruitment — unsuccessful candidates", 6, "months", "Legitimate interest"),
    ("rt-3", "Employee personnel file", 6, "years", "Contract"),
    ("rt-4", "Immigration and right-to-work documents", 2, "years", "Legal obligation"),
    ("rt-5", "Grievance and POSH case files", 5, "years", "Legal obligation"),
    ("rt-6", "CCTV and access logs", 30, "months", "Legitimate interest"),
)


def _seed_privacy(db: Session, today: date) -> dict[str, int]:
    stats = {"retention_rules_added": 0, "consents_added": 0, "privacy_requests_added": 0}
    categories = {c.strip().lower() for c in db.scalars(select(RetentionRule.category))}
    for rid, category, period, unit, basis in RETENTION:
        if db.get(RetentionRule, rid) is None and category.lower() not in categories:
            db.add(RetentionRule(id=rid, category=category, period=period, unit=unit, legal_basis=basis))
            stats["retention_rules_added"] += 1

    def at(days_ago: int, minute: int) -> datetime:
        return datetime.combine(today - timedelta(days=days_ago), time(9, minute), tzinfo=timezone.utc)

    for cid, emp_id, topic, granted, ago, minute in (
        ("cs-1", "emp-mahesh", "directory-photo", True, 180, 12), ("cs-2", "emp-mahesh", "birthday-team", True, 180, 13),
        ("cs-3", "emp-mahesh", "comms-emails", True, 180, 14), ("cs-4", "emp-mahesh", "comms-emails", False, 40, 2),
        ("cs-6", "emp-priya", "directory-photo", True, 200, 12), ("cs-7", "emp-priya", "birthday-team", True, 200, 13),
        ("cs-8", "emp-oliver", "directory-photo", True, 150, 12), ("cs-9", "emp-oliver", "comms-emails", False, 150, 13),
        ("cs-5", "emp-ram", "directory-photo", True, 300, 0),
    ):
        if db.get(PrivacyConsent, cid) is None and db.get(Employee, emp_id) is not None:
            db.add(PrivacyConsent(id=cid, employee_id=emp_id, topic=topic, granted=granted, created_at=at(ago, minute)))
            stats["consents_added"] += 1

    hr_name = _name(db, HR_PERSON)
    for rid, emp_id, kind, details, ago, status, outcome in (
        ("dsr-1", "emp-mahesh", "Correction", "Date of joining on my profile should be 15 Apr 2019.", 12, "In progress", None),
        ("dsr-2", "emp-ram", "Access", "Copy of my performance review history.", 34, "Open", None),
        ("dsr-3", IT_PERSON, "Deletion", "Remove my old home address from the directory.", 60, "Closed (manual)",
         "Old address removed from all records."),
    ):
        emp = db.get(Employee, emp_id)
        if db.get(PrivacyRequest, rid) is not None or emp is None:
            continue
        raised = today - timedelta(days=ago)
        hist = [_h(raised, "Raised", emp_id, emp.full_name, "Open")]
        if status != "Open":
            hist.append(_h(raised + timedelta(days=2), "In progress", HR_PERSON, hr_name, "In progress"))
        if status == "Closed (manual)":
            hist.append(_h(raised + timedelta(days=15), status, HR_PERSON, hr_name, status, outcome))
        db.add(PrivacyRequest(id=rid, employee_id=emp_id, kind=kind, details=details, due_on=raised + timedelta(days=30),
                              status=status, handled_by=HR_PERSON if status != "Open" else None,
                              closed_on=raised + timedelta(days=15) if status == "Closed (manual)" else None,
                              outcome=outcome, history=hist,
                              created_at=datetime.combine(raised, time(10, 0), tzinfo=timezone.utc)))
        stats["privacy_requests_added"] += 1
    return stats


def seed(db: Session, today: date | None = None) -> dict[str, int]:
    today = today or date.today()
    stats = _seed_assets(db, today)
    stats["immigration_records_added"] = _seed_immigration(db, today)
    stats.update(_seed_privacy(db, today))
    db.flush()
    return stats
