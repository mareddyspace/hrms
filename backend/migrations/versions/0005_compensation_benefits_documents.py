"""compensation benefits documents

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-28 18:00:00

Compensation (grade bands, pay history, bonuses, review cycles, proposals), benefits (plans, windows, life events,
enrollments, dependents and cover, nominees), documents & letters (versioned documents, letter templates / requests /
issues, policy acknowledgments) and access_scopes.comp_access.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('benefit_windows',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('country_code', sa.String(length=2), nullable=True),
    sa.Column('start_date', sa.Date(), nullable=False),
    sa.Column('end_date', sa.Date(), nullable=False),
    sa.Column('override', sa.String(length=8), nullable=True),
    sa.Column('updated_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('benefit_windows', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_windows_country_code'), ['country_code'], unique=False)

    op.create_table('comp_review_cycles',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('effective_date', sa.Date(), nullable=False),
    sa.Column('budget_pct', sa.Numeric(precision=5, scale=2, asdecimal=False), nullable=False),
    sa.Column('opens_on', sa.Date(), nullable=False),
    sa.Column('closes_on', sa.Date(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('countries', sa.JSON(), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )

    with op.batch_alter_table('comp_review_cycles', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_comp_review_cycles_status'), ['status'], unique=False)

    op.create_table('letter_templates',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('letter_type', sa.String(length=32), nullable=False),
    sa.Column('country_code', sa.String(length=2), nullable=True),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('to_whom', sa.Boolean(), nullable=False),
    sa.Column('paragraphs', sa.JSON(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('updated_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('letter_type', 'country_code', name='uq_letter_template_type_country')
    )

    with op.batch_alter_table('letter_templates', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_letter_templates_letter_type'), ['letter_type'], unique=False)

    op.create_table('benefit_plans',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('country_code', sa.String(length=2), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('plan_type', sa.String(length=32), nullable=False),
    sa.Column('provider', sa.String(length=200), nullable=False),
    sa.Column('summary', sa.Text(), nullable=False),
    sa.Column('employee_cost', sa.String(length=100), nullable=False),
    sa.Column('employer_annual_cost', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('covers_dependents', sa.Boolean(), nullable=False),
    sa.Column('mandatory', sa.Boolean(), nullable=False),
    sa.Column('auto_enrolled', sa.Boolean(), nullable=False),
    sa.Column('eligibility', sa.JSON(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['country_code'], ['countries.code'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('benefit_plans', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_plans_country_code'), ['country_code'], unique=False)

    op.create_table('grade_bands',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('grade', sa.String(length=16), nullable=False),
    sa.Column('country_code', sa.String(length=2), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('min_amount', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('mid_amount', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('max_amount', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('updated_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['country_code'], ['countries.code'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('grade', 'country_code', name='uq_grade_band_grade_country')
    )

    with op.batch_alter_table('grade_bands', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_grade_bands_country_code'), ['country_code'], unique=False)

    op.create_table('benefit_beneficiaries',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('nomination_for', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('relationship', sa.String(length=32), nullable=False),
    sa.Column('share_pct', sa.Numeric(precision=5, scale=2, asdecimal=False), nullable=False),
    sa.Column('date_of_birth', sa.Date(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('benefit_beneficiaries', schema=None) as batch_op:
        batch_op.create_index('ix_beneficiary_employee_for', ['employee_id', 'nomination_for'], unique=False)

    op.create_table('benefit_dependents',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('relationship', sa.String(length=32), nullable=False),
    sa.Column('date_of_birth', sa.Date(), nullable=False),
    sa.Column('gender', sa.String(length=32), nullable=True),
    sa.Column('verification', sa.String(length=16), nullable=False),
    sa.Column('verified_by', sa.String(length=64), nullable=True),
    sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('benefit_dependents', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_dependents_employee_id'), ['employee_id'], unique=False)

    op.create_table('benefit_enrollments',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('plan_id', sa.String(length=64), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('effective_date', sa.Date(), nullable=True),
    sa.Column('life_event_id', sa.String(length=64), nullable=True),
    sa.Column('decided_by', sa.String(length=64), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('note', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['plan_id'], ['benefit_plans.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('employee_id', 'plan_id', name='uq_benefit_enrollment_employee_plan')
    )

    with op.batch_alter_table('benefit_enrollments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_enrollments_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_benefit_enrollments_plan_id'), ['plan_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_benefit_enrollments_status'), ['status'], unique=False)

    op.create_table('benefit_life_events',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('event_type', sa.String(length=64), nullable=False),
    sa.Column('event_date', sa.Date(), nullable=False),
    sa.Column('window_ends', sa.Date(), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('closed_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('employee_id', 'event_type', 'event_date', name='uq_life_event')
    )

    with op.batch_alter_table('benefit_life_events', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_life_events_employee_id'), ['employee_id'], unique=False)

    op.create_table('comp_bonuses',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('bonus_type', sa.String(length=100), nullable=False),
    sa.Column('period', sa.String(length=32), nullable=False),
    sa.Column('amount', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('proposal_id', sa.String(length=64), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('decided_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('comp_bonuses', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_comp_bonuses_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_comp_bonuses_status'), ['status'], unique=False)

    op.create_table('comp_proposals',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('cycle_id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('proposed_by', sa.String(length=64), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('current_base', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('current_grade', sa.String(length=16), nullable=False),
    sa.Column('increase_pct', sa.Numeric(precision=6, scale=2, asdecimal=False), nullable=False),
    sa.Column('proposed_base', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('proposed_grade', sa.String(length=16), nullable=False),
    sa.Column('bonus_amount', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=True),
    sa.Column('justification', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
    sa.Column('record_id', sa.String(length=64), nullable=True),
    sa.Column('decided_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('extra', sa.JSON(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['cycle_id'], ['comp_review_cycles.id'], ),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['proposed_by'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('comp_proposals', schema=None) as batch_op:
        batch_op.create_index('ix_comp_proposal_cycle_employee', ['cycle_id', 'employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_comp_proposals_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_comp_proposals_proposed_by'), ['proposed_by'], unique=False)
        batch_op.create_index(batch_op.f('ix_comp_proposals_status'), ['status'], unique=False)

    op.create_table('compensation_records',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('effective_date', sa.Date(), nullable=False),
    sa.Column('base_salary', sa.Numeric(precision=14, scale=2, asdecimal=False), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('grade', sa.String(length=16), nullable=False),
    sa.Column('reason', sa.String(length=200), nullable=False),
    sa.Column('proposal_id', sa.String(length=64), nullable=True),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('employee_id', 'effective_date', name='uq_comp_record_employee_date')
    )

    with op.batch_alter_table('compensation_records', schema=None) as batch_op:
        batch_op.create_index('ix_comp_record_employee_date', ['employee_id', 'effective_date'], unique=False)

    op.create_table('employee_documents',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('category', sa.String(length=32), nullable=False),
    sa.Column('title', sa.String(length=200), nullable=False),
    sa.Column('current_version', sa.Integer(), nullable=False),
    sa.Column('expiry_date', sa.Date(), nullable=True),
    sa.Column('letter_request_id', sa.String(length=64), nullable=True),
    sa.Column('uploaded_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('employee_documents', schema=None) as batch_op:
        batch_op.create_index('ix_employee_document_expiry', ['expiry_date'], unique=False)
        batch_op.create_index(batch_op.f('ix_employee_documents_category'), ['category'], unique=False)
        batch_op.create_index(batch_op.f('ix_employee_documents_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_employee_documents_letter_request_id'), ['letter_request_id'], unique=False)

    op.create_table('letter_requests',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('letter_type', sa.String(length=32), nullable=False),
    sa.Column('status', sa.String(length=16), nullable=False),
    sa.Column('requested_by', sa.String(length=64), nullable=False),
    sa.Column('note', sa.Text(), nullable=False),
    sa.Column('details', sa.String(length=200), nullable=True),
    sa.Column('effective_date', sa.Date(), nullable=True),
    sa.Column('approval_instance_id', sa.String(length=64), nullable=True),
    sa.Column('document_id', sa.String(length=64), nullable=True),
    sa.Column('issue_error', sa.Text(), nullable=True),
    sa.Column('issued_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.ForeignKeyConstraint(['requested_by'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id')
    )

    with op.batch_alter_table('letter_requests', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_letter_requests_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_letter_requests_requested_by'), ['requested_by'], unique=False)
        batch_op.create_index(batch_op.f('ix_letter_requests_status'), ['status'], unique=False)

    op.create_table('policy_acknowledgments',
    sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
    sa.Column('employee_id', sa.String(length=64), nullable=False),
    sa.Column('policy_id', sa.String(length=64), nullable=False),
    sa.Column('policy_version', sa.String(length=32), nullable=False),
    sa.Column('acknowledged_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.ForeignKeyConstraint(['employee_id'], ['employees.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('employee_id', 'policy_id', 'policy_version', name='uq_policy_ack')
    )

    with op.batch_alter_table('policy_acknowledgments', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_policy_acknowledgments_employee_id'), ['employee_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_policy_acknowledgments_policy_id'), ['policy_id'], unique=False)

    op.create_table('benefit_dependent_coverage',
    sa.Column('enrollment_id', sa.String(length=64), nullable=False),
    sa.Column('dependent_id', sa.String(length=64), nullable=False),
    sa.ForeignKeyConstraint(['dependent_id'], ['benefit_dependents.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['enrollment_id'], ['benefit_enrollments.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('enrollment_id', 'dependent_id')
    )

    with op.batch_alter_table('benefit_dependent_coverage', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_benefit_dependent_coverage_dependent_id'), ['dependent_id'], unique=False)

    op.create_table('document_versions',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('document_id', sa.String(length=64), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('file_name', sa.String(length=255), nullable=False),
    sa.Column('content_type', sa.String(length=100), nullable=False),
    sa.Column('size_bytes', sa.Integer(), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('storage_path', sa.String(length=500), nullable=False),
    sa.Column('uploaded_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['document_id'], ['employee_documents.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('document_id', 'version', name='uq_document_version')
    )

    with op.batch_alter_table('document_versions', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_document_versions_document_id'), ['document_id'], unique=False)

    op.create_table('letter_issues',
    sa.Column('id', sa.String(length=64), nullable=False),
    sa.Column('request_id', sa.String(length=64), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('reference_no', sa.String(length=64), nullable=False),
    sa.Column('document_version_id', sa.String(length=64), nullable=False),
    sa.Column('approved_by', sa.String(length=64), nullable=True),
    sa.Column('generated_by', sa.String(length=64), nullable=True),
    sa.Column('fields', sa.JSON(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['request_id'], ['letter_requests.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('reference_no'),
    sa.UniqueConstraint('request_id', 'version', name='uq_letter_issue_version')
    )

    with op.batch_alter_table('letter_issues', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_letter_issues_request_id'), ['request_id'], unique=False)

    with op.batch_alter_table('access_scopes', schema=None) as batch_op:
        batch_op.add_column(sa.Column('comp_access', sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade() -> None:
    with op.batch_alter_table('access_scopes', schema=None) as batch_op:
        batch_op.drop_column('comp_access')

    with op.batch_alter_table('letter_issues', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_letter_issues_request_id'))

    op.drop_table('letter_issues')

    with op.batch_alter_table('document_versions', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_document_versions_document_id'))

    op.drop_table('document_versions')

    with op.batch_alter_table('benefit_dependent_coverage', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_dependent_coverage_dependent_id'))

    op.drop_table('benefit_dependent_coverage')

    with op.batch_alter_table('policy_acknowledgments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_policy_acknowledgments_policy_id'))
        batch_op.drop_index(batch_op.f('ix_policy_acknowledgments_employee_id'))

    op.drop_table('policy_acknowledgments')

    with op.batch_alter_table('letter_requests', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_letter_requests_status'))
        batch_op.drop_index(batch_op.f('ix_letter_requests_requested_by'))
        batch_op.drop_index(batch_op.f('ix_letter_requests_employee_id'))

    op.drop_table('letter_requests')

    with op.batch_alter_table('employee_documents', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_employee_documents_letter_request_id'))
        batch_op.drop_index(batch_op.f('ix_employee_documents_employee_id'))
        batch_op.drop_index(batch_op.f('ix_employee_documents_category'))
        batch_op.drop_index('ix_employee_document_expiry')

    op.drop_table('employee_documents')

    with op.batch_alter_table('compensation_records', schema=None) as batch_op:
        batch_op.drop_index('ix_comp_record_employee_date')

    op.drop_table('compensation_records')

    with op.batch_alter_table('comp_proposals', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_comp_proposals_status'))
        batch_op.drop_index(batch_op.f('ix_comp_proposals_proposed_by'))
        batch_op.drop_index(batch_op.f('ix_comp_proposals_employee_id'))
        batch_op.drop_index('ix_comp_proposal_cycle_employee')

    op.drop_table('comp_proposals')

    with op.batch_alter_table('comp_bonuses', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_comp_bonuses_status'))
        batch_op.drop_index(batch_op.f('ix_comp_bonuses_employee_id'))

    op.drop_table('comp_bonuses')

    with op.batch_alter_table('benefit_life_events', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_life_events_employee_id'))

    op.drop_table('benefit_life_events')

    with op.batch_alter_table('benefit_enrollments', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_enrollments_status'))
        batch_op.drop_index(batch_op.f('ix_benefit_enrollments_plan_id'))
        batch_op.drop_index(batch_op.f('ix_benefit_enrollments_employee_id'))

    op.drop_table('benefit_enrollments')

    with op.batch_alter_table('benefit_dependents', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_dependents_employee_id'))

    op.drop_table('benefit_dependents')

    with op.batch_alter_table('benefit_beneficiaries', schema=None) as batch_op:
        batch_op.drop_index('ix_beneficiary_employee_for')

    op.drop_table('benefit_beneficiaries')

    with op.batch_alter_table('grade_bands', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_grade_bands_country_code'))

    op.drop_table('grade_bands')

    with op.batch_alter_table('benefit_plans', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_plans_country_code'))

    op.drop_table('benefit_plans')

    with op.batch_alter_table('letter_templates', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_letter_templates_letter_type'))

    op.drop_table('letter_templates')

    with op.batch_alter_table('comp_review_cycles', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_comp_review_cycles_status'))

    op.drop_table('comp_review_cycles')

    with op.batch_alter_table('benefit_windows', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_benefit_windows_country_code'))

    op.drop_table('benefit_windows')
