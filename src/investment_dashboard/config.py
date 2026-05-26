"""Application configuration loaded from env vars and optional .env file."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_db_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return base / "inv-dashboard" / "db.sqlite"


class Settings(BaseSettings):
    """Top-level app settings."""

    model_config = SettingsConfigDict(
        env_prefix="INV_DASHBOARD_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    db_path: Path = Field(default_factory=_default_db_path)
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "INFO"

    @field_validator("log_level")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @property
    def db_url(self) -> str:
        return f"sqlite:///{self.db_path.as_posix()}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
