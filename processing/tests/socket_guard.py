"""Offline test guard: block outbound sockets, allow local event-loop socketpairs."""
import os
import socket
import threading

_lock = threading.Lock()
_attempts = 0
_installed = False
_original_connect = socket.socket.connect
_original_connect_ex = socket.socket.connect_ex
_original_create_connection = socket.create_connection


def _record_attempt():
    global _attempts
    with _lock:
        _attempts += 1
    audit_file = os.environ.get("SOCKET_GUARD_AUDIT_FILE")
    if audit_file and os.environ.get("SOCKET_GUARD_NEGATIVE_PROBE") != "1":
        try:
            with open(audit_file, "a", encoding="utf-8") as handle:
                handle.write(f"{os.getpid()}:1\n")
        except Exception:
            pass


def get_attempts():
    with _lock:
        return _attempts


def reset_attempts():
    global _attempts
    with _lock:
        old = _attempts
        _attempts = 0
        return old


def blocked_connect(self, address):
    if self.family == getattr(socket, "AF_UNIX", None):
        return _original_connect(self, address)
    _record_attempt()
    raise AssertionError(f"Network disabled by offline socket guard: blocked connection to {address}")


def blocked_connect_ex(self, address):
    if self.family == getattr(socket, "AF_UNIX", None):
        return _original_connect_ex(self, address)
    _record_attempt()
    raise AssertionError(f"Network disabled by offline socket guard: blocked connection_ex to {address}")


def blocked_create_connection(address, *args, **kwargs):
    _record_attempt()
    raise AssertionError(f"Network disabled by offline socket guard: blocked create_connection to {address}")


def install():
    global _installed
    if _installed:
        return
    socket.socket.connect = blocked_connect
    socket.socket.connect_ex = blocked_connect_ex
    socket.create_connection = blocked_create_connection
    tests_dir = os.path.dirname(os.path.abspath(__file__))
    current_pp = os.environ.get("PYTHONPATH", "")
    pp_parts = [p for p in current_pp.split(os.pathsep) if p]
    if tests_dir not in pp_parts:
        os.environ["PYTHONPATH"] = os.pathsep.join([tests_dir] + pp_parts)
    _installed = True
