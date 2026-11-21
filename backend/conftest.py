"""Pytest configuration to add project root to Python path."""
import sys
from pathlib import Path

# Add the backend directory to sys.path so `import app` works
backend_root = Path(__file__).parent
sys.path.insert(0, str(backend_root))