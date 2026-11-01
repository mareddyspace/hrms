"""tax declarations with proofs and deadlines; benefit plan details and policy documents; dependent proof files

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-30 21:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0026'
down_revision: Union[str, Sequence[str], None] = '0025'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts() -> list[sa.Column]:
    return [sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'tax_declaration_windows',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('financial_year', sa.String(length=32), nullable=False),
        sa.Column('opens_on', sa.Date(), nullable=False),
        sa.Column('deadline', sa.Date(), nullable=False),
        sa.Column('proof_deadline', sa.Date(), nullable=True),
        sa.Column('locked', sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        *_ts(),
        sa.UniqueConstraint('country_code', 'financial_year', name='uq_tax_decl_window'),
    )
    op.create_index('ix_tax_declaration_windows_country_code', 'tax_declaration_windows', ['country_code'])
    op.create_table(
        'tax_declarations',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('financial_year', sa.String(length=32), nullable=False),
        sa.Column('regime', sa.String(length=8), nullable=True),
        sa.Column('section', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('amount', sa.Numeric(14, 2), nullable=False),
        sa.Column('verified_amount', sa.Numeric(14, 2), nullable=True),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        sa.Column('employee_note', sa.Text(), nullable=True),
        sa.Column('submitted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decided_by', sa.String(length=64), nullable=True),
        sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('decision_note', sa.Text(), nullable=True),
        sa.Column('history', sa.JSON(), nullable=True),
        *_ts(),
    )
    op.create_index('ix_tax_declarations_employee_id', 'tax_declarations', ['employee_id'])
    op.create_index('ix_tax_declarations_country_code', 'tax_declarations', ['country_code'])
    op.create_index('ix_tax_declarations_financial_year', 'tax_declarations', ['financial_year'])
    op.create_index('ix_tax_declarations_status', 'tax_declarations', ['status'])
    op.create_table(
        'tax_declaration_documents',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('declaration_id', sa.String(length=64), sa.ForeignKey('tax_declarations.id', ondelete='CASCADE'), nullable=False),
        sa.Column('file_name', sa.String(length=200), nullable=False),
        sa.Column('content_type', sa.String(length=100), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('storage_path', sa.String(length=300), nullable=False),
        sa.Column('uploaded_by', sa.String(length=64), nullable=True),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index('ix_tax_declaration_documents_declaration_id', 'tax_declaration_documents', ['declaration_id'])

    op.add_column('benefit_plans', sa.Column('coverage', sa.Text(), nullable=True))
    op.add_column('benefit_plans', sa.Column('terms', sa.Text(), nullable=True))
    op.add_column('benefit_plans', sa.Column('legal_entity', sa.String(length=200), nullable=True))
    op.create_table(
        'benefit_plan_documents',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('plan_id', sa.String(length=64), sa.ForeignKey('benefit_plans.id', ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('file_name', sa.String(length=200), nullable=False),
        sa.Column('content_type', sa.String(length=100), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('storage_path', sa.String(length=300), nullable=False),
        sa.Column('uploaded_by', sa.String(length=64), nullable=True),
        sa.Column('uploaded_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_benefit_plan_documents_plan_id', 'benefit_plan_documents', ['plan_id'])
    op.add_column('benefit_dependents', sa.Column('doc_name', sa.String(length=200), nullable=True))
    op.add_column('benefit_dependents', sa.Column('doc_type', sa.String(length=100), nullable=True))
    op.add_column('benefit_dependents', sa.Column('doc_size', sa.Integer(), nullable=True))
    op.add_column('benefit_dependents', sa.Column('doc_path', sa.String(length=300), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('benefit_dependents') as b:
        b.drop_column('doc_path')
        b.drop_column('doc_size')
        b.drop_column('doc_type')
        b.drop_column('doc_name')
    op.drop_index('ix_benefit_plan_documents_plan_id', table_name='benefit_plan_documents')
    op.drop_table('benefit_plan_documents')
    with op.batch_alter_table('benefit_plans') as b:
        b.drop_column('legal_entity')
        b.drop_column('terms')
        b.drop_column('coverage')
    op.drop_index('ix_tax_declaration_documents_declaration_id', table_name='tax_declaration_documents')
    op.drop_table('tax_declaration_documents')
    for ix in ('status', 'financial_year', 'country_code', 'employee_id'):
        op.drop_index(f'ix_tax_declarations_{ix}', table_name='tax_declarations')
    op.drop_table('tax_declarations')
    op.drop_index('ix_tax_declaration_windows_country_code', table_name='tax_declaration_windows')
    op.drop_table('tax_declaration_windows')
