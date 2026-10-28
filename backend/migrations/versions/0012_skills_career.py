"""skills library, career paths and employee career profiles

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-29 10:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _stamps() -> list[sa.Column]:
    return [sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
            sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False)]


def upgrade() -> None:
    op.create_table(
        'skills',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('name', sa.String(length=100), nullable=False),
        sa.Column('category', sa.String(length=16), nullable=False),
        sa.Column('area', sa.String(length=64), nullable=True),
        sa.Column('description', sa.Text(), nullable=False),
        sa.Column('related_profile_ids', sa.JSON(), nullable=False),
        sa.Column('related_course_ids', sa.JSON(), nullable=False),
        sa.Column('certifications', sa.JSON(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_index('ix_skills_category', 'skills', ['category'])
    op.create_table(
        'career_paths',
        sa.Column('id', sa.String(length=64), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('track', sa.String(length=32), nullable=False),
        sa.Column('function', sa.String(length=64), nullable=False),
        sa.Column('from_profile_id', sa.String(length=64), sa.ForeignKey('job_profiles.id'), nullable=True),
        sa.Column('to_profile_id', sa.String(length=64), sa.ForeignKey('job_profiles.id'), nullable=True),
        sa.Column('required_skills', sa.JSON(), nullable=False),
        sa.Column('active', sa.Boolean(), nullable=False),
        *_stamps(),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_career_paths_track', 'career_paths', ['track'])
    op.create_index('ix_career_paths_from_profile_id', 'career_paths', ['from_profile_id'])
    op.create_index('ix_career_paths_to_profile_id', 'career_paths', ['to_profile_id'])
    op.create_table(
        'career_profiles',
        sa.Column('employee_id', sa.String(length=64), sa.ForeignKey('employees.id', ondelete='CASCADE'), nullable=False),
        sa.Column('current_role', sa.String(length=200), nullable=True),
        sa.Column('target_role_ids', sa.JSON(), nullable=False),
        sa.Column('interests', sa.JSON(), nullable=False),
        sa.Column('timeframe', sa.String(length=32), nullable=False),
        sa.Column('open_to_relocation', sa.Boolean(), nullable=False),
        sa.Column('mentor_id', sa.String(length=64), sa.ForeignKey('employees.id'), nullable=True),
        sa.Column('note', sa.Text(), nullable=False),
        sa.Column('updated_by', sa.String(length=64), nullable=True),
        *_stamps(),
        sa.PrimaryKeyConstraint('employee_id'),
    )


def downgrade() -> None:
    op.drop_table('career_profiles')
    op.drop_index('ix_career_paths_to_profile_id', table_name='career_paths')
    op.drop_index('ix_career_paths_from_profile_id', table_name='career_paths')
    op.drop_index('ix_career_paths_track', table_name='career_paths')
    op.drop_table('career_paths')
    op.drop_index('ix_skills_category', table_name='skills')
    op.drop_table('skills')
