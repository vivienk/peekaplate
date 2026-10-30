"""Sitecustomize hook for child Python subprocesses to inherit the offline socket guard."""
from socket_guard import install

install()
