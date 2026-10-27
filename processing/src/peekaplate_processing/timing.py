"""Elapsed wall time for a named stage, including failed operations."""
from contextlib import contextmanager
from time import perf_counter


@contextmanager
def measure(timings, stage):
    started=perf_counter()
    try:
        yield
    finally:
        timings[stage]=round(timings.get(stage, 0)+perf_counter()-started, 6)
