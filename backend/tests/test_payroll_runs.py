"""Overtime / comp-off requests and the monthly payroll run (Draft -> Review -> Locked)."""

from __future__ import annotations

import csv
import io
from datetime import date, timedelta

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AccessScope, Account
from tests.conftest import login

API = "/api/v1"


def _past_weekday(days_back: int) -> date:
    day = date.today() - timedelta(days=days_back)
    return day


def _ot(client, headers, day: date, hours: float, outcome: str = "pay", reason: str = "Release night"):
    return client.post(f"{API}/overtime", headers=headers,
                       json={"work_date": day.isoformat(), "hours": hours, "reason": reason, "outcome": outcome})


def test_overtime_rules_and_validation(client, babu):
    pol = client.get(f"{API}/overtime/policy", headers=babu).json()
    assert pol["country_code"] == "IN" and pol["multiplier"] == 1.5 and pol["comp_off"] is True
    assert pol["hourly_rate"] > 0
    future = _ot(client, babu, date.today() + timedelta(days=1), 2)
    assert future.status_code == 422 and "past date" in future.json()["detail"]
    too_old = _ot(client, babu, date.today() - timedelta(days=45), 2)
    assert too_old.status_code == 422
    too_long = _ot(client, babu, date.today() - timedelta(days=5), pol["max_hours"] + 1)
    assert too_long.status_code == 422
    short_comp = _ot(client, babu, date.today() - timedelta(days=5), 2, "comp_off")
    assert short_comp.status_code == 422 and "Comp-off needs" in short_comp.json()["detail"]
    day = client.get(f"{API}/overtime/attendance", headers=babu, params={"work_date": "2020-01-01"}).json()
    assert day["worked_minutes"] is None


def test_overtime_paid_and_comp_off_flow(client, babu, ram):
    pay_day, comp_day = _past_weekday(2), _past_weekday(9)
    res = _ot(client, babu, pay_day, 3)
    assert res.status_code == 201, res.text
    row = res.json()
    assert row["status"] == "Submitted" and row["amount"] == round(3 * row["hourly_rate"] * 1.5)
    assert row["attendance_minutes"] is None  # no attendance on that day: the page warns
    assert _ot(client, babu, pay_day, 1).status_code == 409  # one request per date
    team = client.get(f"{API}/overtime", headers=ram, params={"scope": "team"}).json()
    mine = next(r for r in team if r["id"] == row["id"])
    assert mine["can_decide"] is True
    assert client.post(f"{API}/overtime/{row['id']}/decision", headers=babu, json={"decision": "approve"}).status_code == 403
    done = client.post(f"{API}/overtime/{row['id']}/decision", headers=ram, json={"decision": "approve"})
    assert done.status_code == 200, done.text
    assert done.json()["status"] == "Approved" and done.json()["payout_month"] == pay_day.strftime("%Y-%m")

    before = client.get(f"{API}/leave/balances", headers=babu, params={"year": comp_day.year}).json()["balances"]
    comp_before = next(b for b in before if b["code"] == "comp_off")
    comp = _ot(client, babu, comp_day, 8, "comp_off")
    assert comp.status_code == 201, comp.text
    assert comp.json()["comp_off_days"] == 1.0
    client.post(f"{API}/overtime/{comp.json()['id']}/decision", headers=ram, json={"decision": "approve"})
    after = client.get(f"{API}/leave/balances", headers=babu, params={"year": comp_day.year}).json()["balances"]
    comp_after = next(b for b in after if b["code"] == "comp_off")
    assert comp_after["available"] == comp_before["available"] + 1


def _lines_from(inputs: list[dict]) -> list[dict]:
    """What the browser sends: a simple slip per person built from the server's inputs."""
    out = []
    for p in inputs:
        earnings = [{"name": "Basic", "amount": 50000}]
        if p["overtime_pay"]:
            earnings.append({"name": f"Overtime pay ({p['overtime_hours']:g} h)", "amount": p["overtime_pay"]})
        if p["reimbursements"]:
            earnings.append({"name": "Reimbursements (not taxed)", "amount": p["reimbursements"]})
        if p["encashment"]:
            earnings.append({"name": "Leave encashment payout", "amount": p["encashment"]})
        deductions = [{"name": "TDS", "amount": 4000}, *p["cash_recovery"]]
        out.append({"employee_id": p["employee_id"], "paid_days": p["days_in_month"] - p["lwp_days"],
                    "lwp_days": p["lwp_days"], "earnings": earnings, "deductions": deductions,
                    "employer": [{"name": "Employer PF", "amount": 1800}],
                    "slip": {"id": f"pay-{p['employee_id']}", "month": "x", "earnings": earnings, "deductions": deductions}})
    return out


def test_payroll_run_draft_review_locked(client, babu, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    assert client.get(f"{API}/payroll/runs", headers=babu).status_code == 403
    month = _past_weekday(2).strftime("%Y-%m")
    entity = next(e for e in client.get(f"{API}/payroll/entities", headers=farhan).json() if e["country_code"] == "IN")
    params = {"month": month, "country": "IN", "entity": entity["legal_entity"]}
    assert client.get(f"{API}/payroll/runs/inputs", headers=jordan, params=params).status_code == 403
    inputs = client.get(f"{API}/payroll/runs/inputs", headers=farhan, params=params).json()
    babu_in = next(p for p in inputs if p["employee_id"] == "emp-mahesh")
    assert babu_in["overtime_pay"] > 0 and babu_in["bank_ok"] is True
    assert any(not p["bank_ok"] for p in inputs)  # a few sample people have no bank details

    body = {"month": month, "country_code": "IN", "legal_entity": entity["legal_entity"], "lines": _lines_from(inputs)}
    wrong = {**body, "lines": [dict(l) for l in body["lines"]]}
    babu_line = next(l for l in wrong["lines"] if l["employee_id"] == "emp-mahesh")
    babu_line["earnings"] = [e for e in babu_line["earnings"] if not e["name"].startswith("Overtime pay")]
    bad = client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=wrong)
    assert bad.status_code == 422 and "overtime pay" in bad.json()["detail"]
    short = {**body, "lines": body["lines"][1:]}
    assert client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=short).status_code == 422

    res = client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=body)
    assert res.status_code == 200, res.text
    run = res.json()
    assert run["status"] == "draft" and run["headcount"] == len(inputs) and run["can_submit"]
    assert any(x["kind"] == "missing_bank" for x in run["exceptions"])
    line = next(l for l in run["lines"] if l["employee_id"] == "emp-mahesh")
    assert line["net"] == round(line["gross"] - line["deductions_total"], 2)
    assert run["totals"]["held"] >= 1

    # Babu's later overtime (approved while the run is a draft) makes the run stale until it is prepared again.
    rid = run["id"]
    sub = client.post(f"{API}/payroll/runs/{rid}/submit", headers=farhan)
    assert sub.status_code == 200 and sub.json()["status"] == "review"
    assert sub.json()["can_approve"] is False  # Farhan sent it: a second person approves
    assert client.post(f"{API}/payroll/runs/{rid}/approve", headers=farhan).status_code == 422
    assert client.post(f"{API}/payroll/runs/{rid}/approve", headers=babu).status_code == 403
    assert client.get(f"{API}/payroll/runs/{rid}/bank.csv", headers=farhan).status_code == 409  # not locked yet
    seen = client.get(f"{API}/payroll/runs/{rid}", headers=jordan).json()
    assert seen["can_approve"] is True
    # The CEO (no salary grant) sees totals only: no per-person lines, names of held people or bank file.
    assert seen["lines"] is None and seen["exceptions"] == [] and seen["can_see_lines"] is False
    assert seen["headcount"] == len(inputs) and seen["totals"]["net"] == run["totals"]["net"]
    assert seen["exceptions_count"] == len(run["exceptions"]) and seen["exception_counts"].get("missing_bank", 0) >= 1
    assert sum(d["headcount"] for d in seen["departments"]) == len(inputs)
    assert round(sum(d["net"] for d in seen["departments"]), 2) == round(run["totals"]["net"], 2)
    assert "emp-mahesh" not in str(seen)
    ok = client.post(f"{API}/payroll/runs/{rid}/approve", headers=jordan)
    assert ok.status_code == 200, ok.text
    assert ok.json()["status"] == "locked" and ok.json()["approved_by"] == "Jordan Blake"

    # Locked: nothing changes.
    assert client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=body).status_code == 409
    assert client.post(f"{API}/payroll/runs/{rid}/send-back", headers=jordan, json={"note": "x"}).status_code == 409

    mine = client.get(f"{API}/payroll/my-slips", headers=babu).json()
    assert any(s["month"] == month and s["slip"] for s in mine)
    ot = client.get(f"{API}/overtime", headers=babu).json()
    assert any(r["paid"] for r in ot if r["outcome"] == "pay" and r["status"] == "Approved")

    reg = client.get(f"{API}/payroll/runs/{rid}/register.csv", headers=farhan)
    assert reg.status_code == 200 and reg.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(reg.text)))
    assert rows[0][:2] == ["Employee code", "Name"] and any(r[0] == "EMP1184" for r in rows)
    # The CEO approved it but gets no register or bank file (403); HR in scope does.
    assert client.get(f"{API}/payroll/runs/{rid}/register.csv", headers=jordan).status_code == 403
    assert client.get(f"{API}/payroll/runs/{rid}/bank.csv", headers=jordan).status_code == 403
    assert client.get(f"{API}/payroll/runs/{rid}/export", headers=jordan, params={"kind": "bank"}).status_code == 403
    assert client.get(f"{API}/payroll/runs/{rid}/export", headers=jordan, params={"kind": "register"}).status_code == 403
    assert client.get(f"{API}/payroll/runs/{rid}", headers=jordan).json()["lines"] is None
    bank = client.get(f"{API}/payroll/runs/{rid}/bank.csv", headers=farhan)
    assert bank.status_code == 200
    bank_rows = list(csv.reader(io.StringIO(bank.text)))
    assert len(bank_rows) - 1 == len([p for p in inputs if p["bank_ok"]])
    assert any(r[0] == "EMP1184" and r[-1].startswith("SAL ") for r in bank_rows[1:])

    # New overtime for that month now goes to the next month's pay.
    nxt = _ot(client, babu, _past_weekday(3), 1)
    if nxt.status_code == 201:
        ram = login(client, "ram.krishnan@timez.com")
        out = client.post(f"{API}/overtime/{nxt.json()['id']}/decision", headers=ram, json={"decision": "approve"}).json()
        assert out["payout_month"] > month or _past_weekday(3).strftime("%Y-%m") != month


def test_send_back_needs_note_and_second_person(client, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    month = (date.today().replace(day=1) - timedelta(days=40)).strftime("%Y-%m")
    entity = next(e for e in client.get(f"{API}/payroll/entities", headers=farhan).json() if e["country_code"] == "GB")
    params = {"month": month, "country": "GB", "entity": entity["legal_entity"]}
    inputs = client.get(f"{API}/payroll/runs/inputs", headers=farhan, params=params).json()
    body = {"month": month, "country_code": "GB", "legal_entity": entity["legal_entity"], "lines": _lines_from(inputs)}
    res = client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=body)
    assert res.status_code == 200, res.text
    run = res.json()
    assert client.post(f"{API}/payroll/runs/{run['id']}/submit", headers=farhan).status_code == 200
    assert client.post(f"{API}/payroll/runs/{run['id']}/send-back", headers=farhan, json={"note": "x"}).status_code == 422
    assert client.post(f"{API}/payroll/runs/{run['id']}/send-back", headers=jordan, json={"note": ""}).status_code == 422
    back = client.post(f"{API}/payroll/runs/{run['id']}/send-back", headers=jordan, json={"note": "Check NI"})
    assert back.status_code == 200 and back.json()["status"] == "draft" and back.json()["returned_note"] == "Check NI"


def _gb_run_in_review(client, farhan, months_back: int) -> str:
    month = (date.today().replace(day=1) - timedelta(days=31 * months_back)).strftime("%Y-%m")
    entity = next(e for e in client.get(f"{API}/payroll/entities", headers=farhan).json() if e["country_code"] == "GB")
    params = {"month": month, "country": "GB", "entity": entity["legal_entity"]}
    inputs = client.get(f"{API}/payroll/runs/inputs", headers=farhan, params=params).json()
    body = {"month": month, "country_code": "GB", "legal_entity": entity["legal_entity"], "lines": _lines_from(inputs)}
    res = client.post(f"{API}/payroll/runs/prepare", headers=farhan, json=body)
    assert res.status_code == 200, res.text
    rid = res.json()["id"]
    assert client.post(f"{API}/payroll/runs/{rid}/submit", headers=farhan).status_code == 200
    return rid


def test_admin_has_no_payroll_runs(client, farhan):
    from app.security import create_access_token

    # A direct token: earlier security tests lock Alex's sign-in on purpose.
    alex = {"Authorization": f"Bearer {create_access_token('demo-admin', 'admin')[0]}"}
    rid = _gb_run_in_review(client, farhan, 3)
    month = client.get(f"{API}/payroll/runs/{rid}", headers=farhan).json()["month"]
    entity = client.get(f"{API}/payroll/runs/{rid}", headers=farhan).json()["legal_entity"]
    params = {"month": month, "country": "GB", "entity": entity}
    assert client.get(f"{API}/payroll/runs", headers=alex).status_code == 403
    assert client.get(f"{API}/payroll/entities", headers=alex).status_code == 403
    assert client.get(f"{API}/payroll/runs/inputs", headers=alex, params=params).status_code == 403
    assert client.post(f"{API}/payroll/runs/prepare", headers=alex,
                       json={"month": month, "country_code": "GB", "legal_entity": entity, "lines": []}).status_code == 403
    for path in ("", "/register.csv", "/bank.csv"):
        assert client.get(f"{API}/payroll/runs/{rid}{path}", headers=alex).status_code == 403
    assert client.post(f"{API}/payroll/runs/{rid}/approve", headers=alex).status_code == 403
    assert client.post(f"{API}/payroll/runs/{rid}/send-back", headers=alex, json={"note": "x"}).status_code == 403
    assert client.put(f"{API}/payroll/bank-details/emp-mahesh", headers=alex, json={
        "account_name": "X", "account_number": "12345678", "bank_code": "HDFC0", "bank_name": "HDFC"}).status_code == 403
    # The non-confidential provider / status page stays open to the admin.
    assert client.get(f"{API}/payroll/status", headers=alex).status_code == 200


def test_ceo_totals_only_unless_salary_grant(client, farhan):
    jordan = login(client, "jordan.blake@timez.com")
    rid = _gb_run_in_review(client, farhan, 4)
    seen = client.get(f"{API}/payroll/runs/{rid}", headers=jordan).json()
    assert seen["can_approve"] and not seen["can_see_lines"] and not seen["can_export_bank"]
    assert seen["lines"] is None and seen["exceptions"] == [] and seen["departments"]
    listed = next(r for r in client.get(f"{API}/payroll/runs", headers=jordan).json() if r["id"] == rid)
    assert listed["exceptions"] == [] and listed["totals"]["gross"] == seen["totals"]["gross"]
    assert client.get(f"{API}/payroll/runs/{rid}/register.csv", headers=jordan).status_code == 403

    with SessionLocal() as db:
        acc_id = db.scalar(select(Account.id).where(Account.email == "jordan.blake@timez.com"))
        row = db.get(AccessScope, acc_id) or AccessScope(account_id=acc_id)
        row.comp_access = True
        db.add(row)
        db.commit()
    try:
        granted = client.get(f"{API}/payroll/runs/{rid}", headers=jordan).json()
        assert granted["can_see_lines"] and granted["lines"] and not granted["can_export_bank"]
        assert client.get(f"{API}/payroll/runs/{rid}/register.csv", headers=jordan).status_code == 200
        assert client.get(f"{API}/payroll/runs/{rid}/bank.csv", headers=jordan).status_code == 403
    finally:
        with SessionLocal() as db:
            row = db.get(AccessScope, acc_id)
            row.comp_access = False
            db.commit()
    # He can still send it back with a note (and approve) on totals alone.
    back = client.post(f"{API}/payroll/runs/{rid}/send-back", headers=jordan, json={"note": "Explain the NI jump"})
    assert back.status_code == 200 and back.json()["status"] == "draft" and back.json()["lines"] is None
