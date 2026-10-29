export const PRIVATE_CAPTURE_PROGRAM = String.raw`
import fcntl
import hashlib
import importlib.metadata
import json
import os
import re
import select
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid

PIN = "12.3.1"
MAX_BODY = 64 * 1024 * 1024
RESERVE = 64 * 1024 * 1024
SECRET = re.compile(r"^(authorization|proxy-authorization|cookie|set-cookie|(?:[a-z0-9]+[-_])*(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|security[-_]?token|oauth[-_]?token|auth[-_]?token|session[-_]?token|password|secret)|(?:[a-z0-9]+[-_])+token)$", re.I)

def memory_filesystem(path):
    if not sys.platform.startswith("linux"):
        raise ValueError("memory_filesystem_unavailable")
    import ctypes
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        result = ctypes.create_string_buffer(256)
        if ctypes.CDLL(None, use_errno=True).fstatfs(fd, result) != 0:
            raise OSError("memory_filesystem_unavailable")
        kind = ctypes.c_long.from_buffer(result).value & 0xffffffff
        if kind == 0x858458f6:
            return
        if kind != 0x01021994:
            raise ValueError("memory_filesystem_unavailable")
        with open("/proc/swaps", "r", encoding="utf8") as stream:
            if len(stream.read(65536).strip().splitlines()) != 1:
                raise ValueError("unencrypted_swap_not_excluded")
    finally:
        os.close(fd)

def encryption_key(cfg):
    if "_key" in cfg:
        return cfg["_key"]
    reference = cfg["keyRef"]
    if reference.startswith("memory-file:"):
        path = reference[len("memory-file:"):]
        if not path.startswith("/") or os.path.realpath(path) != path:
            raise ValueError("capture_key_unavailable")
        memory_filesystem(path)
        value = read_private(path, 65).decode("ascii").strip()
    else:
        match = re.fullmatch(r"keychain:([a-zA-Z0-9._-]{1,128}):([a-zA-Z0-9._-]{1,128})", reference)
        if sys.platform != "darwin" or not match:
            raise ValueError("capture_key_unavailable")
        result = subprocess.run(["/usr/bin/security", "find-generic-password", "-w", "-s", match[1], "-a", match[2]], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, env={"PATH": "/usr/bin:/bin"}, check=True)
        if len(result.stdout) > 128:
            raise ValueError("capture_key_unavailable")
        value = result.stdout.decode("ascii").strip()
    if not re.fullmatch(r"[a-fA-F0-9]{64}", value):
        raise ValueError("capture_key_unavailable")
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.hkdf import HKDF
    cfg["_key"] = HKDF(algorithm=hashes.SHA256(), length=32, salt=bytes.fromhex(cfg["cipherScope"]), info=b"bb-private-capture/v1/host").derive(bytes.fromhex(value))
    return cfg["_key"]

def encrypted_frame(cfg, name, sequence, data):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    aad = ("bb-private-capture/v1\0host\0" + cfg["cipherScope"] + "\0source/" + name + "\0" + str(sequence) + "\0" + str(len(data))).encode()
    return len(data).to_bytes(4, "big") + nonce + AESGCM(encryption_key(cfg)).encrypt(nonce, data, aad)

def encrypted_bytes(cfg, name, data):
    result = [b"BBPC1\n"]
    sequence = 0
    for offset in range(0, len(data), 65536):
        result.append(encrypted_frame(cfg, name, sequence, data[offset:offset + 65536]))
        sequence += 1
    result.append(encrypted_frame(cfg, name, sequence, b""))
    return b"".join(result)

def read_encrypted(cfg, name, maximum, interrupted=False):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    raw = read_private(os.path.join(cfg["sources"], name), cfg["maxBytes"])
    if raw[:6] != b"BBPC1\n":
        raise ValueError("capture_ciphertext_integrity")
    position, sequence, total = 6, 0, 0
    pieces = []
    while position + 32 <= len(raw):
        size = int.from_bytes(raw[position:position + 4], "big")
        if size > 65536 or total + size > maximum:
            raise ValueError("capture_ciphertext_integrity")
        if position + 32 + size > len(raw):
            break
        aad = ("bb-private-capture/v1\0host\0" + cfg["cipherScope"] + "\0source/" + name + "\0" + str(sequence) + "\0" + str(size)).encode()
        piece = AESGCM(encryption_key(cfg)).decrypt(raw[position + 4:position + 16], raw[position + 16:position + 32 + size], aad)
        sequence += 1
        position += 32 + size
        if size == 0:
            if position != len(raw):
                raise ValueError("capture_ciphertext_integrity")
            return b"".join(pieces)
        pieces.append(piece)
        total += size
    if not interrupted:
        raise ValueError("capture_ciphertext_integrity")
    return b"".join(pieces)

def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("capture_write_failed")
        view = view[written:]

def read_private(path, maximum=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_size > maximum:
            raise ValueError("unsafe_private_file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(maximum + 1)
        after = os.fstat(fd)
        if len(data) != info.st_size or after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns or after.st_ctime_ns != info.st_ctime_ns:
            raise ValueError("unstable_private_file")
        return data
    finally:
        os.close(fd)

def atomic(path, value, cfg=None):
    atomic_bytes(path, json.dumps(value, ensure_ascii=True, separators=(",", ":")).encode(), cfg)

def atomic_bytes(path, data, cfg=None):
    directory = os.path.dirname(path)
    if cfg is not None:
        data = encrypted_bytes(cfg, os.path.basename(path), data)
    temporary = os.path.join(directory, str(uuid.uuid4()) + ".pending")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as stream:
            stream.write(data)
            stream.flush()
        os.fsync(fd)
        os.replace(temporary, path)
        parent = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(parent)
        finally:
            os.close(parent)
    finally:
        os.close(fd)
        if os.path.exists(temporary):
            os.unlink(temporary)

def load(path):
    value = json.loads(read_private(path))
    for directory in (value["sources"], value["runtime"]):
        if directory == value["sources"] and not os.path.exists(directory):
            continue
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or os.path.realpath(directory) != directory:
            raise ValueError("unsafe_private_directory")
    return value

def phase(cfg, value, **fields):
    atomic(os.path.join(cfg["runtime"], "state.json"), {"phase": value, **fields})

def gap(cfg, value):
    try:
        atomic(os.path.join(cfg["sources"], "gap.json"), {"phase": value})
    except OSError:
        sys.stderr.write("Private capture status storage unavailable; capture completeness is unknown.\n")

def allowed(cfg):
    control = json.loads(read_private(cfg["control"]))
    return control["enabled"] and time.time() * 1000 < min(control["leaseUntil"], cfg["expiresAt"])

def context(cfg):
    if "_session" in cfg:
        return cfg["_session"], cfg["_root"]
    if os.environ.get("BB_PRIVATE_CAPTURE_CONFIG") != cfg["config"]:
        raise ValueError("capture_context_missing")
    session = str(uuid.UUID(os.environ["BB_PRIVATE_CAPTURE_SESSION"]))
    root = int(os.environ["BB_PRIVATE_CAPTURE_ROOT_PID"])
    if root <= 0:
        raise ValueError("capture_context_missing")
    return session, root

def source_usage(cfg):
    own = 0
    total = 0
    for session in os.scandir(cfg["hostRoot"]):
        if not session.is_dir(follow_symlinks=False) or not re.fullmatch(r"[a-f0-9-]{36}", session.name):
            continue
        source = os.path.join(session.path, "sources")
        if not os.path.exists(source):
            continue
        info = os.lstat(source)
        if not stat.S_ISDIR(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid():
            raise ValueError("unsafe_source_budget")
        for entry in os.scandir(source):
            try:
                item = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue
            if not stat.S_ISREG(item.st_mode):
                raise ValueError("unsafe_source_budget")
            total += item.st_size
            if source == cfg["sources"]:
                own += item.st_size
    return own, total

def admit(cfg, additional):
    own, total = source_usage(cfg)
    space = os.statvfs(cfg["sources"])
    if len(list(os.scandir(cfg["sources"]))) >= cfg["maxArtifacts"] * 3 or own + additional > cfg["maxBytes"] or total + additional > 512 * 1024 * 1024:
        gap(cfg, "quota")
        return False
    if space.f_bavail * space.f_frsize < additional + RESERVE:
        gap(cfg, "disk_pressure")
        return False
    return True

class Record:
    def __init__(self, cfg, source, direction, metadata, request_id=None, transport="stdio", sequence=0):
        self.cfg = cfg
        self.active = False
        if not allowed(cfg):
            return
        session, root = context(cfg)
        self.id = str(uuid.uuid4())
        self.path = os.path.join(cfg["sources"], self.id + ".body")
        lock = os.open(os.path.join(cfg["hostRoot"], "process-sources.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if not admit(cfg, 65536):
                return
            self.fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            write_all(self.fd, b"BBPC1\n")
            self.frame_sequence = 0
            self.size = 0
            self.hash = hashlib.sha256()
            self.last_sync = time.monotonic()
            self.meta = {"captureId": cfg["captureId"], "subjectDigest": cfg["subjectDigest"], "processSessionId": session, "rootPid": root, "producerPid": os.getpid(), "recordId": self.id, "source": source, "direction": direction, "sequence": sequence, "requestId": request_id, "transport": transport, "observedAt": int(time.time() * 1000), "metadata": metadata}
            if len(json.dumps(self.meta, ensure_ascii=True).encode()) > 60000:
                os.close(self.fd)
                os.unlink(self.path)
                gap(cfg, "quota")
                return
            atomic(os.path.join(cfg["sources"], self.id + ".open.json"), self.meta, cfg)
            self.active = True
        finally:
            os.close(lock)

    def append(self, data):
        if not self.active:
            return
        if not allowed(self.cfg):
            self.finish("interrupted")
            gap(self.cfg, "lease_expired")
            return
        lock = os.open(os.path.join(self.cfg["hostRoot"], "process-sources.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.size + len(data) > MAX_BODY or not admit(self.cfg, len(data) + ((len(data) + 65535) // 65536 + 1) * 32):
                gap(self.cfg, "quota")
                self.finish("interrupted")
                return
            for offset in range(0, len(data), 65536):
                part = data[offset:offset + 65536]
                write_all(self.fd, encrypted_frame(self.cfg, self.id + ".body", self.frame_sequence, part))
                self.frame_sequence += 1
                self.size += len(part)
                self.hash.update(part)
            if time.monotonic() - self.last_sync >= 1:
                os.fsync(self.fd)
                self.last_sync = time.monotonic()
        except Exception:
            gap(self.cfg, "source_unavailable")
            self.finish("interrupted")
        finally:
            os.close(lock)

    def finish(self, state="complete"):
        if not self.active:
            return
        self.active = False
        try:
            write_all(self.fd, encrypted_frame(self.cfg, self.id + ".body", self.frame_sequence, b""))
            os.fsync(self.fd)
        finally:
            os.close(self.fd)
        atomic(os.path.join(self.cfg["sources"], self.id + ".json"), {**self.meta, "streamState": state, "bytes": self.size, "sha256": self.hash.hexdigest()}, self.cfg)
        os.unlink(os.path.join(self.cfg["sources"], self.id + ".open.json"))

def one(cfg, source, direction, data, metadata=None, request_id=None):
    record = Record(cfg, source, direction, metadata or {}, request_id)
    record.append(data)
    record.finish()

class NativeLines:
    def __init__(self, cfg, source, direction, metadata):
        self.cfg, self.source, self.direction, self.metadata = cfg, source, direction, metadata
        self.buffer = bytearray()
        self.disabled = False

    def feed(self, data, end=False):
        if self.disabled:
            return
        self.buffer.extend(data)
        if len(self.buffer) > MAX_BODY:
            gap(self.cfg, "quota")
            self.buffer.clear()
            self.disabled = True
            return
        while self.buffer:
            if self.buffer.startswith(b"Content-Length:"):
                header = self.buffer.find(b"\r\n\r\n")
                if header < 0:
                    break
                length = int(bytes(self.buffer[:header]).split(b"\r\n")[0].split(b":", 1)[1])
                count = header + 4 + length
                if length < 0 or count > MAX_BODY:
                    raise ValueError("capture_frame_limit")
                if len(self.buffer) < count:
                    break
            else:
                newline = self.buffer.find(b"\n")
                if newline < 0:
                    break
                count = newline + 1
            raw = bytes(self.buffer[:count])
            del self.buffer[:count]
            source = self.source
            request = None
            try:
                value = json.loads(raw.split(b"\r\n\r\n", 1)[-1])
                if isinstance(value, dict):
                    identity = value.get("id")
                    if isinstance(identity, (str, int)):
                        request = str(identity) if len(str(identity)) <= 256 else None
                    item = value.get("item", {})
                    if source == "process-stdio" and (value.get("type") in ("tool_execution_start", "tool_execution_end", "tool_call", "tool_result") or isinstance(item, dict) and item.get("type") in ("command_execution", "mcp_tool_call")):
                        source = "native-hook"
                    if source == "process-stdio" and request is not None:
                        pending = self.cfg.setdefault("_tool_requests", set())
                        if value.get("method") == "item/tool/call":
                            pending.add(("stdin" if self.direction == "stdout" else "stdout", request))
                            source = "native-hook"
                        elif "method" not in value and (self.direction, request) in pending:
                            pending.remove((self.direction, request))
                            source = "native-hook"
            except (ValueError, UnicodeError):
                pass
            if source == "native-hook":
                one(self.cfg, source, self.direction, raw, self.metadata, request)
        if end and self.buffer:
            gap(self.cfg, "partial_source")
            self.buffer.clear()

def transfer(cfg, source, direction, incoming, outgoing, metadata):
    recorder = NativeLines(cfg, source, direction, metadata)
    try:
        stream_record = Record(cfg, source, direction, metadata)
    except Exception:
        gap(cfg, "source_unavailable")
        stream_record = None
    try:
        while True:
            data = os.read(incoming.fileno(), 65536)
            if not data:
                break
            try:
                if stream_record:
                    stream_record.append(data)
            except Exception:
                gap(cfg, "source_unavailable")
            outgoing.write(data)
            outgoing.flush()
            try:
                if source == "process-stdio":
                    recorder.feed(data)
            except Exception:
                gap(cfg, "source_unavailable")
        if source == "process-stdio":
            recorder.feed(b"", True)
        if stream_record:
            stream_record.finish()
    except (BrokenPipeError, OSError):
        gap(cfg, "partial_source")
        if stream_record:
            stream_record.finish("interrupted")
    finally:
        if direction == "stdin":
            outgoing.close()

def safe_url(value):
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ""
    if ":" in host:
        host = "[" + host + "]"
    if parsed.port is not None:
        host += ":" + str(parsed.port)
    return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))

def headers(value):
    return [[name, "[REDACTED]" if SECRET.match(name) else item] for name, item in value.items(multi=True)]

class CaptureAddon:
    def __init__(self, cfg):
        self.cfg = cfg
        encryption_key(cfg)
        self.records = {}
        self.sequences = {}
        self.websockets = set()
        self.root_dead = False
        root = int(os.environ["BB_PRIVATE_CAPTURE_ROOT_PID"])
        self.pidfd = os.pidfd_open(root) if sys.platform.startswith("linux") else None
        self.kqueue = select.kqueue() if sys.platform == "darwin" else None
        if self.kqueue:
            self.kqueue.control([select.kevent(root, filter=select.KQ_FILTER_PROC, flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT, fflags=select.KQ_NOTE_EXIT)], 0, 0)
        if self.pidfd is None and self.kqueue is None:
            raise ValueError("process_lifetime_watcher_unavailable")

    def running(self):
        atomic(os.environ["BB_PRIVATE_CAPTURE_READY"], {"session": os.environ["BB_PRIVATE_CAPTURE_SESSION"]})

    def owned(self, flow):
        if self.pidfd is not None and select.select([self.pidfd], [], [], 0)[0]:
            self.root_dead = True
        if self.kqueue and self.kqueue.control([], 1, 0):
            self.root_dead = True
        if self.root_dead:
            return False
        if self.cfg["policy"]["network"] == "local-pid":
            return True
        return flow.metadata.get("proxyauth") == (self.cfg["captureId"], os.environ["BB_PRIVATE_CAPTURE_PROXY_PASSWORD"])

    def begin(self, flow, direction):
        if not self.owned(flow):
            return
        message = flow.request if direction == "request" else flow.response
        message.stream = True
        metadata = {"url": safe_url(flow.request.pretty_url), "method": flow.request.method, "httpVersion": message.http_version, "headers": headers(message.headers), "contentEncoding": message.headers.get("content-encoding", "identity"), "status": None if direction == "request" else flow.response.status_code, "tlsVersion": flow.server_conn.tls_version, "cipher": flow.server_conn.cipher, "alpn": None if flow.server_conn.alpn is None else flow.server_conn.alpn.decode("ascii", "replace")}
        try:
            record = Record(self.cfg, "mitmproxy", direction, metadata, flow.id, "sse" if "text/event-stream" in message.headers.get("content-type", "") else "http")
        except Exception:
            gap(self.cfg, "source_unavailable")
            return
        self.records[(flow.id, direction)] = record
        def observe(data):
            try:
                record.append(data)
            except Exception:
                gap(self.cfg, "source_unavailable")
            return data
        message.stream = observe

    def requestheaders(self, flow):
        self.begin(flow, "request")

    def responseheaders(self, flow):
        self.begin(flow, "response")

    def request(self, flow):
        record = self.records.pop((flow.id, "request"), None)
        if record:
            record.finish()

    def response(self, flow):
        record = self.records.pop((flow.id, "response"), None)
        if record:
            record.finish()

    def error(self, flow):
        for direction in ("request", "response"):
            record = self.records.pop((flow.id, direction), None)
            if record:
                record.finish("interrupted")
        if self.owned(flow):
            one(self.cfg, "mitmproxy", "lifecycle", b"{}", {"url": safe_url(flow.request.pretty_url), "outcome": "transport-error"}, flow.id)
            gap(self.cfg, "partial_source")

    def websocket_start(self, flow):
        if self.owned(flow):
            self.websockets.add(flow.id)

    def websocket_message(self, flow):
        if not self.owned(flow):
            return
        message = flow.websocket.messages[-1]
        sequence = self.sequences.get(flow.id, 0)
        self.sequences[flow.id] = sequence + 1
        record = Record(self.cfg, "mitmproxy", "websocket-client" if message.from_client else "websocket-server", {"url": safe_url(flow.request.pretty_url), "messageType": int(message.type)}, flow.id, "websocket", sequence)
        record.append(message.content)
        record.finish()
        flow.websocket.messages.clear()

    def websocket_end(self, flow):
        if flow.id in self.websockets:
            one(self.cfg, "mitmproxy", "lifecycle", b"{}", {"url": safe_url(flow.request.pretty_url), "websocketCloseCode": flow.websocket.close_code, "closedByClient": flow.websocket.closed_by_client}, flow.id)
        self.sequences.pop(flow.id, None)
        self.websockets.discard(flow.id)

    def done(self):
        for record in self.records.values():
            record.finish("interrupted")
        self.records.clear()
        if self.websockets:
            gap(self.cfg, "partial_source")
        self.websockets.clear()
        if self.pidfd is not None:
            os.close(self.pidfd)
        if self.kqueue:
            self.kqueue.close()

def require_dependency(cfg):
    try:
        if sys.version_info < (3, 12):
            raise ValueError("python_version_unavailable")
        if cfg["policy"].get("mitmdump") and os.environ.get("BB_PRIVATE_CAPTURE_ADDON") != "1":
            result = subprocess.run([cfg["policy"]["mitmdump"], "--version"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10, check=True)
            if not re.search(rb"(?m)^Mitmproxy:\s+12\.3\.1(?:\s|$)", result.stdout):
                raise ValueError("mitmproxy_version_mismatch")
        elif importlib.metadata.version("mitmproxy") != PIN:
            raise ValueError("mitmproxy_version_mismatch")
    except (importlib.metadata.PackageNotFoundError, ValueError, OSError, subprocess.SubprocessError):
        phase(cfg, "dependency_unavailable")
        return False
    return True

def proxy(cfg, mode, port):
    if not require_dependency(cfg):
        return 78
    from mitmproxy.tools.main import mitmdump
    sys.argv = ["mitmdump", "--mode", mode, "--listen-host", "127.0.0.1", "--listen-port", str(port), "--set", "confdir=" + os.environ["BB_PRIVATE_CAPTURE_CA_DIR"], "--set", "ssl_insecure=false", "--set", "termlog_verbosity=error", "--set", "flow_detail=0", "--scripts", os.path.realpath(__file__)]
    os.environ["BB_PRIVATE_CAPTURE_ADDON"] = "1"
    mitmdump()
    return 0

def run(cfg, argv):
    if not argv:
        phase(cfg, "source_unavailable")
        return 78
    if not allowed(cfg):
        phase(cfg, "lease_expired")
        return 78
    if not require_dependency(cfg):
        return 78
    try:
        encryption_key(cfg)
        ephemeral = cfg["ephemeralRoot"]
        if sys.platform.startswith("linux"):
            memory_filesystem(ephemeral)
        if os.path.realpath(ephemeral) != ephemeral or not os.path.isdir(ephemeral):
            raise ValueError("capture_ephemeral_storage_unavailable")
    except Exception:
        phase(cfg, "source_unavailable")
        return 78
    lock = os.open(os.path.join(cfg["runtime"], "run.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(lock)
        phase(cfg, "source_unavailable")
        return 78
    run_dir = tempfile.mkdtemp(prefix="bb-capture-", dir=ephemeral)
    session = str(uuid.uuid4())
    env = dict(os.environ)
    env.update({"BB_PRIVATE_CAPTURE_CONFIG": cfg["config"], "BB_PRIVATE_CAPTURE_SESSION": session, "BB_PRIVATE_CAPTURE_READY": os.path.join(run_dir, "ready.json"), "BB_PRIVATE_CAPTURE_CA_DIR": run_dir, "BB_PRIVATE_CAPTURE_PROXY_PASSWORD": uuid.uuid4().hex + uuid.uuid4().hex})
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    proxy_url = "http://" + cfg["captureId"] + ":" + env["BB_PRIVATE_CAPTURE_PROXY_PASSWORD"] + "@127.0.0.1:" + str(port)
    if cfg["policy"]["network"] == "explicit-proxy":
        if any(env.get(key) for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")):
            phase(cfg, "source_unavailable")
            os.close(lock)
            shutil.rmtree(run_dir)
            return 78
        atomic(os.path.join(run_dir, "config.yaml"), {"proxyauth": cfg["captureId"] + ":" + env["BB_PRIVATE_CAPTURE_PROXY_PASSWORD"]})
        env.update({key: proxy_url for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")})
        env.update({"NO_PROXY": "", "no_proxy": "", "NODE_USE_ENV_PROXY": "1"})
    certificate = os.path.join(run_dir, "mitmproxy-ca-cert.pem")
    env["BB_PRIVATE_CAPTURE_CA_CERT"] = certificate
    if cfg["policy"]["trust"] == "external-process-trust" and not any("@BB_PRIVATE_CAPTURE_CA_CERT@" in value for value in argv):
        phase(cfg, "source_unavailable")
        os.close(lock)
        shutil.rmtree(run_dir)
        return 78
    argv = [value.replace("@BB_PRIVATE_CAPTURE_CA_CERT@", certificate) for value in argv]
    trust = cfg["policy"]["trust"]
    if trust in ("node-extra-ca", "ssl-cert-file"):
        variable = "NODE_EXTRA_CA_CERTS" if trust == "node-extra-ca" else "SSL_CERT_FILE"
        if env.get(variable):
            phase(cfg, "source_unavailable")
            os.close(lock)
            shutil.rmtree(run_dir)
            return 78
        env[variable] = certificate
    if cfg["policy"]["native"] == "claude-hooks":
        if any(value == "--settings" or value.startswith("--settings=") for value in argv):
            phase(cfg, "source_unavailable")
            os.close(lock)
            shutil.rmtree(run_dir)
            return 78
        import shlex
        command = shlex.join([sys.executable, os.path.realpath(__file__), "hook", cfg["config"]])
        settings = os.path.join(run_dir, "claude-settings.json")
        atomic(settings, {"hooks": {name: [{"matcher": "", "hooks": [{"type": "command", "command": command}]}] for name in ("PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "SubagentStart", "SubagentStop")}})
        argv = [argv[0], "--settings", settings, *argv[1:]]
    gate_read, gate_write = os.pipe()
    env["BB_PRIVATE_CAPTURE_GATE"] = str(gate_read)
    piped = cfg["policy"]["native"] == "stdio"
    target_env = {key: value for key, value in env.items() if key not in ("BB_PRIVATE_CAPTURE_READY", "BB_PRIVATE_CAPTURE_CA_DIR", "BB_PRIVATE_CAPTURE_PROXY_PASSWORD")}
    child = subprocess.Popen([sys.executable, os.path.realpath(__file__), "target", cfg["config"], "--", *argv], env=target_env, pass_fds=(gate_read,), stdin=subprocess.PIPE if piped else None, stdout=subprocess.PIPE if piped else None)
    os.close(gate_read)
    env["BB_PRIVATE_CAPTURE_ROOT_PID"] = str(child.pid)
    cfg["_session"], cfg["_root"] = session, child.pid
    previous_handlers = {}
    def forward(number, frame):
        if child.poll() is None:
            child.send_signal(number)
    for number in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[number] = signal.signal(number, forward)
    mitm = None
    output_thread = None
    try:
        mode = "regular" if cfg["policy"]["network"] == "explicit-proxy" else "local:" + str(child.pid)
        if cfg["policy"].get("mitmdump"):
            env["BB_PRIVATE_CAPTURE_ADDON"] = "1"
            command = [cfg["policy"]["mitmdump"], "--mode", mode, "--listen-host", "127.0.0.1", "--listen-port", str(port), "--set", "confdir=" + run_dir, "--set", "ssl_insecure=false", "--set", "termlog_verbosity=error", "--set", "flow_detail=0", "--scripts", os.path.realpath(__file__)]
        else:
            command = [sys.executable, os.path.realpath(__file__), "proxy", cfg["config"], mode, str(port)]
        mitm = subprocess.Popen(command, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if mitm.poll() is not None:
                phase(cfg, "source_unavailable")
                return 78
            if os.path.exists(env["BB_PRIVATE_CAPTURE_READY"]):
                ready = json.loads(read_private(env["BB_PRIVATE_CAPTURE_READY"]))
                if ready["session"] == session and os.path.exists(certificate):
                    break
            time.sleep(0.05)
        else:
            phase(cfg, "source_unavailable")
            return 78
        phase(cfg, "running", rootPid=child.pid, processSessionId=session)
        os.write(gate_write, b"1")
        os.close(gate_write)
        gate_write = None
        if piped:
            threading.Thread(target=transfer, args=(cfg, "process-stdio", "stdin", sys.stdin.buffer, child.stdin, {"native": True}), daemon=True).start()
            output_thread = threading.Thread(target=transfer, args=(cfg, "process-stdio", "stdout", child.stdout, sys.stdout.buffer, {"native": True}))
            output_thread.start()
        while child.poll() is None:
            if mitm.poll() is not None:
                gap(cfg, "partial_source")
                break
            time.sleep(0.1)
        code = child.wait()
        if output_thread:
            output_thread.join()
        phase(cfg, "exited", rootPid=child.pid, processSessionId=session, exitCode=code)
        return code
    finally:
        if gate_write is not None:
            os.close(gate_write)
        if child.poll() is None:
            child.terminate()
            child.wait()
        if mitm and mitm.poll() is None:
            mitm.terminate()
            try:
                mitm.wait(timeout=10)
            except subprocess.TimeoutExpired:
                mitm.kill()
                mitm.wait()
                gap(cfg, "partial_source")
        for number, handler in previous_handlers.items():
            signal.signal(number, handler)
        shutil.rmtree(run_dir)
        os.close(lock)

def decode_body(cfg, identity, interrupted):
    identity = str(uuid.UUID(identity))
    try:
        from compression import zstd
    except ImportError:
        from backports import zstd
    remaining = read_encrypted(cfg, identity + ".body", MAX_BODY, interrupted)
    pieces = []
    total = 0
    while remaining:
        decoder = zstd.ZstdDecompressor()
        part = decoder.decompress(remaining, max_length=MAX_BODY + 1 - total)
        total += len(part)
        if total > MAX_BODY:
            return 65
        pieces.append(part)
        if not decoder.eof:
            if not interrupted:
                return 78
            break
        remaining = decoder.unused_data
    lock = os.open(os.path.join(cfg["hostRoot"], "process-sources.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not admit(cfg, total):
            return 65
        atomic_bytes(os.path.join(cfg["sources"], identity + ".decoded"), b"".join(pieces), cfg)
    finally:
        os.close(lock)
    return 0

def main():
    os.umask(0o077)
    mode, path = sys.argv[1:3]
    cfg = load(os.path.realpath(path))
    if mode == "decode":
        return decode_body(cfg, sys.argv[3], sys.argv[4] == "interrupted")
    if mode == "proxy":
        return proxy(cfg, sys.argv[3], int(sys.argv[4]))
    if mode == "target":
        gate = int(os.environ.pop("BB_PRIVATE_CAPTURE_GATE"))
        token = os.read(gate, 1)
        os.close(gate)
        if token != b"1":
            return 78
        os.environ["BB_PRIVATE_CAPTURE_ROOT_PID"] = str(os.getpid())
        os.execvpe(sys.argv[4], sys.argv[4:], dict(os.environ))
    if mode == "run":
        return run(cfg, sys.argv[4:])
    if mode == "hook":
        try:
            data = sys.stdin.buffer.read(MAX_BODY + 1)
            if len(data) > MAX_BODY:
                gap(cfg, "quota")
            else:
                one(cfg, "native-hook", "tool", data, {"native": "claude-hook"})
        except Exception:
            gap(cfg, "source_unavailable")
        return 0
    if mode == "mcp":
        context(cfg)
        encryption_key(cfg)
        child = subprocess.Popen(sys.argv[4:], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        threading.Thread(target=transfer, args=(cfg, "mcp-stdio", "stdin", sys.stdin.buffer, child.stdin, {"mcpServerPid": child.pid}), daemon=True).start()
        output = threading.Thread(target=transfer, args=(cfg, "mcp-stdio", "stdout", child.stdout, sys.stdout.buffer, {"mcpServerPid": child.pid}))
        output.start()
        previous = {}
        def forward_mcp(number, frame):
            if child.poll() is None:
                child.send_signal(number)
        for number in (signal.SIGINT, signal.SIGTERM):
            previous[number] = signal.signal(number, forward_mcp)
        try:
            code = child.wait()
            output.join()
            return code
        finally:
            if child.poll() is None:
                child.terminate()
                child.wait()
            for number, handler in previous.items():
                signal.signal(number, handler)
    raise ValueError("unknown_capture_mode")

if os.environ.get("BB_PRIVATE_CAPTURE_ADDON") == "1":
    addons = [CaptureAddon(load(os.environ["BB_PRIVATE_CAPTURE_CONFIG"]))]
elif __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.stderr.write("Private capture prerequisite, scope or storage failure. Inspect the scoped capture status.\n")
        sys.exit(78)
`;
