"""Checker-only reader faults. Never execute payload code or alter judge's public API."""
from contextlib import contextmanager
from unittest.mock import patch


@contextmanager
def inject(mod, fault):
    if not fault:
        yield
        return
    if fault == "after-twin":
        original = mod.PyReader.twin_delete

        def fail(self, *args):
            original(self, *args)
            raise RuntimeError("injected after collecting twin, during AST walk")

        replacement = patch.object(mod.PyReader, "twin_delete", fail)
    elif fault == "before-walk":
        replacement = patch.object(mod.PyReader, "run", side_effect=RuntimeError("injected mid-reader"))
    elif fault == "recursion":
        replacement = patch.object(mod.PyReader, "run", side_effect=RecursionError("injected recursion limit"))
    elif fault == "size":
        replacement = patch.object(mod, "MAX_TEXT", 1)
    elif fault == "work":
        replacement = patch.object(mod, "MAX_WORK", 0)
    else:
        raise AssertionError("unknown fault: " + fault)
    with replacement:
        yield
