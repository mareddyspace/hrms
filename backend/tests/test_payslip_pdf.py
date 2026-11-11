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


def test_profile_payslips_tab_permissions(client, babu, ram, farhan):
    """GET /payroll/people/{id}/slips: the person themself, HR / payroll in scope; managers and others get 404."""
    me_id = client.get("/api/v1/auth/me", headers=babu).json()
    babu_id = (me_id.get("employee") or {}).get("id") or me_id.get("employee_id") or "emp-mahesh"
    own = client.get(f"/api/v1/payroll/people/{babu_id}/slips", headers=babu)
    assert own.status_code == 200
    assert own.json() == client.get("/api/v1/payroll/my-slips", headers=babu).json()
    # The line manager does not see pay; nor does an unknown id leak existence.
    assert client.get(f"/api/v1/payroll/people/{babu_id}/slips", headers=ram).status_code == 404
    assert client.get(f"/api/v1/payroll/people/{babu_id}/slips/any/pdf", headers=ram).status_code == 404
    assert client.get("/api/v1/payroll/people/emp-nobody/slips", headers=farhan).status_code == 404
    hr = client.get(f"/api/v1/payroll/people/{babu_id}/slips", headers=farhan)
    assert hr.status_code == 200 and hr.json() == own.json()
    for slip in hr.json():
        pdf = client.get(f"/api/v1/payroll/people/{babu_id}/slips/{slip['run_id']}/pdf", headers=farhan)
        assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF")
        break
    assert client.get(f"/api/v1/payroll/people/{babu_id}/slips/nope/pdf", headers=farhan).status_code == 404
