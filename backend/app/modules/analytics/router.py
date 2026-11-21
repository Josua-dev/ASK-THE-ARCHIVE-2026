"""Routes for the Analytics module."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import get_current_user
from app.db.session import get_db_session
from app.modules.analytics.schemas import AnalyticsOut
from app.modules.analytics.service import compute_analytics

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


@router.get("", response_model=AnalyticsOut)
async def get_analytics(
    session: AsyncSession = Depends(get_db_session),
    user=Depends(get_current_user),
):
    """Archive and activity analytics.

    The archive figures cover the documents the caller may read; the activity
    figures cover the caller's own questions, searches, comparisons, research
    reports and extraction runs.
    """
    return AnalyticsOut(**await compute_analytics(session, user))
