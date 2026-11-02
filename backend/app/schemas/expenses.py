"""Expense claims, receipts and travel requests."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import ORM

# Offered on the claim form; "Lodging" is still accepted for claims filed before Accommodation replaced it.
EXPENSE_CATEGORIES = ("Travel", "Food", "Accommodation", "Transportation", "Internet", "Medical", "Supplies", "Other")
ExpenseCategory = Literal["Travel", "Food", "Accommodation", "Transportation", "Internet", "Medical", "Supplies", "Other",
                          "Lodging"]
Details = Field(default=None, max_length=12)  # category-specific fields, e.g. {"merchant": "...", "nights": "2"}
TravelMode = Literal["air", "rail", "road", "sea", "other"]
Currency = Field(default=None, pattern=r"^[A-Z]{3}$")


class ExpenseRulesOut(BaseModel):
    country_code: str
    currency: str
    max_claim: float
    receipt_required_over: float
    max_cash_advance: float
    claim_window_days: int
    finance_threshold: float
    categories: list[str]
    max_receipt_bytes: int
    receipt_types: list[str]


class ReceiptOut(ORM):
    id: str
    claim_id: str | None
    file_name: str
    content_type: str
    size_bytes: int
    sha256: str
    created_at: datetime


class ExpenseClaimIn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    category: ExpenseCategory
    amount: float = Field(gt=0, le=100_000_000)
    currency: str | None = Currency  # None = the claimant's own currency (the only one accepted)
    expense_date: date = Field(alias="date")
    description: str = Field(min_length=1, max_length=2000)
    trip_id: str | None = Field(default=None, max_length=64)
    receipt_ids: list[str] = Field(default_factory=list, max_length=10)
    details: dict[str, str] | None = Details


class ExpenseClaimEditIn(BaseModel):
    """Changes to your own claim while nobody has decided it yet (or after a request for more information)."""

    model_config = ConfigDict(populate_by_name=True)

    category: ExpenseCategory | None = None
    amount: float | None = Field(default=None, gt=0, le=100_000_000)
    expense_date: date | None = Field(default=None, alias="date")
    description: str | None = Field(default=None, min_length=1, max_length=2000)
    trip_id: str | None = Field(default=None, max_length=64)
    clear_trip: bool = False
    details: dict[str, str] | None = Details


class ExpensePayIn(BaseModel):
    paid_on: date
    payment_reference: str = Field(min_length=1, max_length=100)


class ExpenseClaimOut(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True, serialize_by_alias=True)

    id: str
    employee_id: str
    employee_name: str | None = None
    category: str
    amount: float
    currency: str
    expense_date: date = Field(serialization_alias="date")
    description: str
    trip_id: str | None
    status: str
    approval_instance_id: str | None
    approval_status: str | None = None
    current_step: int | None = None
    paid_on: date | None
    payment_reference: str | None
    paid_by: str | None
    created_at: datetime
    receipts: list[ReceiptOut] = []
    details: dict[str, str] | None = None
    info_requested: bool = False
    can_edit: bool = False


class TravelRequestIn(BaseModel):
    purpose: str = Field(min_length=1, max_length=2000)
    from_location: str = Field(min_length=1, max_length=200)
    to_location: str = Field(min_length=1, max_length=200)
    start_date: date
    end_date: date
    mode: TravelMode
    estimated_cost: float = Field(gt=0, le=100_000_000)
    currency: str | None = Currency
    advance_amount: float = Field(default=0, ge=0, le=100_000_000)
    details: dict[str, str] | None = Field(default=None, max_length=20)  # mode fields, accommodation, advance reason


class TravelBookingIn(BaseModel):
    """Tickets / hotel once booked (the traveller, HR or a travel admin)."""

    booking: dict[str, str] = Field(max_length=12)


class TravelRequestOut(ORM):
    id: str
    employee_id: str
    employee_name: str | None = None
    purpose: str
    from_location: str
    to_location: str
    start_date: date
    end_date: date
    mode: str
    estimated_cost: float
    currency: str
    advance_amount: float
    status: str
    approval_instance_id: str | None
    approval_status: str | None = None
    current_step: int | None = None
    created_at: datetime
    details: dict[str, str] | None = None
    booking: dict[str, str] | None = None
    info_requested: bool = False
