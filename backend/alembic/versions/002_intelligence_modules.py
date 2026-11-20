"""intelligence modules schema

Adds the tables that back the archive intelligence product: document
versioning, structured document profiles, extracted entities and mentions,
document comparison, Research Mode reports, Extraction Studio runs, archive
insights, departments and user groups, conversation sharing and search
history.

Revision ID: 002_intelligence_modules
Revises: 001_base
Create Date: 2026-11-20 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = '002_intelligence_modules'
down_revision: Union[str, None] = '001_base'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


JSONB = postgresql.JSONB(astext_type=sa.Text())
UUID = sa.UUID()
TS = sa.DateTime(timezone=True)


def upgrade() -> None:
    # ── Departments and groups ───────────────────────────────────────────
    op.create_table(
        'departments',
        sa.Column('id', UUID, nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_table(
        'user_groups',
        sa.Column('id', UUID, nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('department_id', UUID, nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['department_id'], ['departments.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_index(op.f('ix_user_groups_department_id'), 'user_groups', ['department_id'], unique=False)
    op.create_table(
        'group_members',
        sa.Column('id', UUID, nullable=False),
        sa.Column('group_id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['group_id'], ['user_groups.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('group_id', 'user_id', name='uq_group_members_group_user'),
    )
    op.create_index(op.f('ix_group_members_group_id'), 'group_members', ['group_id'], unique=False)
    op.create_index(op.f('ix_group_members_user_id'), 'group_members', ['user_id'], unique=False)

    # ── Users gain a department; audit logs gain a readable label ────────
    op.add_column('users', sa.Column('department_id', UUID, nullable=True))
    op.create_foreign_key(
        'fk_users_department_id', 'users', 'departments', ['department_id'], ['id'], ondelete='SET NULL'
    )
    op.create_index(op.f('ix_users_department_id'), 'users', ['department_id'], unique=False)

    op.add_column('audit_logs', sa.Column('resource_label', sa.Text(), nullable=True))

    # ── Document versioning ──────────────────────────────────────────────
    op.create_table(
        'document_versions',
        sa.Column('id', UUID, nullable=False),
        sa.Column('document_id', UUID, nullable=False),
        sa.Column('version_no', sa.Integer(), nullable=False),
        sa.Column('storage_key', sa.Text(), nullable=False),
        sa.Column('filename', sa.Text(), nullable=False),
        sa.Column('byte_size', sa.BigInteger(), nullable=False),
        sa.Column('checksum_sha256', sa.Text(), nullable=False),
        sa.Column('note', sa.Text(), nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('document_id', 'version_no', name='uq_document_versions_no'),
    )
    op.create_index(op.f('ix_document_versions_document_id'), 'document_versions', ['document_id'], unique=False)

    # ── Extracted entities and their mentions ────────────────────────────
    op.create_table(
        'extracted_entities',
        sa.Column('id', UUID, nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('name', sa.Text(), nullable=False),
        sa.Column('normalized_name', sa.Text(), nullable=False),
        sa.Column('attributes', JSONB, nullable=False),
        sa.Column('mention_count', sa.Integer(), nullable=False),
        sa.Column('first_seen_at', TS, nullable=True),
        sa.Column('last_seen_at', TS, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_extracted_entities_kind'), 'extracted_entities', ['kind'], unique=False)
    op.create_index(op.f('ix_extracted_entities_normalized_name'), 'extracted_entities', ['normalized_name'], unique=False)

    op.create_table(
        'entity_mentions',
        sa.Column('id', UUID, nullable=False),
        sa.Column('entity_id', UUID, nullable=False),
        sa.Column('document_id', UUID, nullable=False),
        sa.Column('chunk_id', UUID, nullable=True),
        sa.Column('page_start', sa.Integer(), nullable=True),
        sa.Column('page_end', sa.Integer(), nullable=True),
        sa.Column('excerpt', sa.Text(), nullable=False),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['entity_id'], ['extracted_entities.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['chunk_id'], ['document_chunks.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_entity_mentions_entity_id'), 'entity_mentions', ['entity_id'], unique=False)
    op.create_index(op.f('ix_entity_mentions_document_id'), 'entity_mentions', ['document_id'], unique=False)

    # ── Structured document profiles ─────────────────────────────────────
    op.create_table(
        'document_profiles',
        sa.Column('id', UUID, nullable=False),
        sa.Column('document_id', UUID, nullable=False),
        sa.Column('doc_type', sa.Text(), nullable=True),
        sa.Column('parties', JSONB, nullable=False),
        sa.Column('organisations', JSONB, nullable=False),
        sa.Column('individuals', JSONB, nullable=False),
        sa.Column('important_dates', JSONB, nullable=False),
        sa.Column('monetary_values', JSONB, nullable=False),
        sa.Column('currency', sa.Text(), nullable=True),
        sa.Column('contract_references', JSONB, nullable=False),
        sa.Column('important_clauses', JSONB, nullable=False),
        sa.Column('obligations', JSONB, nullable=False),
        sa.Column('keywords', JSONB, nullable=False),
        sa.Column('related_documents', JSONB, nullable=False),
        sa.Column('source_refs', JSONB, nullable=False),
        sa.Column('confidence', sa.Float(), nullable=True),
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.Column('updated_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('document_id'),
    )

    # ── Document comparison ──────────────────────────────────────────────
    op.create_table(
        'document_comparisons',
        sa.Column('id', UUID, nullable=False),
        sa.Column('document_a_id', UUID, nullable=False),
        sa.Column('document_b_id', UUID, nullable=False),
        sa.Column('status', sa.Text(), nullable=False),
        sa.Column('summary', sa.Text(), nullable=True),
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.Column('completed_at', TS, nullable=True),
        sa.ForeignKeyConstraint(['document_a_id'], ['documents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['document_b_id'], ['documents.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_document_comparisons_document_a_id'), 'document_comparisons', ['document_a_id'], unique=False)
    op.create_index(op.f('ix_document_comparisons_document_b_id'), 'document_comparisons', ['document_b_id'], unique=False)
    op.create_index(op.f('ix_document_comparisons_status'), 'document_comparisons', ['status'], unique=False)
    op.create_index(op.f('ix_document_comparisons_created_by'), 'document_comparisons', ['created_by'], unique=False)

    op.create_table(
        'comparison_findings',
        sa.Column('id', UUID, nullable=False),
        sa.Column('comparison_id', UUID, nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('category', sa.Text(), nullable=True),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('detail', sa.Text(), nullable=True),
        sa.Column('severity', sa.Text(), nullable=True),
        sa.Column('citation_a', JSONB, nullable=True),
        sa.Column('citation_b', JSONB, nullable=True),
        sa.Column('sort_order', sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(['comparison_id'], ['document_comparisons.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_comparison_findings_comparison_id'), 'comparison_findings', ['comparison_id'], unique=False)

    # ── Research Mode reports ────────────────────────────────────────────
    op.create_table(
        'research_reports',
        sa.Column('id', UUID, nullable=False),
        sa.Column('conversation_id', UUID, nullable=True),
        sa.Column('message_id', UUID, nullable=True),
        sa.Column('question', sa.Text(), nullable=False),
        sa.Column('sections', JSONB, nullable=False),
        sa.Column('citations', JSONB, nullable=False),
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('tokens_used', sa.Integer(), nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['message_id'], ['messages.id'], ondelete='SET NULL'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_research_reports_conversation_id'), 'research_reports', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_research_reports_created_by'), 'research_reports', ['created_by'], unique=False)

    # ── Extraction Studio ────────────────────────────────────────────────
    op.create_table(
        'extraction_runs',
        sa.Column('id', UUID, nullable=False),
        sa.Column('instruction', sa.Text(), nullable=False),
        sa.Column('question', sa.Text(), nullable=True),
        sa.Column('status', sa.Text(), nullable=False),
        sa.Column('columns', JSONB, nullable=False),
        sa.Column('row_count', sa.Integer(), nullable=False),
        sa.Column('model', sa.Text(), nullable=True),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.Column('completed_at', TS, nullable=True),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_extraction_runs_status'), 'extraction_runs', ['status'], unique=False)
    op.create_index(op.f('ix_extraction_runs_created_by'), 'extraction_runs', ['created_by'], unique=False)

    op.create_table(
        'extraction_rows',
        sa.Column('id', UUID, nullable=False),
        sa.Column('run_id', UUID, nullable=False),
        sa.Column('row_index', sa.Integer(), nullable=False),
        sa.Column('data', JSONB, nullable=False),
        sa.Column('document_id', UUID, nullable=True),
        sa.Column('citations', JSONB, nullable=False),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['run_id'], ['extraction_runs.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['document_id'], ['documents.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_extraction_rows_run_id'), 'extraction_rows', ['run_id'], unique=False)

    # ── Archive insights ─────────────────────────────────────────────────
    op.create_table(
        'archive_insights',
        sa.Column('id', UUID, nullable=False),
        sa.Column('kind', sa.Text(), nullable=False),
        sa.Column('severity', sa.Text(), nullable=False),
        sa.Column('title', sa.Text(), nullable=False),
        sa.Column('detail', sa.Text(), nullable=True),
        sa.Column('document_ids', postgresql.ARRAY(UUID), nullable=False),
        sa.Column('evidence', JSONB, nullable=False),
        sa.Column('status', sa.Text(), nullable=False),
        sa.Column('detected_at', TS, nullable=False),
        sa.Column('acknowledged_by', UUID, nullable=True),
        sa.Column('acknowledged_at', TS, nullable=True),
        sa.ForeignKeyConstraint(['acknowledged_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_archive_insights_kind'), 'archive_insights', ['kind'], unique=False)
    op.create_index(op.f('ix_archive_insights_severity'), 'archive_insights', ['severity'], unique=False)
    op.create_index(op.f('ix_archive_insights_status'), 'archive_insights', ['status'], unique=False)
    op.create_index(op.f('ix_archive_insights_detected_at'), 'archive_insights', ['detected_at'], unique=False)

    # ── Conversation sharing ─────────────────────────────────────────────
    op.create_table(
        'conversation_shares',
        sa.Column('id', UUID, nullable=False),
        sa.Column('conversation_id', UUID, nullable=False),
        sa.Column('shared_with_user_id', UUID, nullable=False),
        sa.Column('permission', sa.Text(), nullable=False),
        sa.Column('created_by', UUID, nullable=True),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['conversation_id'], ['conversations.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['shared_with_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'conversation_id', 'shared_with_user_id', name='uq_conversation_shares_conv_user'
        ),
    )
    op.create_index(op.f('ix_conversation_shares_conversation_id'), 'conversation_shares', ['conversation_id'], unique=False)
    op.create_index(op.f('ix_conversation_shares_shared_with_user_id'), 'conversation_shares', ['shared_with_user_id'], unique=False)

    # ── Search history ───────────────────────────────────────────────────
    op.create_table(
        'search_history',
        sa.Column('id', UUID, nullable=False),
        sa.Column('user_id', UUID, nullable=False),
        sa.Column('query', sa.Text(), nullable=False),
        sa.Column('mode', sa.Text(), nullable=False),
        sa.Column('result_count', sa.Integer(), nullable=False),
        sa.Column('filters', JSONB, nullable=False),
        sa.Column('created_at', TS, nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_search_history_user_id'), 'search_history', ['user_id'], unique=False)
    op.create_index(op.f('ix_search_history_created_at'), 'search_history', ['created_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_search_history_created_at'), table_name='search_history')
    op.drop_index(op.f('ix_search_history_user_id'), table_name='search_history')
    op.drop_table('search_history')

    op.drop_index(op.f('ix_conversation_shares_shared_with_user_id'), table_name='conversation_shares')
    op.drop_index(op.f('ix_conversation_shares_conversation_id'), table_name='conversation_shares')
    op.drop_table('conversation_shares')

    op.drop_index(op.f('ix_archive_insights_detected_at'), table_name='archive_insights')
    op.drop_index(op.f('ix_archive_insights_status'), table_name='archive_insights')
    op.drop_index(op.f('ix_archive_insights_severity'), table_name='archive_insights')
    op.drop_index(op.f('ix_archive_insights_kind'), table_name='archive_insights')
    op.drop_table('archive_insights')

    op.drop_index(op.f('ix_extraction_rows_run_id'), table_name='extraction_rows')
    op.drop_table('extraction_rows')

    op.drop_index(op.f('ix_extraction_runs_created_by'), table_name='extraction_runs')
    op.drop_index(op.f('ix_extraction_runs_status'), table_name='extraction_runs')
    op.drop_table('extraction_runs')

    op.drop_index(op.f('ix_research_reports_created_by'), table_name='research_reports')
    op.drop_index(op.f('ix_research_reports_conversation_id'), table_name='research_reports')
    op.drop_table('research_reports')

    op.drop_index(op.f('ix_comparison_findings_comparison_id'), table_name='comparison_findings')
    op.drop_table('comparison_findings')

    op.drop_index(op.f('ix_document_comparisons_created_by'), table_name='document_comparisons')
    op.drop_index(op.f('ix_document_comparisons_status'), table_name='document_comparisons')
    op.drop_index(op.f('ix_document_comparisons_document_b_id'), table_name='document_comparisons')
    op.drop_index(op.f('ix_document_comparisons_document_a_id'), table_name='document_comparisons')
    op.drop_table('document_comparisons')

    op.drop_table('document_profiles')

    op.drop_index(op.f('ix_entity_mentions_document_id'), table_name='entity_mentions')
    op.drop_index(op.f('ix_entity_mentions_entity_id'), table_name='entity_mentions')
    op.drop_table('entity_mentions')

    op.drop_index(op.f('ix_extracted_entities_normalized_name'), table_name='extracted_entities')
    op.drop_index(op.f('ix_extracted_entities_kind'), table_name='extracted_entities')
    op.drop_table('extracted_entities')

    op.drop_index(op.f('ix_document_versions_document_id'), table_name='document_versions')
    op.drop_table('document_versions')

    op.drop_column('audit_logs', 'resource_label')

    op.drop_index(op.f('ix_users_department_id'), table_name='users')
    op.drop_constraint('fk_users_department_id', 'users', type_='foreignkey')
    op.drop_column('users', 'department_id')

    op.drop_index(op.f('ix_group_members_user_id'), table_name='group_members')
    op.drop_index(op.f('ix_group_members_group_id'), table_name='group_members')
    op.drop_table('group_members')

    op.drop_index(op.f('ix_user_groups_department_id'), table_name='user_groups')
    op.drop_table('user_groups')

    op.drop_table('departments')
