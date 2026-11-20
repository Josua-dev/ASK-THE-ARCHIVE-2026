"""Storage protocol — the local filesystem.

There is no object store to sign against, so this port deliberately stops at
bytes in and bytes out. Authorising a download is a separate concern handled
by the signed-link helpers in `app.core.security`, which are scope-bound to a
single document and expire quickly.
"""

from abc import ABC, abstractmethod
from typing import Optional


class StoragePort(ABC):
    @abstractmethod
    async def put_object(
        self,
        key: str,
        body: bytes,
        content_type: str,
        metadata: Optional[dict] = None,
    ) -> str:
        """Store `body` under `key`. Returns the object key."""

    @abstractmethod
    async def get_object(self, key: str) -> bytes:
        """Return raw bytes for `key`."""

    @abstractmethod
    async def object_exists(self, key: str) -> bool:
        """Return True if the object exists."""

    @abstractmethod
    async def delete_object(self, key: str) -> None:
        """Remove the object. Missing objects are not an error."""