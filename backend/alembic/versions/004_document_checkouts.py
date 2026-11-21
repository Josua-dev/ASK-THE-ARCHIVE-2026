"""document checkouts + multiple documents per box

Two related changes to how a document's physical location is tracked:

1. A box now holds more than one document. The partial unique index
   ``uq_documents_location_slot`` from migration 003 enforced one document per
   slot; it is dropped here, because a box is a container, not a single cell.
   Position inside a box is derived from the filed-at date (created_at), so
   nothing needs to be stored for it.

2. A document can be physically checked out of the archive. ``document_checkouts``
   records every checkout/return, and a partial unique index guarantees a
   document has at most one open checkout at a time.

Revision ID: 004_document_checkouts
Revises: 003_document_location
Create Date: 2026-11-21 00:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision: str = '004_document_checkouts'
down_revision: Union[str, None] = '003_document_location'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A box holds any number of documents, so the one-document-per-slot
    # constraint is no longer true. Dropping it lets two documents share a
    # zone/rack/shelf/box.
    op.drop_index('uq_documents_location_slot', table_name='documents')

    op.create_table(
        'document_checkouts',
        sa.Column('id', PG_UUID(as_uuid=True), primary_key=True),
        sa.Column(
            'document_id',
            PG_UUID(as_uuid=True),
            sa.ForeignKey('documents.id', ondelete='CASCADE'),
            nullable=False,
        ),
        sa.Column(
            'checked_out_by',
            PG_UUID(as_uuid=True),
            sa.ForeignKey('users.id', ondelete='SET NULL'),
            nullable=False,
        ),
        sa.Column('checked_out_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('due_at', sa.DateTime(timezone=True), nullable=False),
        # Nullable: NULL means the document is still out. A row is "closed"
        # once checked_in_at is set.
        sa.Column('checked_in_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            'checked_in_by',
            PG_UUID(as_uuid=True),
            sa.ForeignKey('users.id', ondelete='SET NULL'),
            nullable=True,
        ),
    )
    # A document may have many historical checkout rows, but at most one open
    # one at a time. The partial index is the real guarantee; the service's
    # row lock and explicit check only exist to give a clear error message.
    op.create_index(
        'ix_document_checkouts_document_id',
        'document_checkouts',
        ['document_id'],
    )
    op.create_index(
        'uq_document_checkouts_open',
        'document_checkouts',
        ['document_id'],
        unique=True,
        postgresql_where=sa.text('checked_in_at IS NULL'),
    )


def downgrade() -> None:
    op.drop_index('uq_document_checkouts_open', table_name='document_checkouts')
    op.drop_index('ix_document_checkouts_document_id', table_name='document_checkouts')
    op.drop_table('document_checkouts')

    # Restore the one-document-per-slot constraint. This fails if the archive
    # has accumulated more than one document per box since — which is the
    # point: a downgrade to the single-occupancy model cannot silently keep a
    # box holding several documents.
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