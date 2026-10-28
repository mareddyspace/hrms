"""Expense claims, receipts and travel requests."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas import ORM

EXPENSE_CATEGORIES = ("Travel", "Food", "Lodging", "Supplies", "Other")
ExpenseCategory = Literal["Travel", "Food", "Lodging", "Supplies", "Other"]
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
