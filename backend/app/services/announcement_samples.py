"""Company announcements a real employee would receive (holidays per country, policy updates, office events, IT
maintenance, wellness, new joiners, a CEO message). Insert-once by id; posts people changed are left alone.
Also fills in a category for the earlier sample posts (app/services/sharing.py) that were saved without one."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.models import Announcement, AnnouncementRead, Employee

BABU, RAM, FARHAN, SOPHIE, JORDAN, ALEX = (
    "emp-mahesh", "emp-ram", "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin")


def _ts(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc)


def _a(aid: str, title: str, category: str, scope: str, audience: str, at: str, author: str | None, author_name: str,
       body: str, *, ack: bool = False, pinned: bool = False) -> dict[str, Any]:
    return dict(id=aid, title=title, category=category, scope=scope, audience=audience, published_at=at,
                author_id=author, author_name=author_name, body=body, must_acknowledge=ack, pinned=pinned)


SAMPLES: list[dict[str, Any]] = [
    _a("an-ceo-q3", "A note from Jordan: Q3 results and the road to 2027", "Leadership", "Company", "All TimeZ",
       "2026-10-29T08:00:00Z", JORDAN, "Jordan Blake",
       "Team,\n\nQ3 closed at 112% of plan, led by the Northwind and Maple programmes. Thank you for the long weeks "
       "around the October releases.\n\nFor Q4 our focus is simple: ship the clinic portal on time, keep client "
       "escalations under 48 hours and finish the hiring plan for Bengaluru and Austin.\n\nI'll take questions at the "
       "all-hands on 12 November.\n\nJordan", pinned=True),
    _a("an-it-maint-nov8", "Planned maintenance: VPN and email, Sat 8 Nov", "IT", "Company", "All TimeZ",
       "2026-10-28T11:00:00Z", ALEX, "Alex Morgan",
       "VPN, email and the portal will be unavailable on Saturday 8 November from 22:00 to 02:00 UTC while we upgrade "
       "the network gateways.\n\nSave your work and sign out before the window. On-call engineers can use the "
       "backup VPN profile (IT portal > Downloads)."),
    _a("an-it-mfa", "Two-step sign-in required from 15 November", "IT", "Company", "All TimeZ",
       "2026-10-27T09:30:00Z", ALEX, "Alex Morgan",
       "From 15 November every account needs two-step sign-in (an authenticator app). Set it up under My profile > "
       "Security. Accounts without it are locked after the deadline.", ack=True),
    _a("an-policy-travel", "Travel and expense policy updated", "Policy", "Company", "All TimeZ",
       "2026-10-22T06:00:00Z", FARHAN, "Farhan Ali",
       "Changes from 1 November:\n- Book flights at least 14 days ahead unless your manager approves.\n- Hotel caps "
       "updated per city.\n- Submit receipts within 30 days.\n\nRead the full policy under Policies and acknowledge "
       "below.", ack=True),
    _a("an-joiners-oct", "Welcome to our October joiners", "People", "Company", "All TimeZ",
       "2026-10-20T07:00:00Z", FARHAN, "Farhan Ali",
       "Please welcome 14 new colleagues who joined in October across Engineering, Sales and Customer Success, "
       "including Diya Patel (Engineering, Bengaluru) and Marcus Lee (Sales, Austin). Say hello on Messages."),
    _a("an-wellness-nov", "Wellbeing week: free counselling and fitness sessions", "Wellness", "Company", "All TimeZ",
       "2026-10-24T05:00:00Z", FARHAN, "Farhan Ali",
       "From 10 to 14 November: confidential counselling slots, desk-yoga at lunch and a step challenge. Book "
       "counselling through the Employee Assistance Programme; it is free and private."),
    # India
    _a("an-in-diwali", "Diwali: India offices closed Monday 9 November", "Holiday", "Country", "IN",
       "2026-10-26T04:00:00Z", FARHAN, "Farhan Ali",
       "Bengaluru, Hyderabad and Pune offices are closed on Monday 9 November for Diwali. Support rotas stay as "
       "planned; on-call staff earn a comp-off day.", pinned=True),
    _a("an-in-diwali-party", "Diwali celebration at the Bengaluru office", "Event", "Country", "IN",
       "2026-10-25T09:00:00Z", FARHAN, "Farhan Ali",
       "Join us on Thursday 6 November from 16:00 on the 5th floor terrace: rangoli contest, sweets and a team "
       "photo. Families welcome."),
    _a("an-in-hybrid", "Hybrid work: three office days from 1 December", "Policy", "Country", "IN",
       "2026-10-23T10:00:00Z", FARHAN, "Farhan Ali",
       "From 1 December India teams work from the office Tuesday to Thursday. Agree any exception with your manager "
       "and record it as Work from home in Leave.", ack=True),
    # United States
    _a("an-us-thanksgiving", "Thanksgiving: US offices closed 26-27 November", "Holiday", "Country", "US",
       "2026-10-27T15:00:00Z", FARHAN, "Farhan Ali",
       "Austin and New York offices are closed on Thursday 26 and Friday 27 November. Client support follows the "
       "holiday rota."),
    _a("an-us-enrolment", "Benefits open enrolment closes 15 November", "People", "Country", "US",
       "2026-10-21T14:00:00Z", FARHAN, "Farhan Ali",
       "Review your medical, dental and 401(k) choices for 2027 under Benefits. If you do nothing, this year's plans "
       "roll over."),
    # United Kingdom
    _a("an-gb-closure", "UK office closure over Christmas", "Holiday", "Country", "GB",
       "2026-10-28T09:00:00Z", FARHAN, "Farhan Ali",
       "The London office closes from 24 December and reopens on 4 January. Three of the closure days come from your "
       "leave balance; Leave shows them already booked."),
    # Germany
    _a("an-de-closure", "Betriebsruhe: Berlin office closed 24 Dec - 1 Jan", "Holiday", "Country", "DE",
       "2026-10-28T09:30:00Z", FARHAN, "Farhan Ali",
       "The Berlin office is closed from 24 December to 1 January. Two days are company holidays; please book the "
       "rest as annual leave by 30 November."),
    # UAE / Saudi Arabia
    _a("an-ae-national-day", "UAE National Day: Dubai office closed 2-3 December", "Holiday", "Country", "AE",
       "2026-10-29T06:00:00Z", FARHAN, "Farhan Ali",
       "The Dubai office is closed on 2 and 3 December for UAE National Day (Eid Al Etihad)."),
    _a("an-sa-winter-hours", "Riyadh office: winter working hours", "Policy", "Country", "SA",
       "2026-10-26T06:00:00Z", FARHAN, "Farhan Ali",
       "From 1 November the Riyadh office opens 08:00-17:00 Sunday to Thursday."),
    # Australia / Canada
    _a("an-au-melbourne-cup", "Melbourne Cup Day: Melbourne office closed 3 November", "Holiday", "Country", "AU",
       "2026-10-27T22:00:00Z", FARHAN, "Farhan Ali",
       "Melbourne office is closed on Tuesday 3 November. Sydney stays open."),
    _a("an-ca-remembrance", "Remembrance Day, 11 November", "Holiday", "Country", "CA",
       "2026-10-28T13:00:00Z", FARHAN, "Farhan Ali",
       "Toronto office observes Remembrance Day on 11 November with two minutes of silence at 11:00. The office stays "
       "open; take the day if your province gives it."),
    # Departments
    _a("an-eng-hackday", "Engineering hack day, Friday 14 November", "Event", "Department", "Engineering",
       "2026-10-27T05:30:00Z", RAM, "Ram Krishnan",
       "No sprint work on 14 November. Pitch an idea in #hackday by 7 November; teams of up to four. Demos at 16:00, "
       "prizes for best client impact."),
    _a("an-eng-release-freeze", "Release freeze 18 Dec - 5 Jan", "Policy", "Department", "Engineering",
       "2026-10-29T10:00:00Z", RAM, "Ram Krishnan",
       "Only P1 fixes go to production during the freeze. Plan Maple and Northwind releases for the week of 8 December."),
    _a("an-ta-referrals", "Referral bonus doubled for engineering roles", "People", "Department", "Talent Acquisition",
       "2026-10-24T16:00:00Z", SOPHIE, "Sophie Clark",
       "Until 31 December referral bonuses for engineering hires are doubled. Share open roles from Careers."),
    _a("an-people-payroll-cutoff", "November payroll cut-off: 20 November", "People", "Department", "People",
       "2026-10-29T07:00:00Z", FARHAN, "Farhan Ali",
       "Changes after 20 November move to the December run. Approve pending overtime and expense claims before then."),
    _a("an-it-laptop-refresh", "Laptop refresh for 2022 devices", "IT", "Department", "IT",
       "2026-10-23T12:00:00Z", ALEX, "Alex Morgan",
       "Laptops bought in 2022 are replaced from 17 November. Book a slot with the IT desk; back up local files first."),
    _a("an-exec-board", "Board pack due 20 November", "Leadership", "Department", "Executive",
       "2026-10-28T17:00:00Z", JORDAN, "Jordan Blake",
       "Function heads: send your Q4 board slides to the CEO office by 20 November."),
]

# Category for the posts app/services/sharing.py seeded before categories existed.
_EARLIER = {"an-1": "Event", "an-2": "Holiday", "an-3": "Policy", "an-5": "Policy"}
# A few posts some demo people have already read, so the list shows read and unread items.
_READ = {BABU: ["an-1", "an-3", "an-joiners-oct"], RAM: ["an-1", "an-eng-hackday"], FARHAN: ["an-1"]}


def seed(db: Session) -> int:
    added = 0
    if db.get(Employee, FARHAN) is None:
        return 0
    for s in SAMPLES:
        if db.get(Announcement, s["id"]) is not None:
            continue
        db.add(Announcement(id=s["id"], title=s["title"], body=s["body"], scope=s["scope"], audience=s["audience"],
                            state="Published", published_at=_ts(s["published_at"]), author_id=s["author_id"],
                            author_name=s["author_name"], must_acknowledge=s["must_acknowledge"],
                            category=s["category"], pinned=s["pinned"]))
        added += 1
    for aid, category in _EARLIER.items():
        a = db.get(Announcement, aid)
        if a is not None and not a.category:
            a.category = category
    db.flush()
    # Only on the run that adds the posts: after that, read state is each person's own.
    for person, ids in (_READ.items() if added else []):
        if db.get(Employee, person) is None:
            continue
        for aid in ids:
            a = db.get(Announcement, aid)
            if a is not None and not any(r.person_id == person for r in a.reads):
                a.reads.append(AnnouncementRead(person_id=person, read_at=a.published_at or _ts("2026-10-29T00:00:00Z")))
    db.flush()
    return added
