PAY_WORDS = ("salary", "pay", "ctc", "bank", "compensation")
FULL_ONLY = ("date_of_birth", "gender", "mobile", "personal_email", "employment_type", "grade")


def _no_pay(item: dict) -> None:
    # payroll_status is an integration label ("Future Integration"), not pay data
    assert not any(word in key.lower() for key in item if key != "payroll_status" for word in PAY_WORDS)


def test_babu_sees_directory_with_basic_fields(client, babu):
    body = client.get("/api/v1/people", headers=babu, params={"page_size": 200}).json()
    assert body["total"] == 507  # 500 workbook + 6 sign-ins + the seeded joiner (app/seed_demo.py)
    others = [p for p in body["items"] if p["id"] != "emp-mahesh"]
    assert others and all(p["view"] == "basic" for p in others)
    for p in others:
        assert not any(k in p for k in FULL_ONLY)
        _no_pay(p)


def test_babu_full_record_only_for_himself(client, babu):
    me = client.get("/api/v1/people/emp-mahesh", headers=babu).json()
    assert me["view"] == "full" and me["date_of_birth"] and me["manager_id"] == "emp-ram"
    _no_pay(me)
    ram = client.get("/api/v1/people/emp-ram", headers=babu).json()
    assert ram["view"] == "basic" and "date_of_birth" not in ram
    mine = client.get("/api/v1/people", headers=babu, params={"scope": "mine"}).json()
    assert [p["id"] for p in mine["items"]] == ["emp-mahesh"]


def test_babu_cannot_read_rams_team(client, babu):
    team = client.get("/api/v1/people/emp-ram/reports", headers=babu).json()
    assert team and all(p["view"] == "basic" for p in team if p["id"] != "emp-mahesh")
    assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "TZ0001"}).status_code == 404
    assert client.get("/api/v1/leave/balances", headers=babu, params={"employee_id": "emp-ram"}).status_code == 404
    assert client.get("/api/v1/leave/requests", headers=babu, params={"view": "team"}).json() == []
    everything = client.get("/api/v1/leave/requests", headers=babu, params={"view": "all"}).json()
    assert {r["employee_id"] for r in everything} == {"emp-mahesh"}


def test_ram_sees_babu_in_full(client, ram):
    babu = client.get("/api/v1/people/emp-mahesh", headers=ram).json()
    assert babu["view"] == "full" and babu["date_of_birth"]
    reports = client.get("/api/v1/people/emp-ram/reports", headers=ram).json()
    assert "emp-mahesh" in {p["id"] for p in reports} and all(p["view"] == "full" for p in reports)
    mine = client.get("/api/v1/people", headers=ram, params={"scope": "mine", "page_size": 200}).json()
    ids = {p["id"] for p in mine["items"]}
    assert "emp-mahesh" in ids and "demo-ceo" not in ids
    assert client.get("/api/v1/people/demo-ceo", headers=ram).json()["view"] == "basic"
    assert client.get("/api/v1/leave/balances", headers=ram, params={"employee_id": "emp-mahesh"}).status_code == 200
    team = client.get("/api/v1/leave/requests", headers=ram, params={"view": "team"}).json()
    assert {r["employee_id"] for r in team} == {"emp-mahesh"}


def test_farhan_sees_everyone_in_full(client, farhan):
    res = client.get("/api/v1/people", headers=farhan, params={"page_size": 200, "scope": "mine"}).json()
    assert res["total"] == 507
    assert all(p["view"] == "full" for p in res["items"])
    assert client.get("/api/v1/people/demo-ceo", headers=farhan).json()["view"] == "full"
    assert client.get("/api/v1/auth/me", headers=farhan).json()["scope"] == "global"


def test_filters_and_search(client, farhan):
    res = client.get("/api/v1/people", headers=farhan, params={"country": "in", "department": "Engineering"}).json()
    assert res["total"] > 0
    assert all(p["country_code"] == "IN" and p["department"] == "Engineering" for p in res["items"])
    res = client.get("/api/v1/people", headers=farhan, params={"q": "babu"}).json()
    assert "emp-mahesh" in {p["id"] for p in res["items"]}


def test_unknown_person_404(client, babu):
    assert client.get("/api/v1/people/does-not-exist", headers=babu).status_code == 404


def test_farhan_sees_sophies_pending_leave(client, farhan):
    team = client.get("/api/v1/leave/requests", headers=farhan, params={"view": "team", "status": "pending"}).json()
    assert "lv-sophie-pto" in {r["id"] for r in team}


def test_workbook_people_loaded(client, farhan):
    tz = client.get("/api/v1/people/TZ0001", headers=farhan).json()
    assert tz["full_name"] == "Vikram Sharma" and tz["email"].endswith("@timez.example")
    assert tz["holiday_calendar"] == "India Standard" and tz["leave_policy_name"] == "India Leave Policy"
    assert tz["manager_id"] == "TZ0006"
    ram = client.get("/api/v1/people/emp-ram", headers=farhan).json()
    assert ram["manager_id"] == "demo-ceo" and ram["holiday_calendar"] == "India Standard"
