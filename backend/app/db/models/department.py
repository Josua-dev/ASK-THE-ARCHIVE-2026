"""Departments — organisational units used for permission scoping."""

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Column, Text
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.orm import relationship

from app.db.base import Base
from app.db.types import tstz, utcnow

if TYPE_CHECKING:
    from app.db.models.user_group import UserGroup


class Department(Base):
    __tablename__ = "departments"

    id = Column(PG_UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False, unique=True)
    description = Column(Text, nullable=True)
    created_at = Column(tstz(), nullable=False, default=utcnow)

    groups = relationship("UserGroup", back_populates="department", lazy="joined")
