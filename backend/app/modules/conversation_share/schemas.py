"""Request and response models for conversation sharing."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class ShareCreate(BaseModel):
    shared_with_user_id: uuid.UUID
    permission: str = Field(default="read", pattern="^(read|contribute)$")


class ShareOut(BaseModel):
    id: uuid.UUID
    conversation_id: uuid.UUID
    shared_with_user_id: uuid.UUID
    shared_with_email: Optional[str] = None
    shared_with_name: Optional[str] = None
    permission: str
    created_by: Optional[uuid.UUID] = None
    created_at: Optional[str] = None


class ShareListOut(BaseModel):
    items: list[ShareOut]
    total: int


class ConversationAccessOut(BaseModel):
    conversation_id: uuid.UUID
    access: str
    can_read: bool
    can_contribute: bool
