"""Claims history for the demo team (Babu, Priya, Oliver, Ram): expense claims, trips, cash advances and leave
encashments across statuses, so Reimbursements, Travel, Cash advance and Leave encashment show a real history.

Insert-once with fixed ids; dates are relative to the day the seed runs. Kept clear of what the tests rely on:
nobody but Priya and Oliver has an open cash advance (one open advance at a time; Priya's is past Ram), and Babu's encashments are last
year's or rejected (they don't touch his leave balance this year).
"""

from __future__ import annotations

from datetime import date, timedelta

from sqlalchemy.orm import Session

from app.models import CashAdvance, EncashmentRequest, Employee, ExpenseClaim, TravelRequest
from app.services.leave import today_for

BABU, PRIYA, OLIVER, RAM, HR = "emp-mahesh", "emp-priya", "emp-oliver", "emp-ram", "demo-hr-admin"

# id suffix, person, category, amount, days ago, description, status
EXPENSES: list[tuple[str, str, str, float, int, str, str]] = [
    ("babu-taxi", BABU, "Transportation", 1280.0, 41, "Cabs to and from the Acme office during the release week", "paid"),
    ("babu-net", BABU, "Internet", 999.0, 12, "Home broadband, October (on-call)", "approved"),
    ("babu-dinner", BABU, "Food", 2400.0, 26, "Team dinner after the go-live", "rejected"),
    ("priya-books", PRIYA, "Supplies", 650.0, 30, "Testing handbook for the QA library", "paid"),
    ("priya-cab", PRIYA, "Transportation", 380.0, 5, "Cab to the client demo in Kakkanad", "submitted"),
    ("oliver-train", OLIVER, "Travel", 42.5, 35, "Return train to the Reading data centre", "paid"),
    ("oliver-lunch", OLIVER, "Food", 18.9, 15, "Lunch during the Acme test workshop", "approved"),
]

# id suffix, person, purpose, from, to, start (days from today), nights, mode, cost, advance, status
TRIPS: list[tuple[str, str, str, str, str, str, int, int, str, float, float, str]] = [
    ("babu-blr", BABU, "Release planning with the Northwind team", "Kochi", "Bengaluru", -62, 2, "air", 14500.0, 3000.0, "approved"),
    ("babu-chennai", BABU, "Client workshop: year-end build", "Kochi", "Chennai", 26, 1, "rail", 4200.0, 0.0, "approved"),
    ("priya-hyd", PRIYA, "QA tooling conference", "Kochi", "Hyderabad", -48, 2, "air", 11800.0, 0.0, "approved"),
    ("priya-goa", PRIYA, "Team offsite venue visit", "Kochi", "Goa", -20, 1, "road", 6500.0, 0.0, "rejected"),
    ("oliver-mcr", OLIVER, "Acme returns testing on site", "London", "Manchester", 21, 2, "rail", 320.0, 0.0, "approved"),
]


def _add_expenses(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.seed_demo import _start

    added = 0
    for suffix, who, category, amount, ago, text, status in EXPENSES:
        cid, emp = f"exp-pc-{suffix}", people.get(who)
        if emp is None or db.get(ExpenseClaim, cid) is not None:
            continue
        on = today - timedelta(days=ago)
        paid = status == "paid"
        claim = ExpenseClaim(id=cid, employee_id=who, category=category, amount=amount, currency=emp.currency,
                             expense_date=on, description=text, status=status,
                             paid_on=on + timedelta(days=12) if paid else None,
                             payment_reference=f"REIMB-{suffix.upper()}" if paid else None, paid_by=HR if paid else None)
        db.add(claim)
        db.flush()
        if status == "submitted":
            claim.approval_instance_id = _start(db, "expense", claim.id, emp, claim.amount)
        added += 1
    return added


def _add_trips(db: Session, people: dict[str, Employee], today: date) -> int:
    added = 0
    for suffix, who, purpose, src, dst, ahead, nights, mode, cost, advance, status in TRIPS:
        tid, emp = f"trv-pc-{suffix}", people.get(who)
        if emp is None or db.get(TravelRequest, tid) is not None:
            continue
        start = today + timedelta(days=ahead)
        db.add(TravelRequest(id=tid, employee_id=who, purpose=purpose, from_location=src, to_location=dst,
                             start_date=start, end_date=start + timedelta(days=nights), mode=mode, estimated_cost=cost,
                             currency=emp.currency, advance_amount=advance, status=status))
        added += 1
    return added


def _add_cash(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.services import self_service as ss

    added = 0
    rows = [  # id, person, amount, category, purpose, paid (days ago) or None, instalments, status
        ("ca-pc-babu-repaid", BABU, 20000.0, "Home repair", "Roof repair before the monsoon.", 190, 3, "Paid"),
        ("ca-pc-babu-declined", BABU, 35000.0, "Family event", "Sister's engagement.", None, 6, "Rejected"),
        ("ca-pc-oliver-paid", OLIVER, 1200.0, "Relocation", "Deposit for a flat nearer the office.", 40, 4, "Paid"),
        ("ca-pc-ram-repaid", RAM, 40000.0, "Education", "Daughter's college fees.", 240, 2, "Paid"),
        ("ca-pc-priya-waiting", PRIYA, 15000.0, "Medical", "Dental treatment not covered by insurance.", None, 3, "Submitted"),
    ]
    for cid, who, amount, category, purpose, paid_ago, n, status in rows:
        emp = people.get(who)
        if emp is None or db.get(CashAdvance, cid) is not None:
            continue
        paid_on = today - timedelta(days=paid_ago) if paid_ago is not None else None
        row = CashAdvance(id=cid, employee_id=who, amount=amount, currency=emp.currency, category=category, purpose=purpose,
                          needed_by=paid_on or today + timedelta(days=10), instalments=n, status=status,
                          paid_on=paid_on, paid_by=HR if paid_on else None,
                          reference=f"ADV-{cid[6:].upper()}" if paid_on else None)
        if status == "Paid" and paid_ago and paid_ago > 150:
            row.settlement_status, row.settlement_spent, row.settlement_returned = "Verified", amount, 0.0
            row.settlement_on = paid_on + timedelta(days=20)
            row.settlement_note = "Receipts for the full amount."
            row.settlement_verified_by, row.settlement_verified_on = HR, paid_on + timedelta(days=24)
        db.add(row)
        db.flush()
        if status == "Submitted":  # the manager has approved; it waits for Finance / HR
            from app.seed_hr_activity import _past_manager

            _past_manager(db, ss._start(db, ss.CASH, row, emp, row.amount, emp.id), "Fine by me.")
        added += 1
    return added


def _add_encashments(db: Session, people: dict[str, Employee], today: date) -> int:
    from app.services import self_service as ss

    added = 0
    rows = [  # id, person, year, days, status, payout month
        ("enc-pc-babu-last-year", BABU, today.year - 1, 3.0, "Approved", f"{today.year - 1}-12"),
        ("enc-pc-babu-declined", BABU, today.year, 4.0, "Rejected", None),
        ("enc-pc-priya", PRIYA, today.year, 2.0, "Approved", ss.month_key(today.replace(day=1) - timedelta(days=1))),
        ("enc-pc-oliver", OLIVER, today.year, 2.0, "Approved", ss.month_key(today.replace(day=1) - timedelta(days=1))),
        ("enc-pc-ram", RAM, today.year, 3.0, "Approved", ss.month_key(today.replace(day=1) - timedelta(days=40))),
    ]
    for eid, who, year, days, status, month in rows:
        emp = people.get(who)
        if emp is None or db.get(EncashmentRequest, eid) is not None:
            continue
        rate = ss.per_day(db, emp)
        db.add(EncashmentRequest(id=eid, employee_id=who, leave_code="pto", year=year, days=days, per_day=rate,
                                 amount=round(rate * days, 2), currency=emp.currency, status=status, payout_month=month))
        added += 1
    return added


def seed(db: Session) -> dict[str, int]:
    db.flush()
    people = {pid: e for pid in (BABU, PRIYA, OLIVER, RAM) if (e := db.get(Employee, pid)) is not None}
    if BABU not in people:
        return {}
    today = today_for(people[BABU])
    return {
        "pay_claims_expenses_added": _add_expenses(db, people, today),
        "pay_claims_trips_added": _add_trips(db, people, today),
        "pay_claims_cash_advances_added": _add_cash(db, people, today),
        "pay_claims_encashments_added": _add_encashments(db, people, today),
    }
