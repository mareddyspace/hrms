"""Employee experience rules: assets, immigration / ID documents and the privacy centre (migration 0037).

Who does what
- Assets: everyone sees and requests their own; a manager approves new-asset requests from their reporting line;
  IT (admin, super_admin, it_admin) keeps the inventory, issues, repairs and takes back assets; HR reads assets of
  people in its scope. Repair / lost / return reports go straight to IT.
- Immigration documents: the holder adds and updates their own (HR verifies them); HR in scope sees full numbers,
  adds documents for people (verified at once) and verifies; managers see their team's documents with the number
  masked (status and expiry only). Nobody verifies their own document.
- Privacy: consents are per person (opt-in, an event log); data requests are handled by HR in scope within 30 days,
  never by the requester; the retention policy is read by everyone and edited by HR.

Every change adds a history entry (the status timeline), an audit row and notices to the people who act next.
Mirrors the portal rules in src/features/compliance/immigrationStore.ts and privacyStore.ts.
"""

from __future__ import annotations

import re
import uuid
from datetime import date, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import utcnow
from app.models import Asset, AssetRequest, Employee, ImmigrationDocument, PrivacyConsent, PrivacyRequest, RetentionRule
from app.services.activity import notify, record_audit, short_date
from app.services.approvals import _accounts_with_roles
from app.services.scope import HR_ROLES, Scope

IT_ROLES = frozenset({"admin", "super_admin", "it_admin"})
LEFT = ("Terminated", "Exited")


class RuleError(ValueError):
    """A rule was broken; safe to show. 403 when it starts with "Only", 409 with "already", else 422."""


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def name_of(db: Session, employee_id: str | None) -> str:
    emp = db.get(Employee, employee_id) if employee_id else None
    return emp.full_name if emp else ""


def add_history(row: Any, db: Session, actor_id: str | None, action: str, note: str | None = None,
                status: str | None = None) -> None:
    entry = {"at": utcnow().isoformat(), "action": action, "by": actor_id, "by_name": name_of(db, actor_id) or "System",
             "note": (note or "").strip() or None, "status": status}
    row.history = [*(row.history or []), entry]


def it_ids(db: Session, country: str | None = None) -> list[str]:
    return _accounts_with_roles(db, set(IT_ROLES), country)


def hr_ids(db: Session, country: str | None = None) -> list[str]:
    return _accounts_with_roles(db, set(HR_ROLES), country)


def tell(db: Session, ids: list[str] | set[str], title: str, body: str, href: str, skip: str | None = None) -> None:
    for rid in dict.fromkeys(i for i in ids if i and i != skip):
        notify(db, recipient_id=rid, title=title, body=body, href=href)


# ============================== assets ==============================
ASSET_CATEGORIES = ("Laptop", "Monitor", "Phone", "Headset", "Keyboard and mouse", "Docking station", "ID card",
                    "Furniture", "Other")
CONDITIONS = ("New", "Good", "Fair", "Damaged")
ASSET_STATUSES = ("in_stock", "assigned", "in_repair", "lost", "retired")
REQUEST_KINDS = ("new", "repair", "lost", "return")
OPEN_REQUEST = ("Pending manager", "Pending IT")
ASSETS_HREF = "/assets"


def is_it(role: str) -> bool:
    return role in IT_ROLES


def can_see_request(user_scope: Scope, role: str, emp: Employee, req: AssetRequest) -> bool:
    return is_it(role) or user_scope.can_see(emp) or req.manager_id == user_scope.self_id


def create_asset_request(db: Session, emp: Employee, actor_id: str, kind: str, category: str, item: str, reason: str,
                         asset_id: str | None, needed_by: date | None) -> AssetRequest:
    if kind not in REQUEST_KINDS:
        raise RuleError("Choose what you need: a new asset, a repair, a lost asset or a return.")
    reason = reason.strip()
    if len(reason) < 10:
        raise RuleError("Tell us why (at least 10 characters).")
    asset: Asset | None = None
    if kind == "new":
        if category not in ASSET_CATEGORIES:
            raise RuleError("Choose an asset type.")
        item = item.strip() or category
        if needed_by and needed_by < date.today():
            raise RuleError("The needed-by date can't be in the past.")
        if db.scalar(select(AssetRequest.id).where(AssetRequest.employee_id == emp.id, AssetRequest.kind == "new",
                                                   AssetRequest.category == category, AssetRequest.status.in_(OPEN_REQUEST))):
            raise RuleError(f"You already have an open request for a {category.lower()}.")
        held = db.scalar(select(Asset.tag).where(Asset.employee_id == emp.id, Asset.category == category,
                                                 Asset.status == "assigned"))
        if held and category in ("Laptop", "Phone", "ID card"):
            raise RuleError(f"You already hold {held}. Report it for repair or return it instead.")
        status = "Pending manager" if emp.manager_id else "Pending IT"
    else:
        asset = db.get(Asset, asset_id) if asset_id else None
        if asset is None or asset.employee_id != emp.id or asset.status not in ("assigned", "in_repair"):
            raise RuleError("Choose one of the assets assigned to you.")
        if db.scalar(select(AssetRequest.id).where(AssetRequest.asset_id == asset.id, AssetRequest.status.in_(OPEN_REQUEST))):
            raise RuleError(f"{asset.tag} already has an open request.")
        category, item, status = asset.category, f"{asset.name} ({asset.tag})", "Pending IT"
    row = AssetRequest(id=new_id("areq"), employee_id=emp.id, kind=kind, category=category, item=item[:120],
                       reason=reason, needed_by=needed_by, asset_id=asset.id if asset else None, status=status,
                       manager_id=emp.manager_id if status == "Pending manager" else None, history=[])
    label = {"new": "Requested", "repair": "Reported for repair", "lost": "Reported lost", "return": "Return requested"}[kind]
    add_history(row, db, actor_id, label, reason, status)
    db.add(row)
    what = {"new": f"New asset request · {item}", "repair": f"Repair needed · {row.item}",
            "lost": f"Asset reported lost · {row.item}", "return": f"Asset return · {row.item}"}[kind]
    if status == "Pending manager":
        tell(db, [emp.manager_id or ""], f"{what} from {emp.full_name}", "Waiting for your approval.", ASSETS_HREF)
    else:
        tell(db, it_ids(db, emp.country_code), f"{what} from {emp.full_name}", reason[:200], ASSETS_HREF, skip=emp.id)
    if kind == "lost":
        tell(db, [emp.manager_id or ""], f"{emp.full_name} reported {row.item} lost", reason[:200], ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action=f"asset_request_{kind}", entity="asset_request", entity_id=row.id,
                 subject_id=emp.id, after={"kind": kind, "category": category, "status": status, "asset_id": row.asset_id})
    return row


def manager_decide(db: Session, req: AssetRequest, actor_id: str, approve: bool, note: str) -> None:
    if req.status != "Pending manager":
        raise RuleError("This request is not waiting for a manager.")
    if req.manager_id != actor_id:
        raise RuleError("Only the requester's manager can approve this request.")
    if not approve and len(note.strip()) < 5:
        raise RuleError("Give a reason for declining (at least 5 characters).")
    emp = db.get(Employee, req.employee_id)
    assert emp is not None
    before = req.status
    req.status = "Pending IT" if approve else "Rejected"
    req.decided_by, req.decision_note = actor_id, note.strip() or None
    if not approve:
        req.closed_on = date.today()
    add_history(req, db, actor_id, "Manager approved" if approve else "Manager declined", note, req.status)
    if approve:
        tell(db, it_ids(db, emp.country_code), f"Approved asset request · {req.item} for {emp.full_name}",
             "Approved by the manager; ready to issue.", ASSETS_HREF, skip=emp.id)
        tell(db, [emp.id], f"Your {req.item} request was approved", "IT will issue it next.", ASSETS_HREF)
    else:
        tell(db, [emp.id], f"Your {req.item} request was declined", note.strip(), ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action="asset_request_manager_decision", entity="asset_request", entity_id=req.id,
                 subject_id=emp.id, before={"status": before}, after={"status": req.status})


def _assign(db: Session, asset: Asset, emp: Employee, actor_id: str, note: str | None = None) -> None:
    asset.status, asset.employee_id, asset.assigned_on = "assigned", emp.id, date.today()
    add_history(asset, db, actor_id, f"Issued to {emp.full_name}", note, "assigned")


def it_complete(db: Session, req: AssetRequest, actor_id: str, action: str, note: str, asset_id: str | None,
                condition: str | None) -> None:
    """IT closes a request. action: fulfil (new: issue asset_id) | resolve (repair / lost) | receive (return) | reject."""
    if req.status != "Pending IT":
        raise RuleError("This request is not waiting for IT." if req.status != "Pending manager"
                        else "The manager has not approved this request yet.")
    if req.employee_id == actor_id:
        raise RuleError("Only another IT admin can close your own request.")
    emp = db.get(Employee, req.employee_id)
    assert emp is not None
    note = note.strip()
    asset = db.get(Asset, req.asset_id) if req.asset_id else None
    if condition and condition not in CONDITIONS:
        raise RuleError("Choose the asset's condition.")
    if action == "reject":
        if len(note) < 5:
            raise RuleError("Give a reason for rejecting (at least 5 characters).")
        req.status = "Rejected"
        msg = f"Your {req.item} request was rejected"
    elif action == "fulfil":
        if req.kind != "new":
            raise RuleError("Only new-asset requests are fulfilled.")
        asset = db.get(Asset, asset_id) if asset_id else None
        if asset is None or asset.status != "in_stock":
            raise RuleError("Choose an asset that is in stock.")
        if asset.category != req.category:
            raise RuleError(f"Issue a {req.category.lower()} for this request.")
        _assign(db, asset, emp, actor_id, f"Request {req.id}")
        req.asset_id = asset.id
        req.status = "Fulfilled"
        msg = f"{asset.name} ({asset.tag}) has been issued to you"
    elif action == "resolve":
        if req.kind not in ("repair", "lost") or asset is None:
            raise RuleError("Only repair and lost reports are resolved.")
        if req.kind == "lost":
            asset.status, asset.employee_id, asset.assigned_on = "lost", None, None
            add_history(asset, db, actor_id, "Written off as lost", note, "lost")
        else:
            asset.condition = condition or "Good"
            asset.status = "assigned"
            add_history(asset, db, actor_id, "Repaired", note, "assigned")
        req.status = "Resolved"
        msg = f"Your {req.kind} report for {req.item} is resolved"
    elif action == "receive":
        if req.kind != "return" or asset is None:
            raise RuleError("Only return requests are received.")
        _take_back(db, asset, actor_id, condition or asset.condition, note)
        req.status = "Returned"
        msg = f"IT received {req.item}"
    else:
        raise RuleError("Unknown action.")
    req.decided_by, req.decision_note, req.closed_on = actor_id, note or None, date.today()
    add_history(req, db, actor_id, req.status, note, req.status)
    tell(db, [emp.id], msg, note, ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action=f"asset_request_{action}", entity="asset_request", entity_id=req.id,
                 subject_id=emp.id, before={"status": "Pending IT"}, after={"status": req.status, "asset_id": req.asset_id})


def _take_back(db: Session, asset: Asset, actor_id: str, condition: str, note: str | None) -> None:
    holder = asset.employee_id
    asset.condition = condition
    asset.status = "in_repair" if condition == "Damaged" else "in_stock"
    asset.employee_id, asset.assigned_on = None, None
    add_history(asset, db, actor_id, f"Returned by {name_of(db, holder) or 'holder'}", note, asset.status)


def cancel_request(db: Session, req: AssetRequest, actor_id: str) -> None:
    if req.employee_id != actor_id:
        raise RuleError("Only the requester can cancel this request.")
    if req.status not in OPEN_REQUEST:
        raise RuleError(f"This request is already {req.status.lower()}.")
    waiting = req.manager_id if req.status == "Pending manager" else None
    req.status, req.closed_on = "Cancelled", date.today()
    add_history(req, db, actor_id, "Cancelled", None, "Cancelled")
    if waiting:
        tell(db, [waiting], f"Asset request cancelled · {req.item}", f"{name_of(db, req.employee_id)} cancelled it.", ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action="asset_request_cancelled", entity="asset_request", entity_id=req.id,
                 subject_id=req.employee_id, after={"status": "Cancelled"})


TAG_RE = re.compile(r"^[A-Z0-9][A-Z0-9-]{2,39}$")


def save_asset(db: Session, actor_id: str, data: dict[str, Any], asset: Asset | None = None) -> Asset:
    tag = str(data.get("tag") or "").strip().upper()
    name = str(data.get("name") or "").strip()
    category = data.get("category")
    condition = data.get("condition") or "Good"
    if not TAG_RE.match(tag):
        raise RuleError("Asset tag: 3-40 letters, digits or dashes (e.g. LT-6120).")
    if not name:
        raise RuleError("Enter the asset name (e.g. Dell Latitude 7440).")
    if category not in ASSET_CATEGORIES:
        raise RuleError("Choose an asset type.")
    if condition not in CONDITIONS:
        raise RuleError("Choose the asset's condition.")
    clash = db.scalar(select(Asset.id).where(Asset.tag == tag))
    if clash and (asset is None or clash != asset.id):
        raise RuleError(f"Tag {tag} is already used by another asset.")
    if asset is None:
        asset = Asset(id=new_id("ast"), status="in_stock", history=[])
        db.add(asset)
        add_history(asset, db, actor_id, "Added to inventory", None, "in_stock")
        action = "asset_added"
    else:
        action = "asset_updated"
    before = {"tag": asset.tag, "name": asset.name, "condition": asset.condition}
    asset.tag, asset.name, asset.category, asset.condition = tag, name[:120], category, condition
    asset.serial_no = (str(data.get("serial_no") or "").strip() or None)
    asset.notes = (str(data.get("notes") or "").strip() or None)
    asset.country_code = (str(data.get("country_code") or "").strip().upper() or None)
    record_audit(db, actor_id=actor_id, action=action, entity="asset", entity_id=asset.id, subject_id=asset.employee_id,
                 before=before if action == "asset_updated" else None, after={"tag": tag, "name": name, "condition": condition})
    return asset


def assign_asset(db: Session, asset: Asset, emp: Employee, actor_id: str, note: str) -> None:
    if asset.status != "in_stock":
        raise RuleError(f"{asset.tag} is not in stock.")
    if emp.employment_status in LEFT:
        raise RuleError(f"{emp.full_name} has left the company.")
    _assign(db, asset, emp, actor_id, note)
    tell(db, [emp.id], f"{asset.name} ({asset.tag}) has been issued to you", note, ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action="asset_assigned", entity="asset", entity_id=asset.id, subject_id=emp.id,
                 after={"employee_id": emp.id})


def recover_asset(db: Session, asset: Asset, actor_id: str, condition: str, note: str) -> None:
    """IT takes an asset back directly (exit clearance, swap)."""
    if asset.status not in ("assigned", "in_repair") or not asset.employee_id:
        raise RuleError(f"{asset.tag} is not with anyone.")
    if condition not in CONDITIONS:
        raise RuleError("Choose the asset's condition.")
    holder = asset.employee_id
    _take_back(db, asset, actor_id, condition, note)
    for req in db.scalars(select(AssetRequest).where(AssetRequest.asset_id == asset.id, AssetRequest.status == "Pending IT",
                                                     AssetRequest.kind == "return")):
        req.status, req.closed_on, req.decided_by = "Returned", date.today(), actor_id
        add_history(req, db, actor_id, "Returned", note, "Returned")
    tell(db, [holder], f"IT received {asset.name} ({asset.tag})", note, ASSETS_HREF)
    record_audit(db, actor_id=actor_id, action="asset_recovered", entity="asset", entity_id=asset.id, subject_id=holder,
                 after={"status": asset.status, "condition": condition})


def retire_asset(db: Session, asset: Asset, actor_id: str, note: str) -> None:
    if asset.status in ("assigned",):
        raise RuleError("Take the asset back before retiring it.")
    if len(note.strip()) < 5:
        raise RuleError("Say why the asset is retired (at least 5 characters).")
    asset.status = "retired"
    add_history(asset, db, actor_id, "Retired", note, "retired")
    record_audit(db, actor_id=actor_id, action="asset_retired", entity="asset", entity_id=asset.id, after={"status": "retired"})


# ============================== immigration documents ==============================
DOC_TYPES = ("Passport", "Visa", "Work permit", "Residence ID/Iqama", "Emirates ID", "BRP/UK right-to-work",
             "Aufenthaltstitel", "National ID")
SPONSOR_COUNTRIES = ("United Arab Emirates", "Saudi Arabia")
SPONSORED_TYPES = ("Visa", "Work permit", "Residence ID/Iqama", "Emirates ID")
EXPIRING_DAYS = 90
REMINDER_DAYS = (90, 60, 30, 14, 7)
IMMIGRATION_HREF = "/me/immigration"
NUMBER_RE = re.compile(r"^[A-Z0-9][A-Z0-9/-]{3,23}$")


def needs_sponsor(doc_type: str, country: str) -> bool:
    return doc_type in SPONSORED_TYPES and country in SPONSOR_COUNTRIES


def doc_status(doc: ImmigrationDocument, today: date | None = None) -> str:
    if doc.renewal_in_progress:
        return "Renewal in progress"
    days = (doc.expiry_date - (today or date.today())).days
    if days < 0:
        return "Expired"
    return "Expiring" if days <= EXPIRING_DAYS else "Valid"


def mask(number: str) -> str:
    clean = number.strip()
    return "••••" if len(clean) <= 4 else f"•••• {clean[-4:]}"


def validate_doc(db: Session, data: dict[str, Any], editing_id: str | None = None) -> dict[str, Any]:
    today = date.today()
    doc_type, country = data.get("doc_type"), str(data.get("issuing_country") or "").strip()
    number = str(data.get("number") or "").strip().upper()
    issue, expiry = data.get("issue_date"), data.get("expiry_date")
    sponsor = str(data.get("sponsor") or "").strip()
    if doc_type not in DOC_TYPES:
        raise RuleError("Choose a document type.")
    if not number:
        raise RuleError("Enter the document number.")
    if not NUMBER_RE.match(number):
        raise RuleError("Document number must be 4–24 letters, digits, dashes or slashes.")
    if not country:
        raise RuleError("Choose the issuing country.")
    if doc_type == "Emirates ID":
        if country != "United Arab Emirates":
            raise RuleError("An Emirates ID must be issued by the United Arab Emirates.")
        if not re.match(r"^784-?\d{4}-?\d{7}-?\d$", number):
            raise RuleError("Emirates ID format is 784-YYYY-NNNNNNN-N.")
    if doc_type == "Residence ID/Iqama":
        if country not in SPONSOR_COUNTRIES:
            raise RuleError("A residence ID / Iqama must be issued by the UAE or Saudi Arabia.")
        if country == "Saudi Arabia" and not re.match(r"^2\d{9}$", number):
            raise RuleError("An Iqama number is 10 digits starting with 2.")
    if doc_type == "BRP/UK right-to-work" and country != "United Kingdom":
        raise RuleError("A BRP / right-to-work record must be issued by the United Kingdom.")
    if doc_type == "Aufenthaltstitel" and country != "Germany":
        raise RuleError("An Aufenthaltstitel must be issued by Germany.")
    if not isinstance(issue, date) or not isinstance(expiry, date):
        raise RuleError("Enter valid issue and expiry dates.")
    if issue > today:
        raise RuleError("Issue date cannot be in the future.")
    if expiry <= issue:
        raise RuleError("Expiry date must be after the issue date.")
    if (expiry - issue).days > 366 * 15:
        raise RuleError("Validity cannot exceed 15 years — check the dates.")
    if expiry < today and not data.get("record_expired"):
        raise RuleError("This document has already expired — tick “record expired document” to add it.")
    if needs_sponsor(doc_type, country) and not sponsor:
        raise RuleError("Enter the sponsor for UAE / Saudi permits.")
    dup = db.scalar(select(ImmigrationDocument.id).where(ImmigrationDocument.doc_type == doc_type,
                                                         ImmigrationDocument.number == number,
                                                         ImmigrationDocument.issuing_country == country))
    if dup and dup != editing_id:
        raise RuleError("This document is already on record.")
    return {"doc_type": doc_type, "number": number, "issuing_country": country, "issue_date": issue,
            "expiry_date": expiry, "sponsor": sponsor if needs_sponsor(doc_type, country) else None}


def _doc_audit(doc: ImmigrationDocument) -> dict[str, Any]:
    """Audit-safe: never the full number."""
    return {"type": doc.doc_type, "number": mask(doc.number), "expiry": doc.expiry_date, "verification": doc.verification,
            "renewal": doc.renewal_in_progress}


def save_document(db: Session, actor_id: str, is_hr: bool, emp: Employee, data: dict[str, Any],
                  doc: ImmigrationDocument | None = None) -> ImmigrationDocument:
    clean = validate_doc(db, data, doc.id if doc else None)
    by_hr_for_other = is_hr and emp.id != actor_id
    before = _doc_audit(doc) if doc else None
    if doc is None:
        doc = ImmigrationDocument(id=new_id("idd"), employee_id=emp.id, renewal_in_progress=False, history=[])
        db.add(doc)
        action = "Added"
    else:
        if clean["expiry_date"] > doc.expiry_date:
            doc.renewal_in_progress = False
        action = "Updated"
    for k, v in clean.items():
        setattr(doc, k, v)
    doc.updated_by = actor_id
    doc.verification = "verified" if by_hr_for_other else "pending"
    doc.verification_note = None
    doc.verified_by = actor_id if by_hr_for_other else None
    doc.verified_on = date.today() if by_hr_for_other else None
    add_history(doc, db, actor_id, f"{action}{' and verified by HR' if by_hr_for_other else ' — waiting for HR verification'}",
                None, doc.verification)
    label = f"{doc.doc_type} ({clean['issuing_country']})"
    if by_hr_for_other:
        tell(db, [emp.id], f"HR {action.lower()} your {label}", f"Valid until {short_date(doc.expiry_date)}.", IMMIGRATION_HREF)
    else:
        tell(db, hr_ids(db, emp.country_code), f"Verify {emp.full_name}'s {label}",
             f"{action} by the holder; valid until {short_date(doc.expiry_date)}.", IMMIGRATION_HREF, skip=actor_id)
    record_audit(db, actor_id=actor_id, action=f"immigration_doc_{action.lower()}", entity="immigration_document",
                 entity_id=doc.id, subject_id=emp.id, before=before, after=_doc_audit(doc))
    return doc


def verify_document(db: Session, doc: ImmigrationDocument, actor_id: str, approve: bool, note: str) -> None:
    if doc.employee_id == actor_id:
        raise RuleError("Only another HR person can verify your own document.")
    if doc.verification != "pending":
        raise RuleError("This document is not waiting for verification.")
    if not approve and len(note.strip()) < 5:
        raise RuleError("Add a reason for returning the document (at least 5 characters).")
    doc.verification = "verified" if approve else "rejected"
    doc.verification_note = note.strip() or None
    doc.verified_by, doc.verified_on = actor_id, date.today()
    add_history(doc, db, actor_id, "Verified by HR" if approve else "Returned by HR", note, doc.verification)
    tell(db, [doc.employee_id], f"Your {doc.doc_type} was {'verified' if approve else 'returned for correction'}",
         note.strip() or "No action needed.", IMMIGRATION_HREF)
    record_audit(db, actor_id=actor_id, action="immigration_doc_verified" if approve else "immigration_doc_returned",
                 entity="immigration_document", entity_id=doc.id, subject_id=doc.employee_id, after=_doc_audit(doc))


def set_renewal(db: Session, doc: ImmigrationDocument, actor_id: str, value: bool, note: str) -> None:
    if doc.renewal_in_progress == value:
        raise RuleError("Renewal is already marked." if value else "Renewal is not marked.")
    doc.renewal_in_progress = value
    doc.updated_by = actor_id
    add_history(doc, db, actor_id, "Renewal started" if value else "Renewal flag cleared", note, None)
    emp = db.get(Employee, doc.employee_id)
    if actor_id == doc.employee_id and emp is not None:
        tell(db, hr_ids(db, emp.country_code), f"{emp.full_name} started renewing their {doc.doc_type}",
             note.strip() or f"Expires {short_date(doc.expiry_date)}.", IMMIGRATION_HREF)
    elif value:
        tell(db, [doc.employee_id], f"HR started the renewal of your {doc.doc_type}", note.strip(), IMMIGRATION_HREF)
    record_audit(db, actor_id=actor_id, action="immigration_doc_renewal", entity="immigration_document", entity_id=doc.id,
                 subject_id=doc.employee_id, after={"renewal": value})


def send_expiry_reminders(db: Session, today: date, send: Any) -> int:
    """The holder (and their manager) are told at 90 / 60 / 30 / 14 / 7 days and on the day after expiry."""
    sent = 0
    end = today + timedelta(days=max(REMINDER_DAYS))
    rows = db.execute(select(ImmigrationDocument, Employee).join(Employee, Employee.id == ImmigrationDocument.employee_id)
                      .where(ImmigrationDocument.expiry_date >= today - timedelta(days=1),
                             ImmigrationDocument.expiry_date <= end, Employee.employment_status.not_in(LEFT))).all()
    for doc, emp in rows:
        days = (doc.expiry_date - today).days
        if days not in REMINDER_DAYS and days != -1:
            continue
        title = (f"Your {doc.doc_type} expired yesterday" if days < 0
                 else f"Your {doc.doc_type} expires in {days} days")
        body = "Start the renewal and mark it in the portal so HR can help." if not doc.renewal_in_progress else "Renewal is in progress."
        sent += send(db, f"immigration:{doc.id}:{days}", emp.id, today, "document_expiry", title, body, IMMIGRATION_HREF)
        if days in (30, 7, -1) and emp.manager_id:
            sent += send(db, f"immigration:{doc.id}:{days}:mgr", emp.manager_id, today, "document_expiry",
                         f"{emp.full_name}'s {doc.doc_type} {'expired' if days < 0 else f'expires in {days} days'}",
                         "Their right to work may be affected.", IMMIGRATION_HREF)
    return sent


# ============================== privacy ==============================
CONSENT_TOPICS = ("directory-photo", "birthday-team", "comms-emails", "ai-recommendations", "alumni-network")
PRIVACY_KINDS = ("Access", "Correction", "Deletion")
PRIVACY_CLOSED = ("Completed", "Closed (manual)", "Rejected", "Withdrawn")
PRIVACY_DUE_DAYS = 30
PRIVACY_HREF = "/me/privacy"
LEGAL_BASES = ("Contract", "Legal obligation", "Legitimate interest", "Consent", "Vital interests", "Public task")


def current_consents(db: Session, employee_id: str) -> dict[str, PrivacyConsent]:
    out: dict[str, PrivacyConsent] = {}
    for row in db.scalars(select(PrivacyConsent).where(PrivacyConsent.employee_id == employee_id)
                          .order_by(PrivacyConsent.created_at, PrivacyConsent.id)):
        out[row.topic] = row
    return out


def set_consent(db: Session, emp: Employee, topic: str, granted: bool) -> bool:
    if topic not in CONSENT_TOPICS:
        raise RuleError("Unknown consent topic.")
    current = current_consents(db, emp.id).get(topic)
    if (current.granted if current else False) == granted:
        return False
    db.add(PrivacyConsent(id=new_id("cs"), employee_id=emp.id, topic=topic, granted=granted, created_at=utcnow()))
    if topic == "birthday-team":
        emp.hide_birthday = not granted  # the same choice as the celebrations privacy switch
    record_audit(db, actor_id=emp.id, action="privacy_consent_changed", entity="privacy_consent", entity_id=topic,
                 subject_id=emp.id, before={"granted": current.granted if current else False}, after={"granted": granted})
    return True


def raise_privacy_request(db: Session, emp: Employee, kind: str, details: str) -> PrivacyRequest:
    if kind not in PRIVACY_KINDS:
        raise RuleError("Choose a request type.")
    text = details.strip()
    if kind != "Access" and len(text) < 10:
        raise RuleError(f"Describe what needs {'correcting' if kind == 'Correction' else 'deleting'} (at least 10 characters).")
    if len(text) > 1000:
        raise RuleError("Keep details under 1,000 characters.")
    if db.scalar(select(PrivacyRequest.id).where(PrivacyRequest.employee_id == emp.id, PrivacyRequest.kind == kind,
                                                 PrivacyRequest.status.not_in(PRIVACY_CLOSED))):
        raise RuleError(f"You already have an open {kind.lower()} request.")
    row = PrivacyRequest(id=new_id("dsr"), employee_id=emp.id, kind=kind, details=text,
                         due_on=date.today() + timedelta(days=PRIVACY_DUE_DAYS), status="Open", history=[])
    add_history(row, db, emp.id, "Raised", None, "Open")
    db.add(row)
    tell(db, hr_ids(db, emp.country_code), f"Data {kind.lower()} request from {emp.full_name}",
         f"Answer by {short_date(row.due_on)}.", PRIVACY_HREF, skip=emp.id)
    tell(db, [emp.id], f"Your data {kind.lower()} request was received", f"HR will answer by {short_date(row.due_on)}.", PRIVACY_HREF)
    record_audit(db, actor_id=emp.id, action="privacy_request_raised", entity="privacy_request", entity_id=row.id,
                 subject_id=emp.id, after={"kind": kind, "status": "Open"})
    return row


def withdraw_privacy_request(db: Session, row: PrivacyRequest, actor_id: str) -> None:
    if row.employee_id != actor_id:
        raise RuleError("Only the requester can withdraw a request.")
    if row.status in PRIVACY_CLOSED:
        raise RuleError(f"This request is already {row.status.lower()}.")
    row.status, row.closed_on = "Withdrawn", date.today()
    add_history(row, db, actor_id, "Withdrawn", None, "Withdrawn")
    if row.handled_by:
        tell(db, [row.handled_by], f"Data {row.kind.lower()} request withdrawn", name_of(db, actor_id), PRIVACY_HREF)
    record_audit(db, actor_id=actor_id, action="privacy_request_withdrawn", entity="privacy_request", entity_id=row.id,
                 subject_id=row.employee_id, after={"status": "Withdrawn"})


def move_privacy_request(db: Session, row: PrivacyRequest, actor_id: str, nxt: str, outcome: str) -> None:
    if row.employee_id == actor_id:
        raise RuleError("Only another HR person can handle your own request.")
    if row.status in PRIVACY_CLOSED:
        raise RuleError(f"This request is already {row.status.lower()}.")
    outcome = outcome.strip()
    if nxt == "In progress":
        if row.status != "Open":
            raise RuleError("Only open requests can be started.")
    elif nxt in ("Completed", "Rejected"):
        if row.status != "In progress":
            raise RuleError("Start the request before closing it.")
        if nxt == "Rejected" and len(outcome) < 5:
            raise RuleError("Give a reason for rejecting the request.")
        if nxt == "Completed" and row.kind != "Access" and len(outcome) < 5:
            raise RuleError("Say what was changed, and where.")
    else:
        raise RuleError("Unknown status.")
    before = row.status
    row.status = "Closed (manual)" if nxt == "Completed" and row.kind != "Access" else nxt
    row.handled_by = actor_id
    if nxt != "In progress":
        row.closed_on, row.outcome = date.today(), outcome or None
    add_history(row, db, actor_id, row.status, outcome, row.status)
    text = {"In progress": "HR is working on it.", "Rejected": outcome}.get(nxt, outcome or "Done.")
    if nxt == "Completed" and row.kind == "Access":
        text = "Download your data from the Privacy centre (My data)."
    tell(db, [row.employee_id], f"Your data {row.kind.lower()} request: {row.status}", text, PRIVACY_HREF)
    record_audit(db, actor_id=actor_id, action="privacy_request_moved", entity="privacy_request", entity_id=row.id,
                 subject_id=row.employee_id, before={"status": before}, after={"status": row.status})


def save_retention(db: Session, actor_id: str, data: dict[str, Any], rule: RetentionRule | None = None) -> RetentionRule:
    category = str(data.get("category") or "").strip()
    period, unit, basis = data.get("period"), data.get("unit"), str(data.get("legal_basis") or "").strip()
    if not category:
        raise RuleError("Enter a data category.")
    if not isinstance(period, int) or period <= 0:
        raise RuleError("Retention period must be a whole number greater than 0.")
    if unit not in ("months", "years"):
        raise RuleError("Choose months or years.")
    if period > (100 if unit == "years" else 1200):
        raise RuleError("Retention period is too long — check the value.")
    if basis not in LEGAL_BASES:
        raise RuleError("Choose a legal basis.")
    for other in db.scalars(select(RetentionRule)):
        if other.category.strip().lower() == category.lower() and (rule is None or other.id != rule.id):
            raise RuleError("This data category already has a rule.")
    before = {"category": rule.category, "period": rule.period, "unit": rule.unit} if rule else None
    if rule is None:
        rule = RetentionRule(id=new_id("rt"))
        db.add(rule)
    rule.category, rule.period, rule.unit, rule.legal_basis = category[:160], period, unit, basis
    record_audit(db, actor_id=actor_id, action="retention_rule_saved", entity="retention_rule", entity_id=rule.id,
                 before=before, after={"category": category, "period": period, "unit": unit, "legal_basis": basis})
    return rule
