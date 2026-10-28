from collections import Counter

from app.seed_hcm import load_employees


def test_workbook_is_consistent():
    people, counts = load_employees()
    assert counts["employees"] == 500 == len({p["id"] for p in people})
    ids = {p["id"] for p in people}
    assert all(p["manager_id"] in ids for p in people if p["manager_id"])
    assert Counter(p["country_code"] for p in people) == {"IN": 200, "US": 100, "GB": 60, "AU": 40, "CA": 35, "AE": 25, "SA": 20, "DE": 20}
