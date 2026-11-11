"""Sample mail and chat history so every demo sign-in has an inbox, sent mail and conversations.

Insert-only and idempotent: every row has a fixed id and is skipped when that id already exists; a direct chat is also
skipped when the two people already have one. Nothing is ever updated or deleted, so it is safe on a live database.
Dates are relative to today (the same rows on every run, just dated to look recent). Mail categories are the ones the
mail router accepts, so replying to or forwarding a sample keeps working. Chats follow the messaging rule (reporting
line, teammates, team, HR).
"""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ChatConversation, ChatMember, ChatMessage, Employee, MailMessage, MailRecipient

BABU, PRIYA, OLIVER, RAM = "emp-mahesh", "emp-priya", "emp-oliver", "emp-ram"
FARHAN, SOPHIE, JORDAN, ALEX = "demo-hr-admin", "demo-recruiter", "demo-ceo", "demo-admin"
SIGN_INS = (BABU, PRIYA, OLIVER, RAM, FARHAN, SOPHIE, JORDAN, ALEX)
EVERYONE = SIGN_INS
ENGINEERING = (BABU, PRIYA, OLIVER)


def _at(today: date, days_ago: int, hour: int, minute: int = 0) -> datetime:
    return datetime.combine(today - timedelta(days=days_ago), time(hour, minute), tzinfo=UTC)


# ---------- mail ----------
# (id suffix, thread suffix, from, to, cc, category, subject, days ago, hour (UTC), body)
MAIL: list[tuple[str, str, str, tuple[str, ...], tuple[str, ...], str, str, int, int, str]] = [
    ("laptop", "laptop", ALEX, (BABU,), (), "General", "Your new laptop is ready for pickup", 27, 5,
     "Hi Babu,\n\nYour replacement laptop is imaged and ready. Collect it from the IT desk on the 2nd floor any day "
     "this week between 10:00 and 17:00. Bring the old one so we can wipe it.\n\nThanks,\nAlex"),
    ("laptop-re", "laptop", BABU, (ALEX,), (), "General", "Re: Your new laptop is ready for pickup", 26, 6,
     "Thanks Alex, I'll come by tomorrow morning with the old one.\n\nBabu"),
    ("recognition", "recognition", JORDAN, (FARHAN,), (RAM, ALEX), "General", "Year-end recognition: nominations", 25, 9,
     "Hi Farhan,\n\nLet's open nominations for the year-end awards next week. Ram and Alex, please send two names "
     "each from your teams by the end of the month.\n\nJordan"),
    ("address", "address", BABU, (FARHAN,), (), "General", "Address change for my records", 22, 6,
     "Hi Farhan,\n\nI moved to Indiranagar last month. I've updated the address on my profile; is there anything "
     "else I need to send for the records?\n\nThanks,\nBabu"),
    ("address-re", "address", FARHAN, (BABU,), (), "General", "Re: Address change for my records", 21, 8,
     "Hi Babu,\n\nThe profile update is enough. Please upload a utility bill under Documents so we can verify it "
     "for the bank and insurance records.\n\nRegards,\nFarhan"),
    ("allhands", "allhands", JORDAN, tuple(p for p in EVERYONE if p != JORDAN), (), "General",
     "Q4 all-hands: what we covered", 20, 11,
     "Hi everyone,\n\nThank you for joining the all-hands. A quick recap:\n\n- Revenue is 8% ahead of plan for the "
     "year.\n- We are hiring 40 people next quarter, mostly in Engineering and Sales.\n- The new wellbeing allowance "
     "starts in January.\n\nThe recording is on the intranet. Send me your questions any time.\n\nJordan"),
    ("campus", "campus", FARHAN, (SOPHIE,), (), "General", "Campus drive budget approved", 18, 7,
     "Hi Sophie,\n\nJordan approved the campus drive budget. Please book the three colleges we shortlisted and share "
     "the dates with the interview panel.\n\nFarhan"),
    ("leave-dec", "leave-dec", BABU, (RAM,), (), "Leave", "Leave on 24 to 26 December", 15, 5,
     "Hi Ram,\n\nI'd like to take 24 to 26 December off for a family function. Oliver has agreed to cover my on-call "
     "shift. I'll raise the request in the portal once you're okay with it.\n\nThanks,\nBabu"),
    ("leave-dec-re", "leave-dec", RAM, (BABU,), (), "Leave", "Re: Leave on 24 to 26 December", 14, 4,
     "Hi Babu,\n\nThat works. Go ahead and raise it; I'll approve it today. Please hand over the release checklist "
     "to Priya before you go.\n\nRam"),
    ("laptops-lt", "laptops-lt", JORDAN, (ALEX,), (), "General", "Laptop refresh for the leadership team", 16, 10,
     "Alex,\n\nCan we refresh the leadership team's laptops before the board meeting? Four machines in all.\n\nJordan"),
    ("laptops-lt-re", "laptops-lt", ALEX, (JORDAN,), (), "General", "Re: Laptop refresh for the leadership team", 15, 9,
     "Hi Jordan,\n\nYes. The order is placed and the machines arrive next week. I'll set them up and swap them over "
     "on the Friday.\n\nAlex"),
    ("referral", "referral", OLIVER, (SOPHIE,), (), "General", "Referral: frontend engineer candidate", 13, 10,
     "Hi Sophie,\n\nA former colleague of mine is interested in the Senior React Engineer role. I've added her through "
     "the referral form. Happy to talk about her work if that helps.\n\nOliver"),
    ("referral-re", "referral", SOPHIE, (OLIVER,), (), "General", "Re: Referral: frontend engineer candidate", 12, 9,
     "Thanks Oliver! I've moved her to screening and will keep you posted. The referral bonus is paid after she "
     "completes three months.\n\nSophie"),
    ("payslip-oct", "payslip-oct", FARHAN, tuple(p for p in EVERYONE if p != FARHAN), (), "Pay",
     "October payslips are ready", 12, 6,
     "Hi all,\n\nOctober payslips are now on the Payslips page. Salaries were credited on the last working day. If "
     "anything looks wrong, reply to this mail or raise a Pay query before the 10th.\n\nPayroll team\nPeople Operations"),
    ("calibration", "calibration", FARHAN, (RAM,), (), "General", "Mid-year review calibration for Engineering", 11, 8,
     "Hi Ram,\n\nCan we hold the calibration session for Engineering next Wednesday? Please have the ratings for your "
     "team in the portal by Monday.\n\nFarhan"),
    ("hiring-plan", "hiring-plan", RAM, (JORDAN,), (), "General", "Engineering hiring plan for Q1", 10, 5,
     "Hi Jordan,\n\nAttached is the Q1 hiring plan for Engineering: four backend engineers, two frontend engineers "
     "and a QA lead. Most of the cost lands in February.\n\nRam"),
    ("hiring-plan-re", "hiring-plan", JORDAN, (RAM,), (FARHAN,), "General", "Re: Engineering hiring plan for Q1", 9, 11,
     "Thanks Ram. Approved for the backend and QA roles; let's revisit the frontend roles after the January review. "
     "Farhan, please open the requisitions.\n\nJordan"),
    ("access-review", "access-review", ALEX, (FARHAN,), (), "General", "Access review: HR roles", 9, 7,
     "Hi Farhan,\n\nThe quarterly access review is due. Could you confirm the five people who should keep HR admin "
     "access? I'll remove the rest on Friday.\n\nAlex"),
    ("maintenance", "maintenance", ALEX, tuple(p for p in EVERYONE if p != ALEX), (), "General",
     "Planned maintenance: VPN and sign-in on Saturday", 8, 10,
     "Hi all,\n\nThe VPN and single sign-on will be unavailable on Saturday from 22:00 to 23:30 IST while we renew "
     "certificates. Save your work before then. Nothing else needs doing on your side.\n\nAlex\nIT"),
    ("tax-proofs", "tax-proofs", FARHAN, tuple(p for p in EVERYONE if p != FARHAN), (), "Pay",
     "Submit investment proofs by 15 December", 7, 5,
     "Hi all,\n\nPlease upload your investment proofs under Tax declarations by 15 December. Anything not proved by "
     "then is taxed in the January payroll.\n\nPayroll team\nPeople Operations"),
    ("sprint43", "sprint43", RAM, ENGINEERING, (), "General", "Sprint 43 goals and owners", 6, 4,
     "Hi team,\n\nSprint 43 goals:\n\n- Northwind invoice export fix: Babu\n- Maple onboarding screens: Priya\n- "
     "Flaky test clean-up: Oliver\n\nDemo is on Thursday at 16:00 IST.\n\nRam"),
    ("sprint43-re", "sprint43", PRIYA, (RAM,), (BABU, OLIVER), "General", "Re: Sprint 43 goals and owners", 6, 6,
     "Thanks Ram. I may need a day of Oliver's time for the Maple screens' tests; I'll sync with him tomorrow.\n\nPriya"),
    ("attendance", "attendance", PRIYA, (FARHAN,), (RAM,), "Attendance", "Attendance shows me absent on 4 November", 5, 5,
     "Hi Farhan,\n\nMy attendance shows absent for 4 November, but I was in the office all day. I think the card "
     "reader missed my check-in. I've raised a regularisation request.\n\nPriya"),
    ("attendance-re", "attendance", FARHAN, (PRIYA,), (RAM,), "Attendance", "Re: Attendance shows me absent on 4 November",
     4, 8,
     "Hi Priya,\n\nThe reader at gate 2 was faulty that day. Once Ram approves the regularisation it will show as "
     "present.\n\nFarhan"),
    ("enrolment", "enrolment", FARHAN, tuple(p for p in EVERYONE if p != FARHAN), (), "General",
     "Open enrolment for 2027 health cover closes 30 November", 4, 6,
     "Hi all,\n\nOpen enrolment for next year's health cover is live on the Benefits page. Add or remove dependants "
     "before 30 November; after that changes wait for a life event.\n\nPeople Operations"),
    ("wfh-friday", "wfh-friday", OLIVER, (RAM,), (), "Work from home", "Working from home on Friday", 3, 9,
     "Hi Ram,\n\nCould I work from home this Friday? I have a delivery to receive in the morning. I'll be online for "
     "stand-up as usual.\n\nOliver"),
    ("wfh-friday-re", "wfh-friday", RAM, (OLIVER,), (), "Work from home", "Re: Working from home on Friday", 3, 11,
     "Sure Oliver, that's fine. Please raise it in the portal so it shows on the team calendar.\n\nRam"),
    ("offers", "offers", SOPHIE, (FARHAN,), (), "General", "Offer approvals pending this week", 2, 5,
     "Hi Farhan,\n\nTwo offers are waiting for your approval: the QA lead and the backend engineer for Ram's team. "
     "Both candidates have other offers, so a quick decision would help.\n\nSophie"),
    ("offers-re", "offers", FARHAN, (SOPHIE,), (), "General", "Re: Offer approvals pending this week", 1, 7,
     "Approved both this morning. Please send them out today.\n\nFarhan"),
    ("feedback", "feedback", SOPHIE, (RAM,), (), "General", "Interview feedback: Senior React Engineer", 1, 10,
     "Hi Ram,\n\nPlease add your feedback for yesterday's two interviews to the portal so we can close the panel "
     "this week.\n\nThanks,\nSophie"),
]


def _mail(db: Session, names: dict[str, str], today: date) -> int:
    ids = [f"ml-comms-{m[0]}" for m in MAIL]
    have = set(db.scalars(select(MailMessage.id).where(MailMessage.id.in_(ids))))
    added = 0
    for suffix, thread, sender, to, cc, category, subject, ago, hour, body in MAIL:
        mid = f"ml-comms-{suffix}"
        people = (sender, *to, *cc)
        if mid in have or any(p not in names for p in people):
            continue
        sent = _at(today, ago, hour)
        read_at = sent + timedelta(hours=2) if ago >= 3 else None  # the last few days are still unread
        msg = MailMessage(id=mid, thread_id=f"th-comms-{thread}", from_id=sender, from_name=names[sender],
                          subject=subject, body=body, category=category, sent_at=sent)
        msg.recipients.extend(MailRecipient(person_id=p, kind="to", read_at=read_at) for p in to)
        msg.recipients.extend(MailRecipient(person_id=p, kind="cc", read_at=read_at) for p in cc)
        db.add(msg)
        added += 1
    return added


# ---------- chats ----------
# id suffix, kind, title, members, [(from, text, days ago, hour, minute)]
CHATS: list[tuple[str, str, str, tuple[str, ...], list[tuple[str, str, int, int, int]]]] = [
    ("oliver-ram", "direct", "Ram Krishnan", (OLIVER, RAM), [
        (OLIVER, "Hi Ram, the flaky checkout test is fixed. PR is up for review.", 2, 5, 10),
        (RAM, "Nice work. I'll review it after lunch.", 2, 6, 5),
        (OLIVER, "Thanks! Also, can I take Friday as WFH? Sent you a mail.", 2, 6, 12),
        (RAM, "Yes, approved. Raise it in the portal.", 2, 7, 0)]),
    ("priya-oliver", "direct", "Oliver Hughes", (PRIYA, OLIVER), [
        (PRIYA, "Do you have an hour tomorrow to pair on the Maple screen tests?", 6, 7, 30),
        (OLIVER, "Sure, 11:00 works for me.", 6, 7, 42),
        (PRIYA, "Great, I'll send an invite.", 6, 7, 45)]),
    ("oliver-farhan", "direct", "Farhan Ali", (OLIVER, FARHAN), [
        (OLIVER, "Hi Farhan, where do I add my wife to the health cover?", 4, 8, 15),
        (FARHAN, "Benefits page, then Dependants. Enrolment is open until 30 November.", 4, 9, 0),
        (OLIVER, "Found it, thank you.", 4, 9, 5)]),
    ("jordan-ram", "direct", "Ram Krishnan", (JORDAN, RAM), [
        (JORDAN, "Ram, can you present the Engineering roadmap at Thursday's leadership meeting?", 5, 9, 0),
        (RAM, "Yes. I'll keep it to 15 minutes with the Q1 hiring plan at the end.", 5, 9, 20),
        (JORDAN, "Perfect.", 5, 9, 22)]),
    ("jordan-farhan", "direct", "Farhan Ali", (JORDAN, FARHAN), [
        (FARHAN, "The 2027 headcount plan is in your mail for sign-off.", 1, 6, 0),
        (JORDAN, "Thanks, I'll go through it tonight.", 1, 7, 30)]),
    ("alex-jordan", "direct", "Jordan Blake", (ALEX, JORDAN), [
        (ALEX, "The new leadership laptops arrive Wednesday. Friday swap still okay?", 3, 10, 0),
        (JORDAN, "Friday is fine. Morning please, I have calls after 2.", 3, 10, 45),
        (ALEX, "Will do, 9:30.", 3, 10, 50)]),
    ("alex-farhan", "direct", "Farhan Ali", (ALEX, FARHAN), [
        (ALEX, "Sent you the HR access list to confirm before Friday.", 8, 7, 0),
        (FARHAN, "Got it. Two people can lose access; I'll mark them.", 8, 9, 30)]),
    ("sophie-farhan", "direct", "Farhan Ali", (SOPHIE, FARHAN), [
        (SOPHIE, "Both offers are out. QA lead already accepted!", 1, 9, 0),
        (FARHAN, "Brilliant news. Let's start the onboarding checklist.", 1, 9, 30)]),
    ("leadership", "group", "Leadership team", (JORDAN, RAM, FARHAN, ALEX), [
        (JORDAN, "Weekly sync moves to Thursday 16:00 this week.", 7, 4, 0),
        (FARHAN, "Noted. I'll bring the attrition numbers.", 7, 4, 30),
        (ALEX, "I'll share the access review summary.", 7, 5, 0),
        (RAM, "Engineering roadmap from me.", 7, 5, 15)]),
    ("people-ops", "group", "People Operations", (FARHAN, SOPHIE), [
        (FARHAN, "Campus drive dates are confirmed for the second week of January.", 10, 6, 0),
        (SOPHIE, "I'll line up the interview panels and travel.", 10, 6, 40)]),
]


def _has_direct(db: Session, a: str, b: str) -> bool:
    mine = select(ChatMember.conversation_id).where(ChatMember.person_id == a)
    theirs = select(ChatMember.conversation_id).where(ChatMember.person_id == b)
    return db.scalar(select(ChatConversation.id).where(
        ChatConversation.kind == "direct", ChatConversation.restricted.is_(None),
        ChatConversation.id.in_(mine), ChatConversation.id.in_(theirs)).limit(1)) is not None


def _chats(db: Session, names: dict[str, str], today: date) -> int:
    added = 0
    for suffix, kind, title, members, messages in CHATS:
        cid = f"cv-comms-{suffix}"
        if db.get(ChatConversation, cid) is not None or any(p not in names for p in members):
            continue
        if kind == "direct" and _has_direct(db, *members):
            continue
        stamps = [_at(today, ago, hour, minute) for _, _, ago, hour, minute in messages]
        conv = ChatConversation(id=cid, kind=kind, title=title, restricted=None, created_by=members[0],
                                created_at=stamps[0], updated_at=stamps[-1])
        last_from = messages[-1][0]
        for pid in members:
            # everyone has read the thread except the person the last message is waiting on in a recent chat
            unread = pid != last_from and messages[-1][2] <= 1
            conv.members.append(ChatMember(person_id=pid, name=names[pid], last_read_at=None if unread else stamps[-1]))
        for i, ((sender, text, *_), at) in enumerate(zip(messages, stamps, strict=True), start=1):
            conv.messages.append(ChatMessage(id=f"msg-comms-{suffix}-{i}", from_id=sender, from_name=names[sender],
                                             text=text, at=at))
        db.add(conv)
        db.flush()  # the next direct-chat check sees this one
        added += 1
    return added


def seed(db: Session) -> dict[str, Any]:
    """Adds the sample mail and chats that are missing. Returns how many of each were added."""
    db.flush()
    names = {e.id: e.full_name for e in db.scalars(select(Employee).where(Employee.id.in_(SIGN_INS)))}
    if not names:
        return {"comms_mail_added": 0, "comms_chats_added": 0}
    today = date.today()
    stats = {"comms_mail_added": _mail(db, names, today), "comms_chats_added": _chats(db, names, today)}
    db.flush()
    return stats
