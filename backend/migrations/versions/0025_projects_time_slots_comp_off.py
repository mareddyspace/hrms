"""project details (milestones, tasks, updates, documents, activity); timesheet entry start/break/work;
shift break and location; roster comp-off credits

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-30 20:00:00
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0025'
down_revision: Union[str, Sequence[str], None] = '0024'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _ts() -> list[sa.Column]:
    return [sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade() -> None:
    op.add_column('projects', sa.Column('description', sa.Text(), nullable=True))
    op.add_column('projects', sa.Column('start_date', sa.Date(), nullable=True))
    op.add_column('projects', sa.Column('end_date', sa.Date(), nullable=True))
    op.add_column('projects', sa.Column('budget_hours', sa.Numeric(8, 2), nullable=True))
    op.add_column('projects', sa.Column('manager_id', sa.String(length=64), nullable=True))  # employees.id
    op.add_column('project_members', sa.Column('title', sa.String(length=100), nullable=True))
    op.add_column('project_members', sa.Column('responsibilities', sa.Text(), nullable=True))
    op.add_column('project_members', sa.Column('budget_hours', sa.Numeric(8, 2), nullable=True))

    op.add_column('timesheet_entries', sa.Column('start_minute', sa.Integer(), nullable=True))
    op.add_column('timesheet_entries', sa.Column('break_minutes', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('timesheet_entries', sa.Column('work_type', sa.String(length=16), nullable=True))
    op.add_column('timesheet_entries', sa.Column('work_id', sa.String(length=64), nullable=True))
    op.add_column('timesheet_entries', sa.Column('work_label', sa.String(length=200), nullable=True))

    op.add_column('shift_types', sa.Column('break_minutes', sa.Integer(), nullable=False, server_default='60'))
    op.add_column('shift_types', sa.Column('location', sa.String(length=100), nullable=True))

    op.create_table(
        'project_milestones',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=64), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('due_date', sa.Date(), nullable=False),
        sa.Column('completed_on', sa.Date(), nullable=True),
        *_ts(),
    )
    op.create_index('ix_project_milestone_project_due', 'project_milestones', ['project_id', 'due_date'])
    op.create_table(
        'project_tasks',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=64), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('code', sa.String(length=32), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('assignee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=True),
        sa.Column('milestone_id', sa.String(length=64), nullable=True),
        sa.Column('due_date', sa.Date(), nullable=True),
        sa.Column('estimate_hours', sa.Numeric(7, 2), nullable=False),
        sa.Column('status', sa.String(length=16), nullable=False),
        *_ts(),
    )
    op.create_index('ix_project_task_project', 'project_tasks', ['project_id'])
    op.create_index('ix_project_tasks_assignee_id', 'project_tasks', ['assignee_id'])
    op.create_table(
        'project_posts',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=64), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('author_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('body', sa.Text(), nullable=False),
        *_ts(),
    )
    op.create_index('ix_project_post_project', 'project_posts', ['project_id', 'created_at'])
    op.create_table(
        'project_documents',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=64), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('url', sa.String(length=500), nullable=True),
        sa.Column('file_name', sa.String(length=200), nullable=True),
        sa.Column('content_type', sa.String(length=100), nullable=True),
        sa.Column('size_bytes', sa.Integer(), nullable=True),
        sa.Column('storage_path', sa.String(length=300), nullable=True),
        sa.Column('added_by', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        *_ts(),
    )
    op.create_index('ix_project_document_project', 'project_documents', ['project_id'])
    op.create_table(
        'project_activity',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('project_id', sa.String(length=64), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
        sa.Column('actor_id', sa.String(length=64), nullable=True),
        sa.Column('text', sa.String(length=400), nullable=False),
        sa.Column('happened_on', sa.Date(), nullable=True),
        *_ts(),
    )
    op.create_index('ix_project_activity_project', 'project_activity', ['project_id', 'created_at'])
    op.create_table(
        'comp_off_credits',
        sa.Column('id', sa.String(length=64), primary_key=True),
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('worked_date', sa.Date(), nullable=False),
        sa.Column('days', sa.Numeric(4, 2), nullable=False),
        sa.Column('reason', sa.String(length=200), nullable=False),
        sa.Column('granted_by', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=False),
        sa.Column('expires_on', sa.Date(), nullable=False),
        *_ts(),
    )
    op.create_index('ix_comp_off_credit_employee', 'comp_off_credits', ['employee_id', 'worked_date'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_comp_off_credit_employee', table_name='comp_off_credits')
    op.drop_table('comp_off_credits')
    op.drop_index('ix_project_activity_project', table_name='project_activity')
    op.drop_table('project_activity')
    op.drop_index('ix_project_document_project', table_name='project_documents')
    op.drop_table('project_documents')
    op.drop_index('ix_project_post_project', table_name='project_posts')
    op.drop_table('project_posts')
    op.drop_index('ix_project_tasks_assignee_id', table_name='project_tasks')
    op.drop_index('ix_project_task_project', table_name='project_tasks')
    op.drop_table('project_tasks')
    op.drop_index('ix_project_milestone_project_due', table_name='project_milestones')
    op.drop_table('project_milestones')
    with op.batch_alter_table('shift_types') as b:
        b.drop_column('location')
        b.drop_column('break_minutes')
    with op.batch_alter_table('timesheet_entries') as b:
        b.drop_column('work_label')
        b.drop_column('work_id')
        b.drop_column('work_type')
        b.drop_column('break_minutes')
        b.drop_column('start_minute')
    with op.batch_alter_table('project_members') as b:
        b.drop_column('budget_hours')
        b.drop_column('responsibilities')
        b.drop_column('title')
    with op.batch_alter_table('projects') as b:
        b.drop_column('manager_id')
        b.drop_column('budget_hours')
        b.drop_column('end_date')
        b.drop_column('start_date')
        b.drop_column('description')
