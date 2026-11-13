#!/usr/bin/env python3
# cc-remote's relay: keeps a session's claude running on this host across dropped ssh connections.
#
# Python 3.6 or later, standard library only. cc-remote copies this file to
# ~/.cc-remote/bin/relay-<hash>.py and runs it with `python3 -S`:
#
#   relay run <id> [--session <session id>] [--grace <s>] [--idle <s>] -- <command...>
#       Starts a daemon that runs the command (claude) with pipes, in a process group of its own,
#       and listens on ~/.cc-remote/run/<id>/s; then becomes a bridge between this process's
#       stdin/stdout (the ssh channel) and that socket.
#   relay attach <id>
#       A bridge to the daemon of an earlier `run`, for a reconnect. Exits with GONE when there
#       is no such daemon.
#   relay reap <session id>
#       Stops the daemons recorded for that session, claude and all, and waits for them: a new
#       claude for the same session must not write its transcript beside an old one.
#
# The bridge only copies bytes. The daemon and cc-remote speak in frames: a header of type (1
# byte), value (8 bytes) and payload length (4 bytes), big-endian, then the payload. Byte offsets
# are the sequence numbers: the daemon keeps claude's output until cc-remote acknowledges it and
# replays the rest after a reconnect; cc-remote does the same with claude's input. See relay.ts.
#
# Kept stable across versions, since a newer cc-remote may reap the daemon of an older one: the
# run folder's layout (`s`, `pid`, `session`, `host`) and the daemon stopping everything on SIGTERM.
import errno
import json
import os
import queue
import select
import signal
import socket
import struct
import subprocess
import sys
import threading
import time
import traceback

HEADER = struct.Struct(">BQI")

# Daemon to cc-remote.
OUT, ERR, IN_ACK, PONG, HELLO, EXIT, RESULT, FATAL = 1, 2, 3, 4, 5, 6, 7, 8
# cc-remote to daemon.
IN, OUT_ACK, PING, CHELLO, CLOSE_IN, TERM, BYE, EXEC = 16, 17, 18, 19, 20, 21, 22, 23

PROTOCOL = 1
# What attach exits with, and prints on stderr, when there is no daemon to attach to.
GONE = 3
GONE_TOKEN = "cc-remote-relay-v1-gone"

CHUNK = 64 << 10
# Unacknowledged output kept for a reconnect; past this, claude's output waits.
OUT_CAP = 64 << 20
# stderr kept while no one is attached; the oldest goes first.
ERR_CAP = 1 << 20
MAX_FRAME = 64 << 20
# Output queued on a connection before more is framed.
SEND_AHEAD = 256 << 10
KILL_AFTER = 5.0
# A connection that hasn't said hello by then is dropped.
HELLO_WAIT = 15.0
EXEC_TIMEOUT = 120
# Results of finished host commands kept for a resent request, the small ones only.
RESULTS_KEPT = 32
RESULT_KEPT_MAX = 64 << 10


def run_root():
    return os.path.join(os.path.expanduser("~"), ".cc-remote", "run")


def valid_id(value):
    return 0 < len(value) <= 64 and all(c.isalnum() or c in "-_" for c in value)


def ours(path):
    """Whether a run folder belongs to this machine: a home shared between machines has others'."""
    owner = read_text(os.path.join(path, "host"))
    return not owner or owner == socket.gethostname()


def write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        view = view[n:]


def frame(kind, value, payload=b""):
    return HEADER.pack(kind, value, len(payload)) + payload


def remove_tree(path):
    try:
        names = os.listdir(path)
    except OSError:
        return
    for name in names:
        try:
            os.unlink(os.path.join(path, name))
        except OSError:
            pass
    try:
        os.rmdir(path)
    except OSError:
        pass


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except OSError as e:
        return e.errno == errno.EPERM


def read_text(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except (OSError, ValueError):
        return ""


def write_text(path, text):
    temp = path + ".tmp"
    with open(temp, "w") as f:
        f.write(text + "\n")
    os.rename(temp, path)


def connect(path):
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(path)
    except OSError:
        sock.close()
        raise
    return sock


def bridge(sock):
    """Copies the ssh channel (stdin, stdout) to and from the daemon until either side ends."""

    def up():
        try:
            while True:
                data = os.read(0, CHUNK)
                if not data:
                    break
                sock.sendall(data)
        except OSError:
            pass
        os._exit(0)

    thread = threading.Thread(target=up)
    thread.daemon = True
    thread.start()
    try:
        while True:
            data = sock.recv(CHUNK)
            if not data:
                break
            write_all(1, data)
    except OSError:
        pass
    os._exit(0)


def close_inherited(keep):
    """Every fd but `keep`: sshd waits for the channel's pipes to close, whoever holds them."""
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        if fd != null:
            os.dup2(null, fd)
    if null > 2:
        os.close(null)
    fds = None
    for listing in ("/proc/self/fd", "/dev/fd"):
        try:
            fds = [int(n) for n in os.listdir(listing)]
            break
        except (OSError, ValueError):
            pass
    if fds is None:
        try:
            limit = min(os.sysconf("SC_OPEN_MAX"), 65536)
        except (ValueError, OSError):
            limit = 1024
        fds = range(3, limit)
    for fd in fds:
        if fd > 2 and fd not in keep:
            try:
                os.close(fd)
            except OSError:
                pass


class Conn(object):
    def __init__(self, sock, now):
        self.sock = sock
        self.rbuf = bytearray()
        self.wbuf = bytearray()
        self.ready = False
        self.opened = now
        self.last = now
        self.sent = 0
        self.exit_sent = False

    def fileno(self):
        return self.sock.fileno()

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Daemon(object):
    def __init__(self, folder, lsock, command, cwd, session, grace, idle):
        self.folder = folder
        self.lsock = lsock
        self.command = command
        self.cwd = cwd
        self.session = session
        self.grace = grace
        self.idle = idle
        now = time.monotonic()
        self.conn = None
        self.waiting = []  # connections that haven't said hello yet
        self.detached_at = now
        # claude's output: out_buf holds the bytes from out_base on, unacknowledged.
        self.out_buf = bytearray()
        self.out_base = 0
        self.out_eof = False
        self.err_pending = bytearray()
        self.err_offset = 0
        self.err_eof = False
        # claude's input: in_recv bytes accepted so far, in_pending of them not yet written.
        self.in_recv = 0
        self.in_pending = bytearray()
        self.close_at = None
        self.ack_due = False
        self.proc = None
        self.in_fd = self.out_fd = self.err_fd = None
        self.exited_at = None
        self.status = None  # (code, signal name) once claude is gone and its output read
        self.kill_at = None
        self.terminating = False
        self.stopping = False  # SIGTERM: stop claude, then go without keeping anything
        self.bye = False
        self.results = queue.Queue()
        self.running = set()
        self.done = {}
        self.done_order = []
        self.undelivered = []
        self.wake_r, self.wake_w = os.pipe()
        os.set_blocking(self.wake_r, False)
        os.set_blocking(self.wake_w, False)

    @property
    def out_total(self):
        return self.out_base + len(self.out_buf)

    # Setup.

    def start(self):
        try:
            self.proc = self.spawn(self.command)
        except OSError as e:
            # Reported as claude's own failure would be: on stderr, then an exit.
            message = "cc-remote relay: cannot run %s: %s\n" % (self.command[0], e.strerror)
            self.proc = self.spawn([sys.executable, "-S", "-c", "import sys; sys.stderr.write(sys.argv[1]); sys.exit(127)", message])
        self.in_fd = self.proc.stdin.fileno()
        self.out_fd = self.proc.stdout.fileno()
        self.err_fd = self.proc.stderr.fileno()
        for fd in (self.in_fd, self.out_fd, self.err_fd):
            os.set_blocking(fd, False)
        self.lsock.setblocking(False)
        write_text(os.path.join(self.folder, "host"), socket.gethostname())
        write_text(os.path.join(self.folder, "pid"), str(os.getpid()))
        if self.session:
            write_text(os.path.join(self.folder, "session"), self.session)
        for sig in (signal.SIGTERM, signal.SIGINT):
            signal.signal(sig, self.on_signal)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        signal.set_wakeup_fd(self.wake_w)
        sweep(self.folder)

    def spawn(self, command):
        return subprocess.Popen(
            command, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            start_new_session=True, close_fds=True)

    def on_signal(self, signum, frame_):
        self.stopping = True

    # claude.

    def terminate(self, now):
        if self.terminating:
            return
        self.terminating = True
        self.signal_group(signal.SIGTERM)
        self.kill_at = now + KILL_AFTER

    def signal_group(self, sig):
        if self.proc is None:
            return
        try:
            os.killpg(self.proc.pid, sig)
        except OSError:
            pass

    def close_input(self):
        if self.in_fd is not None:
            try:
                self.proc.stdin.close()
            except OSError:
                pass
            self.in_fd = None
        self.in_pending = bytearray()

    def read_output(self):
        try:
            data = os.read(self.out_fd, CHUNK)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return
            data = b""
        if data:
            self.out_buf += data
        else:
            self.end_output()

    def end_output(self):
        if self.out_fd is not None:
            try:
                self.proc.stdout.close()
            except OSError:
                pass
            self.out_fd = None
            self.out_eof = True

    def read_errors(self):
        try:
            data = os.read(self.err_fd, CHUNK)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return
            data = b""
        if not data:
            self.end_errors()
            return
        if self.conn is not None and self.conn.ready:
            self.conn.wbuf += frame(ERR, self.err_offset, data)
        else:
            self.err_pending += data
            if len(self.err_pending) > ERR_CAP:
                del self.err_pending[:len(self.err_pending) - ERR_CAP]
        self.err_offset += len(data)

    def end_errors(self):
        if self.err_fd is not None:
            try:
                self.proc.stderr.close()
            except OSError:
                pass
            self.err_fd = None
            self.err_eof = True

    def write_input(self):
        try:
            n = os.write(self.in_fd, self.in_pending)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return
            # claude is gone; its exit shows up shortly.
            self.close_input()
            return
        del self.in_pending[:n]
        self.maybe_close_input()

    def maybe_close_input(self):
        if self.close_at is not None and self.in_recv >= self.close_at and not self.in_pending:
            self.close_input()

    def reap(self, now):
        if self.exited_at is None and self.proc.poll() is not None:
            self.exited_at = now
            self.close_input()
        if self.exited_at is not None and now - self.exited_at > 2.0:
            # A child of claude's that kept its output open doesn't hold the exit back.
            self.end_output()
            self.end_errors()
        if self.status is None and self.exited_at is not None and self.out_eof and self.err_eof:
            code = self.proc.returncode
            if code < 0:
                try:
                    name = signal.Signals(-code).name
                except ValueError:
                    name = "SIGKILL"
                self.status = (0, name)
            else:
                self.status = (code, "")

    # Connections.

    def accept(self, now):
        while True:
            try:
                sock, _ = self.lsock.accept()
            except OSError:
                return
            sock.setblocking(False)
            self.waiting.append(Conn(sock, now))

    def drop(self, conn, now):
        conn.close()
        if conn is self.conn:
            self.conn = None
            self.detached_at = now
        elif conn in self.waiting:
            self.waiting.remove(conn)

    def receive(self, conn, now):
        try:
            data = conn.sock.recv(1 << 20)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return
            data = b""
        if not data:
            self.drop(conn, now)
            return
        conn.last = now
        conn.rbuf += data
        while len(conn.rbuf) >= HEADER.size:
            kind, value, length = HEADER.unpack_from(conn.rbuf)
            if length > MAX_FRAME:
                self.drop(conn, now)
                return
            if len(conn.rbuf) < HEADER.size + length:
                break
            payload = bytes(conn.rbuf[HEADER.size:HEADER.size + length])
            del conn.rbuf[:HEADER.size + length]
            if not self.handle(conn, kind, value, payload, now):
                return

    def fatal(self, conn, message, now):
        try:
            conn.sock.setblocking(True)
            conn.sock.settimeout(2)
            conn.sock.sendall(bytes(conn.wbuf) + frame(FATAL, 0, message.encode()))
        except OSError:
            pass
        self.drop(conn, now)

    def handle(self, conn, kind, value, payload, now):
        """One frame; False when the connection was dropped."""
        if not conn.ready:
            if kind != CHELLO:
                self.drop(conn, now)
                return False
            if not self.out_base <= value <= self.out_total:
                self.fatal(conn, "relay: cannot resume claude's output at byte %d (have %d to %d)" % (value, self.out_base, self.out_total), now)
                return False
            if self.conn is not None:
                self.conn.close()
            self.waiting.remove(conn)
            self.conn = conn
            conn.ready = True
            conn.sent = value
            hello = json.dumps({"v": PROTOCOL, "pid": os.getpid()}).encode()
            conn.wbuf += frame(HELLO, self.in_recv, hello)
            if self.err_pending:
                conn.wbuf += frame(ERR, self.err_offset - len(self.err_pending), bytes(self.err_pending))
                self.err_pending = bytearray()
            for result in self.undelivered:
                conn.wbuf += result
            self.undelivered = []
            return True
        if kind == IN:
            if value > self.in_recv:
                self.fatal(conn, "relay: claude's input skips from byte %d to %d" % (self.in_recv, value), now)
                return False
            fresh = payload[self.in_recv - value:]
            if fresh and self.in_fd is not None and self.close_at is None:
                self.in_pending += fresh
            self.in_recv += len(fresh)
            self.ack_due = True
        elif kind == OUT_ACK:
            if self.out_base < value <= self.out_total:
                del self.out_buf[:value - self.out_base]
                self.out_base = value
        elif kind == PING:
            conn.wbuf += frame(PONG, value)
        elif kind == CLOSE_IN:
            self.close_at = value
            self.maybe_close_input()
        elif kind == TERM:
            self.terminate(now)
        elif kind == BYE:
            self.bye = True
        elif kind == EXEC:
            self.exec(conn, value, payload)
        return True

    def send(self, conn, now):
        while len(conn.wbuf) < SEND_AHEAD and conn.sent < self.out_total:
            start = conn.sent - self.out_base
            chunk = bytes(self.out_buf[start:start + CHUNK])
            conn.wbuf += frame(OUT, conn.sent, chunk)
            conn.sent += len(chunk)
        if self.status is not None and not conn.exit_sent and conn.sent == self.out_total and not self.stopping:
            code, name = self.status
            conn.wbuf += frame(EXIT, code, name.encode())
            conn.exit_sent = True
        if not conn.wbuf:
            return
        try:
            n = conn.sock.send(conn.wbuf)
        except OSError as e:
            if e.errno in (errno.EAGAIN, errno.EINTR):
                return
            self.drop(conn, now)
            return
        del conn.wbuf[:n]

    def wants_send(self, conn):
        return bool(conn.wbuf) or conn.sent < self.out_total or (self.status is not None and not conn.exit_sent)

    # Commands cc-remote runs on the host over this connection, such as reading a plan file.

    def exec(self, conn, ident, payload):
        if ident in self.running:
            return
        if ident in self.done:
            conn.wbuf += self.done[ident]
            return
        if len(payload) < 4:
            return
        (size,) = struct.unpack_from(">I", payload)
        script = payload[4:4 + size].decode("utf-8", "replace")
        data = payload[4 + size:]
        self.running.add(ident)
        thread = threading.Thread(target=self.exec_thread, args=(ident, script, data))
        thread.daemon = True
        thread.start()

    def exec_thread(self, ident, script, data):
        try:
            proc = subprocess.Popen(["/bin/sh", "-c", script], cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                out, err = proc.communicate(data, timeout=EXEC_TIMEOUT)
                code = proc.returncode
            except subprocess.TimeoutExpired:
                proc.kill()
                out, err = proc.communicate()
                code = 124
        except Exception as e:  # noqa: BLE001 - reported to cc-remote
            out, err, code = b"", str(e).encode(), 127
        if code < 0:
            code = 128 - code
        self.results.put((ident, frame(RESULT, ident, struct.pack(">iI", code, len(out)) + out + err[:4096])))
        try:
            os.write(self.wake_w, b"r")
        except OSError:
            pass

    def collect_results(self):
        while True:
            try:
                ident, result = self.results.get_nowait()
            except queue.Empty:
                return
            self.running.discard(ident)
            if len(result) <= RESULT_KEPT_MAX:
                self.done[ident] = result
                self.done_order.append(ident)
                while len(self.done_order) > RESULTS_KEPT:
                    self.done.pop(self.done_order.pop(0), None)
            if self.conn is not None and self.conn.ready:
                self.conn.wbuf += result
            else:
                self.undelivered.append(result)

    # The loop.

    def loop(self):
        while True:
            now = time.monotonic()
            self.reap(now)
            if self.stopping:
                self.terminate(now)
            if self.terminating and self.kill_at is not None and now >= self.kill_at:
                self.signal_group(signal.SIGKILL)
                self.kill_at = None
            attached = self.conn is not None and self.conn.ready
            if not attached and now - self.detached_at > self.grace:
                self.terminate(now)
            # Done once claude has finished and its output reached cc-remote (a bye), or no one
            # will come for it: cc-remote asked for the end and left, or the grace ran out.
            if self.status is not None and (self.bye or self.stopping or (not attached and (self.terminating or now - self.detached_at > self.grace))):
                return
            for conn in list(self.waiting):
                if now - conn.opened > HELLO_WAIT:
                    self.drop(conn, now)
            if attached and now - self.conn.last > self.idle:
                self.drop(self.conn, now)
                attached = False
            if attached and self.ack_due:
                self.conn.wbuf += frame(IN_ACK, self.in_recv)
                self.ack_due = False

            readers = [self.lsock, self.wake_r] + self.waiting
            writers = []
            if self.out_fd is not None and len(self.out_buf) < OUT_CAP:
                readers.append(self.out_fd)
            if self.err_fd is not None:
                readers.append(self.err_fd)
            if self.conn is not None:
                readers.append(self.conn)
                if self.conn.ready and self.wants_send(self.conn):
                    writers.append(self.conn)
            if self.in_fd is not None and self.in_pending:
                writers.append(self.in_fd)
            timeout = 1.0
            if self.exited_at is not None and self.status is None:
                timeout = 0.1
            try:
                readable, writable, _ = select.select(readers, writers, [], timeout)
            except InterruptedError:
                continue
            now = time.monotonic()
            for item in readable:
                if item is self.lsock:
                    self.accept(now)
                elif item == self.wake_r:
                    try:
                        os.read(self.wake_r, 4096)
                    except OSError:
                        pass
                    self.collect_results()
                elif item == self.out_fd:
                    self.read_output()
                elif item == self.err_fd:
                    self.read_errors()
                elif isinstance(item, Conn) and (item is self.conn or item in self.waiting):
                    self.receive(item, now)
            for item in writable:
                if item == self.in_fd and self.in_fd is not None:
                    self.write_input()
                elif item is self.conn and self.conn is not None:
                    self.send(item, now)

    def finish(self):
        """Leaves nothing behind: claude's group, the connections, the run folder."""
        if self.status is None or self.terminating:
            self.signal_group(signal.SIGKILL)
        if self.conn is not None:
            try:
                self.conn.sock.setblocking(True)
                self.conn.sock.settimeout(2)
                if self.conn.ready and self.conn.wbuf:
                    self.conn.sock.sendall(bytes(self.conn.wbuf))
            except OSError:
                pass
            self.conn.close()
        for conn in self.waiting:
            conn.close()
        try:
            self.lsock.close()
        except OSError:
            pass
        os.chdir("/")
        remove_tree(self.folder)


def sweep(own):
    """Removes the run folders of daemons that died without cleaning up, as at a reboot."""
    root = os.path.dirname(own)
    try:
        names = os.listdir(root)
    except OSError:
        return
    now = time.time()
    for name in names:
        path = os.path.join(root, name)
        if path == own or not valid_id(name) or not ours(path):
            continue
        try:
            if now - os.stat(path).st_mtime < 60:
                continue
        except OSError:
            continue
        pid = read_text(os.path.join(path, "pid"))
        if pid.isdigit() and alive(int(pid)):
            continue
        remove_tree(path)


def log_crash(folder):
    try:
        path = os.path.join(os.path.dirname(folder), "relay-errors.log")
        if os.path.exists(path) and os.path.getsize(path) > (1 << 20):
            os.unlink(path)
        with open(path, "a") as f:
            f.write("%s %s\n%s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), folder, traceback.format_exc()))
    except OSError:
        pass


def daemon(folder, lsock, command, cwd, session, grace, idle):
    close_inherited({lsock.fileno()})
    d = Daemon(folder, lsock, command, cwd, session, grace, idle)
    try:
        d.start()
        d.loop()
    except Exception:  # noqa: BLE001 - nothing else would ever see it
        log_crash(folder)
        d.terminating = True
    finally:
        d.finish()
    os._exit(0)


def parse_run(argv):
    if "--" not in argv:
        raise SystemExit("relay: run needs -- before the command")
    split = argv.index("--")
    head, command = argv[:split], argv[split + 1:]
    if not head or not command:
        raise SystemExit("relay: usage: run <id> [options] -- <command...>")
    opts = {"session": "", "grace": 1800.0, "idle": 60.0}
    ident = head[0]
    rest = head[1:]
    while rest:
        flag = rest.pop(0)
        if flag not in ("--session", "--grace", "--idle") or not rest:
            raise SystemExit("relay: unknown option %s" % flag)
        value = rest.pop(0)
        opts[flag[2:]] = value if flag == "--session" else float(value)
    if not valid_id(ident):
        raise SystemExit("relay: bad id %r" % ident)
    return ident, opts, command


def run(argv):
    ident, opts, command = parse_run(argv)
    cwd = os.getcwd()
    root = run_root()
    if not os.path.isdir(root):
        os.makedirs(root, 0o700)
    os.chmod(root, 0o700)
    folder = os.path.join(root, ident)
    os.mkdir(folder, 0o700)
    # A relative path, so a long $HOME can't overrun the 108 bytes a socket path may have.
    os.chdir(folder)
    lsock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    lsock.bind("s")
    lsock.listen(8)
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            if os.fork() != 0:
                os._exit(0)
            daemon(folder, lsock, command, cwd, opts["session"], opts["grace"], opts["idle"])
        finally:
            os._exit(1)
    os.waitpid(pid, 0)
    lsock.close()
    # Listening already, so this connects before the daemon gets to accept.
    bridge(connect("s"))


def gone(why):
    sys.stderr.write("%s %s\n" % (GONE_TOKEN, why))
    sys.stderr.flush()
    os._exit(GONE)


def attach(argv):
    if len(argv) != 1 or not valid_id(argv[0]):
        raise SystemExit("relay: usage: attach <id>")
    folder = os.path.join(run_root(), argv[0])
    try:
        os.chdir(folder)
        sock = connect("s")
    except OSError as e:
        gone("no relay for this session here (%s)" % e.strerror)
    bridge(sock)


def reap(argv):
    if len(argv) != 1:
        raise SystemExit("relay: usage: reap <session id>")
    session = argv[0]
    root = run_root()
    try:
        names = os.listdir(root)
    except OSError:
        return
    waiting = []
    for name in names:
        path = os.path.join(root, name)
        if not valid_id(name) or read_text(os.path.join(path, "session")) != session or not ours(path):
            continue
        pid = read_text(os.path.join(path, "pid"))
        # A daemon answers on its socket; connecting and leaving without a hello disturbs nothing.
        # Relative, as in run and attach: a long $HOME must not make a live daemon look dead.
        try:
            os.chdir(path)
            connect("s").close()
        except OSError:
            remove_tree(path)
            continue
        if pid.isdigit():
            try:
                os.kill(int(pid), signal.SIGTERM)
                waiting.append((int(pid), path))
            except OSError:
                remove_tree(path)
    deadline = time.monotonic() + KILL_AFTER + 3
    for pid, path in waiting:
        while alive(pid) and os.path.exists(path) and time.monotonic() < deadline:
            time.sleep(0.05)
        if not os.path.exists(path):
            continue
        if time.monotonic() >= deadline:
            sys.stderr.write("cc-remote relay: an earlier claude for session %s did not stop in time\n" % session)


def main():
    if sys.version_info < (3, 6):
        sys.stderr.write("cc-remote relay needs Python 3.6 or later\n")
        sys.exit(2)
    if len(sys.argv) < 2:
        raise SystemExit("relay: usage: run|attach|reap ...")
    command, argv = sys.argv[1], sys.argv[2:]
    if command == "run":
        run(argv)
    elif command == "attach":
        attach(argv)
    elif command == "reap":
        reap(argv)
    else:
        raise SystemExit("relay: unknown command %s" % command)


if __name__ == "__main__":
    main()
