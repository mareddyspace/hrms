"""Official payslip PDF from a locked run: only my own, audit without amounts; amounts never in payroll audit entries."""

from sqlalchemy import select

from app.db import SessionLocal
from app.models import AuditLog, PayrollRun, PayrollRunLine


def test_my_locked_slip_pdf_is_mine_only(client, babu, ram):
    with SessionLocal() as db:
        row = db.execute(select(PayrollRunLine.run_id).join(PayrollRun, PayrollRun.id == PayrollRunLine.run_id)
                         .where(PayrollRunLine.employee_id == "emp-mahesh", PayrollRun.status == "locked")).first()
    slips = client.get("/api/v1/payroll/my-slips", headers=babu).json()
    if row is None:
        assert slips == [] or all(s["run_id"] for s in slips)
        assert client.get("/api/v1/payroll/my-slips/nope/pdf", headers=babu).status_code == 404
        return
    run_id = row[0]
    res = client.get(f"/api/v1/payroll/my-slips/{run_id}/pdf", headers=babu)
    assert res.status_code == 200 and res.content.startswith(b"%PDF") and "attachment" in res.headers["content-disposition"]
    # Someone else on the same run gets their own slip or nothing, never Babu's.
    other = client.get(f"/api/v1/payroll/my-slips/{run_id}/pdf", headers=ram)
    assert other.status_code in (200, 404)
    if other.status_code == 200:
        assert other.content != res.content
    with SessionLocal() as db:
        entry = db.scalars(select(AuditLog).where(AuditLog.action == "payslip_downloaded", AuditLog.subject_id == "emp-mahesh")).first()
        assert entry is not None and set(entry.changes["after"]) == {"month"}


def test_payroll_audit_has_no_amounts(client):
    with SessionLocal() as db:
        for row in db.scalars(select(AuditLog).where(AuditLog.entity.in_(["payroll_runs", "compensation_record", "comp_bonus"]))):
            after = (row.changes or {}).get("after") or {}
            assert not {"net", "gross", "base_salary", "amount"} & set(after), row.action
