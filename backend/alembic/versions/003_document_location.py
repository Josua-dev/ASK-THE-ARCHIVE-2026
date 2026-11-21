"""document warehouse location

Adds the four nullable columns that record where a document physically sits
in the archive (zone, rack, shelf, box) and a partial unique index so two
documents can never claim the same slot.

Revision ID: 003_document_location
Revises: 002_intelligence_modules
Create Date: 2026-11-21 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '003_document_location'
down_revision: Union[str, None] = '002_intelligence_modules'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('documents', sa.Column('zone', sa.Text(), nullable=True))
    op.add_column('documents', sa.Column('rack', sa.Text(), nullable=True))
    op.add_column('documents', sa.Column('shelf', sa.Text(), nullable=True))
    op.add_column('documents', sa.Column('box', sa.Text(), nullable=True))

    # A slot holds exactly one document. The index is partial so that
    # documents with no location at all — the majority of a freshly
    # migrated archive — do not collide with each other on the NULLs.
    op.create_index(
        'uq_documents_location_slot',
        'documents',
        ['zone', 'rack', 'shelf', 'box'],
        unique=True,
        postgresql_where=sa.text(
            'zone IS NOT NULL AND rack IS NOT NULL '
            'AND shelf IS NOT NULL AND box IS NOT NULL'
        ),
    )


def downgrade() -> None:
    op.drop_index('uq_documents_location_slot', table_name='documents')
    op.drop_column('documents', 'box')
    op.drop_column('documents', 'shelf')
    op.drop_column('documents', 'rack')
    op.drop_column('documents', 'zone')
