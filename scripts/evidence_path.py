"""Destination admission for Python qualification runners."""
import os
from pathlib import Path
import tempfile

_SOURCE = Path(__file__).resolve().parent.parent


def _external_path(value):
    path = Path(value)
    if not path.is_absolute():
        raise ValueError('Evidence requires an absolute path outside checkouts')
    for parent in (path, *path.parents):
        if parent.is_symlink() and not parent.exists():
            raise ValueError('Evidence path contains a dangling symlink')
    path = path.resolve()
    if path == Path(path.anchor) or path.is_relative_to('/dev') or path.is_relative_to(_SOURCE):
        raise ValueError('Evidence must be outside checkouts and device directories')
    if any((parent / '.git').exists() for parent in (path, *path.parents)):
        raise ValueError('Evidence must be outside every checkout')
    return path


def external_evidence_path(value):
    path = _external_path(value)
    archive = os.environ.get('MURAGE_EVIDENCE_ARCHIVE')
    if archive is not None:
        archive = _external_path(archive)
        if path.is_relative_to(archive) or archive.is_relative_to(path):
            raise ValueError('Evidence output overlaps the retained archive')
    if path.is_file() and path.stat().st_nlink > 1:
        raise ValueError('Evidence target is a hard-linked file')
    return path


def archived_evidence_path(name):
    """Historical inputs come only from the retained archive named by MURAGE_EVIDENCE_ARCHIVE."""
    path = Path(name)
    if not path.parts or path.is_absolute() or '..' in path.parts:
        raise ValueError('Archived evidence path must be relative to the archive')
    archive = os.environ.get('MURAGE_EVIDENCE_ARCHIVE')
    if archive is None:
        raise ValueError('Historical evidence requires MURAGE_EVIDENCE_ARCHIVE')
    root = _external_path(archive)
    dest = _external_path(root / path)
    if not dest.is_relative_to(root):
        raise ValueError('Archived evidence path escaped the archive')
    return dest


def evidence_path(name):
    path = Path(name)
    if not path.parts or path.is_absolute() or '..' in path.parts:
        raise ValueError('Evidence path must be relative to its external directory')
    root = os.environ.get('MURAGE_EVIDENCE_ROOT')
    if root is None:
        root = tempfile.mkdtemp(prefix='murage-evidence-', dir=_external_path(tempfile.gettempdir()))
        os.environ['MURAGE_EVIDENCE_ROOT'] = root
    root = external_evidence_path(root)
    dest = external_evidence_path(root / path)
    if not dest.is_relative_to(root):
        raise ValueError('Evidence path escaped its directory')
    dest.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return dest
