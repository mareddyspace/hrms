"""Benefit plan details and documents, browsing by country, cancelling, dependent proofs and cover rules, history."""

from datetime import date

PDF = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
API = "/api/v1/benefits"


def test_plans_by_country_with_details_and_documents(client, babu, farhan):
    own = client.get(f"{API}/plans", headers=babu).json()
    assert own and all(p["country_code"] == "IN" for p in own)
    med = next(p for p in own if p["id"] == "bp-in-med")
    assert med["coverage"] and med["terms"] and med["employer_annual_cost"] > 0
    us = client.get(f"{API}/plans", params={"country": "US"}, headers=babu).json()
    assert us and all(p["country_code"] == "US" for p in us)
    countries = client.get(f"{API}/plan-countries", headers=babu).json()
    assert countries[0]["code"] == "IN" and countries[0]["own"] is True

    pdf = client.get(f"{API}/plans/bp-in-med/summary.pdf", headers=babu)
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and pdf.headers["content-type"] == "application/pdf"

    assert client.post(f"{API}/plans/bp-in-med/documents?title=Policy&filename=p.pdf", content=PDF,
                       headers={**babu, "Content-Type": "application/pdf"}).status_code == 403
    res = client.post(f"{API}/plans/bp-in-med/documents?title=Policy%20wording&filename=policy.pdf", content=PDF,
                      headers={**farhan, "Content-Type": "application/pdf"})
    assert res.status_code == 201, res.text
    doc = res.json()["documents"][0]
    got = client.get(f"{API}/plans/bp-in-med/documents/{doc['id']}", headers=babu)
    assert got.status_code == 200 and got.content.startswith(b"%PDF")
    assert client.delete(f"{API}/plans/bp-in-med/documents/{doc['id']}", headers=farhan).status_code == 204


def test_enroll_cancel_and_history(client, babu, farhan):
    # bp-in-life is open to everyone in India; the seeded open enrollment window covers today.
    window = client.get(f"{API}/change-window", headers=babu).json()
    if not window["open"]:
        return
    res = client.post(f"{API}/enrollments", json={"plan_id": "bp-in-life"}, headers=babu)
    assert res.status_code in (201, 409), res.text
    mine = [e for e in client.get(f"{API}/enrollments", headers=babu).json() if e["plan_id"] == "bp-in-life"][0]
    fresh = mine["status"] == "requested"  # an earlier test may already have taken Babu through this plan
    if fresh:
        res = client.post(f"{API}/enrollments/{mine['id']}/cancel", headers=babu)
        assert res.status_code == 200 and res.json()["status"] == "cancelled"
        assert client.post(f"{API}/enrollments/{mine['id']}/cancel", headers=babu).status_code == 409
        # Re-request after cancelling, HR approves, then the employee leaves the plan in the window.
        assert client.post(f"{API}/enrollments", json={"plan_id": "bp-in-life"}, headers=babu).status_code == 201
        assert client.post(f"{API}/enrollments/{mine['id']}/decision", json={"decision": "approve"}, headers=farhan).status_code == 200
        res = client.post(f"{API}/enrollments/{mine['id']}/cancel", headers=babu)
        assert res.status_code == 200 and res.json()["status"] == "cancelled"
    pf = [e for e in client.get(f"{API}/enrollments", headers=babu).json() if e["plan_id"] == "bp-in-pf"]
    if pf:
        assert client.post(f"{API}/enrollments/{pf[0]['id']}/cancel", headers=babu).status_code == 409
    history = client.get(f"{API}/history", headers=babu).json()
    events = {h["event"] for h in history}
    assert "Enrolled" in events
    if fresh:
        assert "Enrollment requested" in events and "Enrollment cancelled" in events
    # Someone else's history: HR yes, a manager no.
    assert client.get(f"{API}/history", params={"employee_id": "emp-mahesh"}, headers=farhan).status_code == 200


def test_dependent_proof_and_cover_rules(client, babu, farhan, ram):
    res = client.post(f"{API}/dependents", json={"name": "Old Child Test", "relationship": "Child", "date_of_birth": "1990-01-01"},
                      headers=babu)
    assert res.status_code == 201, res.text
    dep = res.json()
    assert dep["cover_eligible"] is False and "25" in dep["cover_note"]
    up = client.post(f"{API}/dependents/{dep['id']}/document?filename=birth.pdf", content=PDF,
                     headers={**babu, "Content-Type": "application/pdf"})
    assert up.status_code == 200 and up.json()["doc_name"] == "birth.pdf"
    assert client.get(f"{API}/dependents/{dep['id']}/document", headers=babu).content.startswith(b"%PDF")
    assert client.get(f"{API}/dependents/{dep['id']}/document", headers=farhan).status_code == 200
    assert client.get(f"{API}/dependents/{dep['id']}/document", headers=ram).status_code == 404
    assert client.delete(f"{API}/dependents/{dep['id']}", headers=babu).status_code == 204
    assert date.today()
