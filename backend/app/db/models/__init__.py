"""Import every model so Base.metadata (and Alembic autogenerate) sees all tables."""

from app.db.models.archive_insight import ArchiveInsight
from app.db.models.audit import AuditLog
from app.db.models.chunk import DocumentChunk
from app.db.models.citation import Citation
from app.db.models.comparison import ComparisonFinding, DocumentComparison
from app.db.models.conversation import Conversation
from app.db.models.conversation_share import ConversationShare
from app.db.models.department import Department
from app.db.models.document import Document
from app.db.models.document_profile import DocumentProfile
from app.db.models.document_summary import DocumentSummary
from app.db.models.document_version import DocumentVersion
from app.db.models.evidence import RetrievalEvidence
from app.db.models.extracted_entity import EntityMention, ExtractedEntity
from app.db.models.extraction_run import ExtractionRow, ExtractionRun
from app.db.models.ingestion_job import IngestionJob
from app.db.models.message import Message
from app.db.models.permission import DocumentPermission
from app.db.models.research_report import ResearchReport
from app.db.models.search_history import SearchHistory
from app.db.models.user import User
from app.db.models.user_group import GroupMember, UserGroup

__all__ = [
    "ArchiveInsight", "AuditLog", "Citation", "ComparisonFinding", "Conversation",
    "ConversationShare", "Department", "Document", "DocumentChunk",
    "DocumentComparison", "DocumentPermission", "DocumentProfile",
    "DocumentSummary", "DocumentVersion", "EntityMention", "ExtractedEntity",
    "ExtractionRow", "ExtractionRun", "GroupMember", "IngestionJob", "Message",
    "ResearchReport", "RetrievalEvidence", "SearchHistory", "User", "UserGroup",
]
