"""Messages between people (/chat): direct and group conversations, read state, HR-confidential threads.

Members see their conversations. A restricted thread (hr_confidential / compensation) is also open to HR, and only
members or HR can be in it. Each new message notifies the other members (one bell item per thread until read).

Who can start a chat with whom (reporting line + HR): everyone can reach their manager, teammates under the same
manager, the people who report to them (all levels) and HR. HR, super admins and executives can reach anyone.
Managers can also message their whole team at once (POST /chat/team).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, selectinload

from app.deps import CurrentUserDep, DbSession, client_ip
from app.models import Account, ChatConversation, ChatMember, ChatMessage, Notification
from app.services.activity import record_audit
from app.models import Employee
from app.services.scope import HR_ROLES
from app.services.sharing import is_hr, now, person_exists, person_name, tell

router = APIRouter(prefix="/chat", tags=["chat"])

RESTRICTED = {"hr_confidential", "compensation"}


class MessageOut(BaseModel):
    id: str
    from_id: str
    from_name: str
    text: str
    attachment_name: str | None
    at: datetime
    read_by: list[str]


class ConversationOut(BaseModel):
    id: str
    kind: str
    title: str
    restricted: str | None
    participant_ids: list[str]
    participant_names: list[str]
    messages: list[MessageOut]
    is_member: bool
    created_by: str | None = None


class ConversationIn(BaseModel):
    kind: str = Field(pattern="^(direct|group)$")
    title: str = Field(default="", max_length=200)
    member_ids: list[str] = Field(min_length=1, max_length=50)
    restricted: str | None = None


class MembersIn(BaseModel):
    member_ids: list[str] = Field(min_length=1, max_length=50)


class RenameIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class ContactOut(BaseModel):
    id: str
    name: str
    job_title: str | None
    relation: str  # manager | teammate | team | hr


class ContactsOut(BaseModel):
    anyone: bool  # HR, super admin and executives can message anyone in the directory
    contacts: list[ContactOut]


class TeamMessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


ANYONE_ROLES = frozenset({"executive", "founder", "cofounder"})
NOT_ALLOWED = "You can message your manager, teammates, your team and HR."


class MessageIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    attachment_name: str | None = Field(default=None, max_length=200)


def _me(user) -> str:  # type: ignore[no-untyped-def]
    if not user.employee_id:
        raise HTTPException(403, "Messages need an employee profile.")
    return user.employee_id


def _role_of(db: Session, person_id: str) -> str | None:
    return db.scalar(select(Account.role).where(Account.employee_id == person_id).limit(1))


def _contacts(db: Session, user) -> tuple[bool, dict[str, str]]:  # type: ignore[no-untyped-def]
    """(anyone, {person_id: relation}) for the reporting-line + HR rule."""
    if is_hr(user.account.role) or user.account.role in ANYONE_ROLES:
        return True, {}
    me_emp = user.employee
    out: dict[str, str] = {}
    for hr_id in db.scalars(select(Account.employee_id).where(Account.role.in_(HR_ROLES), Account.active.is_(True),
                                                              Account.employee_id.is_not(None))):
        out[hr_id] = "hr"
    if me_emp is not None:
        if me_emp.manager_id:
            for mate in db.scalars(select(Employee.id).where(Employee.manager_id == me_emp.manager_id)):
                out.setdefault(mate, "teammate")
            out[me_emp.manager_id] = "manager"
        for rid in user.scope.reports:
            out[rid] = "team"
        out.pop(me_emp.id, None)
    return False, out


def _check_allowed(db: Session, user, people: list[str]) -> None:  # type: ignore[no-untyped-def]
    anyone, allowed = _contacts(db, user)
    if not anyone and any(p not in allowed for p in people):
        raise HTTPException(403, NOT_ALLOWED)


def _can_view(c: ChatConversation, me: str, role: str) -> bool:
    return any(m.person_id == me for m in c.members) or (c.restricted in RESTRICTED and is_hr(role))


def _out(c: ChatConversation, me: str) -> ConversationOut:
    reads = {m.person_id: m.last_read_at for m in c.members}
    msgs = c.messages[-300:]
    return ConversationOut(
        id=c.id, kind=c.kind, title=c.title, restricted=c.restricted,
        participant_ids=[m.person_id for m in c.members], participant_names=[m.name for m in c.members],
        messages=[MessageOut(id=m.id, from_id=m.from_id, from_name=m.from_name, text=m.text,
                             attachment_name=m.attachment_name, at=m.at,
                             read_by=[m.from_id, *(p for p, t in reads.items() if p != m.from_id and t and t >= m.at)])
                  for m in msgs],
        is_member=me in reads,
        created_by=c.created_by,
    )


def _load(db: Session, cid: str, me: str, role: str) -> ChatConversation:
    c = db.scalar(select(ChatConversation).where(ChatConversation.id == cid)
                  .options(selectinload(ChatConversation.members), selectinload(ChatConversation.messages)))
    if c is None or not _can_view(c, me, role):
        raise HTTPException(404, "Conversation not found.")
    return c


@router.get("/conversations", response_model=list[ConversationOut])
def list_conversations(db: DbSession, user: CurrentUserDep) -> list[ConversationOut]:
    me, role = _me(user), user.account.role
    mine = select(ChatMember.conversation_id).where(ChatMember.person_id == me)
    cond = ChatConversation.id.in_(mine)
    if is_hr(role):
        cond = or_(cond, ChatConversation.restricted.in_(RESTRICTED))
    rows = db.scalars(select(ChatConversation).where(cond).order_by(ChatConversation.updated_at.desc())
                      .options(selectinload(ChatConversation.members), selectinload(ChatConversation.messages))).all()
    return [_out(c, me) for c in rows]


@router.get("/contacts", response_model=ContactsOut)
def contacts(db: DbSession, user: CurrentUserDep) -> ContactsOut:
    """The people this person may start a chat with (empty list + anyone=true for HR, admins and executives)."""
    _me(user)
    anyone, allowed = _contacts(db, user)
    people = {e.id: e for e in db.scalars(select(Employee).where(Employee.id.in_(list(allowed) or [""])))}
    order = {"manager": 0, "team": 1, "teammate": 2, "hr": 3}
    rows = [ContactOut(id=pid, name=people[pid].full_name, job_title=people[pid].job_title, relation=rel)
            for pid, rel in allowed.items() if pid in people]
    return ContactsOut(anyone=anyone, contacts=sorted(rows, key=lambda c: (order.get(c.relation, 9), c.name)))


@router.post("/team", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
def message_team(payload: TeamMessageIn, request: Request, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    """A manager messages their whole team at once: one group chat (created once, kept in step with the team)."""
    me, role = _me(user), user.account.role
    team = list(db.scalars(select(Employee.id).where(Employee.manager_id == me,
                                                     Employee.employment_status.not_in(("Terminated", "Exited")))))
    if not team:
        raise HTTPException(409, "Nobody reports to you, so there is no team to message.")
    my_name = person_name(db, me)
    title = f"{my_name} · team"
    c = db.scalars(select(ChatConversation).where(ChatConversation.kind == "group", ChatConversation.created_by == me,
                                                  ChatConversation.title == title, ChatConversation.restricted.is_(None))
                   .options(selectinload(ChatConversation.members), selectinload(ChatConversation.messages))).first()
    if c is None:
        c = ChatConversation(id=f"cv-{uuid.uuid4().hex[:12]}", kind="group", title=title, restricted=None, created_by=me)
        c.members.append(ChatMember(person_id=me, name=my_name, last_read_at=now()))
        db.add(c)
    current = {m.person_id for m in c.members}
    for pid in team:
        if pid not in current:
            c.members.append(ChatMember(person_id=pid, name=person_name(db, pid)))
    at = now()
    text = payload.text.strip()
    c.messages.append(ChatMessage(id=f"msg-{uuid.uuid4().hex[:12]}", from_id=me, from_name=my_name, text=text, at=at))
    c.updated_at = at
    for m in c.members:
        tell(db, m.person_id, me, f"{my_name} to the team", text[:140], f"/chat?c={c.id}", merge=True)
    record_audit(db, actor_id=user.id, action="chat.team_message", entity="chat_conversation", entity_id=c.id,
                 after={"members": len(c.members)}, ip=client_ip(request))
    db.commit()
    return _out(_load(db, c.id, me, role), me)


@router.post("/conversations", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
def start_conversation(payload: ConversationIn, request: Request, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    me, role = _me(user), user.account.role
    others = [p for p in dict.fromkeys(payload.member_ids) if p and p != me]
    if not others:
        raise HTTPException(422, "Pick at least one colleague.")
    for pid in others:
        if not person_exists(db, pid):
            raise HTTPException(422, "Pick people from the directory.")
    if not payload.restricted:  # a confidential thread with HR is always allowed (it must include HR)
        _check_allowed(db, user, others)
    if payload.kind == "direct" and len(others) != 1:
        raise HTTPException(422, "A direct chat is between two people.")
    restricted = payload.restricted or None
    if restricted and restricted not in RESTRICTED:
        raise HTTPException(422, "Unknown restriction.")
    if restricted and not (is_hr(role) or any(is_hr(_role_of(db, p) or "") for p in others)):
        raise HTTPException(403, "A confidential thread must include HR.")
    if payload.kind == "direct" and not restricted:
        existing = db.scalars(select(ChatConversation).where(
            ChatConversation.kind == "direct", ChatConversation.restricted.is_(None),
            ChatConversation.id.in_(select(ChatMember.conversation_id).where(ChatMember.person_id == me)),
            ChatConversation.id.in_(select(ChatMember.conversation_id).where(ChatMember.person_id == others[0])),
        ).options(selectinload(ChatConversation.members), selectinload(ChatConversation.messages))).first()
        if existing is not None and len(existing.members) == 2:
            return _out(existing, me)
    my_name = person_name(db, me)
    title = payload.title.strip() or (person_name(db, others[0]) if payload.kind == "direct" else "New group")
    c = ChatConversation(id=f"cv-{uuid.uuid4().hex[:12]}", kind=payload.kind, title=title, restricted=restricted,
                         created_by=me)
    c.members.append(ChatMember(person_id=me, name=my_name, last_read_at=now()))
    for pid in others:
        c.members.append(ChatMember(person_id=pid, name=person_name(db, pid)))
    if payload.kind == "group":
        c.messages.append(ChatMessage(id=f"msg-{uuid.uuid4().hex[:12]}", from_id=me, from_name=my_name,
                                      text=f"Created group “{title}”.", at=now()))
        for pid in others:
            tell(db, pid, me, f"Added to {title}", f"{my_name} added you to a group chat.", f"/chat?c={c.id}")
    db.add(c)
    if restricted:
        record_audit(db, actor_id=user.id, action="chat.restricted_thread", entity="chat_conversation", entity_id=c.id,
                     after={"restricted": restricted, "members": [me, *others]}, ip=client_ip(request))
    db.commit()
    return _out(_load(db, c.id, me, role), me)


@router.post("/conversations/{cid}/messages", response_model=ConversationOut, status_code=status.HTTP_201_CREATED)
def send_message(cid: str, payload: MessageIn, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    me, role = _me(user), user.account.role
    c = _load(db, cid, me, role)
    text = payload.text.strip()
    if not text:
        raise HTTPException(422, "Message cannot be empty.")
    my_name = person_name(db, me)
    member = next((m for m in c.members if m.person_id == me), None)
    if member is None:  # HR answering a confidential thread joins it
        member = ChatMember(person_id=me, name=my_name)
        c.members.append(member)
    at = now()
    c.messages.append(ChatMessage(id=f"msg-{uuid.uuid4().hex[:12]}", from_id=me, from_name=my_name, text=text,
                                  attachment_name=payload.attachment_name or None, at=at))
    member.last_read_at = at
    c.updated_at = at
    title = f"Message from {my_name}" if c.kind == "direct" else f"{my_name} in {c.title}"
    body = "Confidential message" if c.restricted else text[:140]
    for m in c.members:
        tell(db, m.person_id, me, title, body, f"/chat?c={c.id}", merge=True)
    db.commit()
    return _out(_load(db, cid, me, role), me)


@router.post("/conversations/{cid}/read", response_model=ConversationOut)
def mark_read(cid: str, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    me, role = _me(user), user.account.role
    c = _load(db, cid, me, role)
    member = next((m for m in c.members if m.person_id == me), None)
    if member is not None:
        member.last_read_at = now()
        for n in db.scalars(select(Notification).where(Notification.recipient_id == me, Notification.read_at.is_(None),
                                                       Notification.href == f"/chat?c={cid}")):
            n.read_at = member.last_read_at
        db.commit()
    return _out(_load(db, cid, me, role), me)


def _group_for_member(db: Session, cid: str, me: str, role: str) -> ChatConversation:
    c = _load(db, cid, me, role)
    if c.kind != "group":
        raise HTTPException(422, "Only group chats have members to change.")
    if not any(m.person_id == me for m in c.members):
        raise HTTPException(403, "Only group members can change the group.")
    return c


def _system_note(c: ChatConversation, me: str, my_name: str, text: str) -> None:
    at = now()
    c.messages.append(ChatMessage(id=f"msg-{uuid.uuid4().hex[:12]}", from_id=me, from_name=my_name, text=text, at=at))
    c.updated_at = at


@router.post("/conversations/{cid}/members", response_model=ConversationOut)
def add_members(cid: str, payload: MembersIn, request: Request, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    """Any member adds people to a group chat."""
    me, role = _me(user), user.account.role
    c = _group_for_member(db, cid, me, role)
    current = {m.person_id for m in c.members}
    new = [p for p in dict.fromkeys(payload.member_ids) if p and p not in current]
    if not new:
        raise HTTPException(422, "Those people are already in the group.")
    if len(current) + len(new) > 100:
        raise HTTPException(422, "A group can have up to 100 people.")
    for pid in new:
        if not person_exists(db, pid):
            raise HTTPException(422, "Pick people from the directory.")
    if not c.restricted:
        _check_allowed(db, user, new)
    if c.restricted and not all(is_hr(_role_of(db, p) or "") for p in new):
        raise HTTPException(403, "Only HR can join a confidential thread.")
    my_name = person_name(db, me)
    names = []
    for pid in new:
        name = person_name(db, pid)
        names.append(name)
        c.members.append(ChatMember(person_id=pid, name=name))
        tell(db, pid, me, f"Added to {c.title}", f"{my_name} added you to a group chat.", f"/chat?c={c.id}")
    _system_note(c, me, my_name, f"Added {', '.join(names)}.")
    record_audit(db, actor_id=user.id, action="chat.members_added", entity="chat_conversation", entity_id=c.id,
                 after={"added": new}, ip=client_ip(request))
    db.commit()
    return _out(_load(db, cid, me, role), me)


@router.delete("/conversations/{cid}/members/{person_id}", response_model=ConversationOut | None)
def remove_member(cid: str, person_id: str, request: Request, db: DbSession, user: CurrentUserDep) -> ConversationOut | None:
    """The group's creator removes people; anyone may leave (remove themselves)."""
    me, role = _me(user), user.account.role
    c = _group_for_member(db, cid, me, role)
    member = next((m for m in c.members if m.person_id == person_id), None)
    if member is None:
        raise HTTPException(404, "That person is not in this group.")
    if person_id != me and c.created_by != me:
        raise HTTPException(403, "Only the person who created the group can remove others.")
    my_name = person_name(db, me)
    c.members.remove(member)
    _system_note(c, me, my_name, f"{my_name} left the group." if person_id == me else f"Removed {member.name}.")
    record_audit(db, actor_id=user.id, action="chat.member_removed", entity="chat_conversation", entity_id=c.id,
                 after={"removed": person_id}, ip=client_ip(request))
    db.commit()
    if person_id == me:
        return None
    return _out(_load(db, cid, me, role), me)


@router.put("/conversations/{cid}", response_model=ConversationOut)
def rename_group(cid: str, payload: RenameIn, db: DbSession, user: CurrentUserDep) -> ConversationOut:
    me, role = _me(user), user.account.role
    c = _group_for_member(db, cid, me, role)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "Give the group a name.")
    if title != c.title:
        my_name = person_name(db, me)
        _system_note(c, me, my_name, f"Renamed the group to “{title}”.")
        c.title = title
        db.commit()
    return _out(_load(db, cid, me, role), me)
