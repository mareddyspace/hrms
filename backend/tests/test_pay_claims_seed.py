"""Claims history seeded for the demo team (app/seed_pay_claims.py) shows on their own pages and in Ram's queues."""

from tests.conftest import login

API = "/api/v1"


def _statuses(client, headers, path, **params):
    return {r["status"] for r in client.get(f"{API}{path}", headers=headers, params=params).json()}


def test_babu_sees_a_history_in_every_claim_kind(client, babu):
    assert {"paid", "approved", "rejected"} <= _statuses(client, babu, "/expenses")
    assert "approved" in _statuses(client, babu, "/travel")
    assert {"Paid", "Rejected"} <= _statuses(client, babu, "/cash-advances")
    assert {"Approved", "Rejected"} <= _statuses(client, babu, "/encashments")
    # the repaid advance doesn't block a new one; the encashments don't use this year's leave
    assert client.get(f"{API}/cash-advances/policy", headers=babu).json()["open_id"] is None
    repaid = next(r for r in client.get(f"{API}/cash-advances", headers=babu).json() if r["id"] == "ca-pc-babu-repaid")
    assert repaid["outstanding"] == 0 and all(i["recovered"] for i in repaid["schedule"])


def test_teammates_have_claims_and_ram_has_them_to_decide(client, ram):
    priya = login(client, "priya.nair@timez.com")
    oliver = login(client, "oliver.hughes@timez.com")
    assert "Manager approved" in _statuses(client, priya, "/cash-advances")
    assert "Paid" in _statuses(client, oliver, "/cash-advances")
    assert "Approved" in _statuses(client, oliver, "/encashments")
    assert {"paid", "approved"} <= _statuses(client, oliver, "/expenses")
    assert "exp-pc-priya-cab" in {c["id"] for c in client.get(f"{API}/expenses", headers=ram, params={"view": "to_decide"}).json()}
    team = client.get(f"{API}/cash-advances", headers=ram, params={"scope": "team"}).json()
    assert any(r["id"] == "ca-pc-priya-waiting" for r in team)
