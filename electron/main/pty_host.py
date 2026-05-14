import codecs
import errno
import fcntl
import json
import os
import pty
import selectors
import signal
import sys
import termios
import threading


# TIOCSCTTY: set the controlling terminal for a process.
# Required so that /dev/tty works for TUI programs (lazygit, vim, htop, etc.)
# spawned via subprocess with start_new_session=True (which calls setsid()).
TIOCSCTTY = getattr(termios, "TIOCSCTTY", 0x20007461 if sys.platform == "darwin" else 0x540E)


selector = selectors.DefaultSelector()
selector.register(sys.stdin, selectors.EVENT_READ, "stdin")
sessions = {}
sessions_lock = threading.Lock()
# Session IDs are reused when an agent falls back to a shell. Versions keep
# stale wait/read events from touching the replacement PTY.
session_versions = {}
next_session_version = 0
send_lock = threading.Lock()
pending = ""
stdin_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")


class LaunchError(Exception):
    def __init__(self, message, exit_code):
        super().__init__(message)
        self.exit_code = exit_code


class PtyProcess:
    def __init__(self, pid):
        self.pid = pid
        self.returncode = None
        self.wait_lock = threading.Lock()

    def wait(self):
        with self.wait_lock:
            if self.returncode is None:
                _, status = os.waitpid(self.pid, 0)
                self.returncode = os.waitstatus_to_exitcode(status)
            return self.returncode

    def poll(self):
        with self.wait_lock:
            if self.returncode is not None:
                return self.returncode

            try:
                result_pid, status = os.waitpid(self.pid, os.WNOHANG)
            except ChildProcessError:
                self.returncode = 0
                return self.returncode

            if result_pid == 0:
                return None

            self.returncode = os.waitstatus_to_exitcode(status)
            return self.returncode


def send(payload):
    with send_lock:
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


def set_window_size(fd, cols, rows):
    size = termios.tcsetwinsize if hasattr(termios, "tcsetwinsize") else None
    if size is not None:
        size(fd, (rows, cols))
        return

    import struct

    winsz = struct.pack("HHHH", rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsz)


def close_fd(fd):
    try:
        os.close(fd)
    except OSError:
        pass


def set_close_on_exec(fd):
    flags = fcntl.fcntl(fd, fcntl.F_GETFD)
    fcntl.fcntl(fd, fcntl.F_SETFD, flags | fcntl.FD_CLOEXEC)


def encode_child_launch_error(error):
    if isinstance(error, FileNotFoundError):
        exit_code = 127
    else:
        exit_code = 1

    return f"{exit_code}\n{error}".encode("utf-8", errors="replace")


def decode_child_launch_error(payload):
    decoded = payload.decode("utf-8", errors="replace")
    exit_code_text, _, message = decoded.partition("\n")
    try:
        exit_code = int(exit_code_text)
    except ValueError:
        exit_code = 1

    return LaunchError(message or "Unknown launch error.", exit_code)


def resolve_executable(command, environment):
    if os.path.dirname(command):
        return command

    path_value = environment.get("PATH") or os.defpath
    permission_denied = None
    for directory in path_value.split(os.pathsep):
        if not directory:
            directory = os.curdir
        candidate = os.path.join(directory, command)
        if os.access(candidate, os.X_OK) and not os.path.isdir(candidate):
            return candidate
        if os.path.exists(candidate) and permission_denied is None:
            permission_denied = PermissionError(errno.EACCES, os.strerror(errno.EACCES), command)

    if permission_denied is not None:
        raise permission_denied
    raise FileNotFoundError(errno.ENOENT, os.strerror(errno.ENOENT), command)


def spawn_pty_process(argv, cwd, environment, cols, rows):
    # Avoid subprocess preexec_fn here: this host has wait threads, and
    # running Python hooks after fork can deadlock before exec.
    master_fd = None
    slave_fd = None
    error_read_fd = None
    error_write_fd = None
    executable = resolve_executable(argv[0], environment)

    try:
        master_fd, slave_fd = pty.openpty()
        set_window_size(slave_fd, cols, rows)
        error_read_fd, error_write_fd = os.pipe()
        set_close_on_exec(error_write_fd)

        pid = os.fork()
    except Exception:
        for fd in (master_fd, slave_fd, error_read_fd, error_write_fd):
            if fd is not None:
                close_fd(fd)
        raise

    if pid == 0:
        try:
            if error_read_fd is not None:
                close_fd(error_read_fd)
            if master_fd is not None:
                close_fd(master_fd)

            os.setsid()
            fcntl.ioctl(slave_fd, TIOCSCTTY, 0)

            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                close_fd(slave_fd)

            os.chdir(cwd)
            os.execve(executable, argv, environment)
        except BaseException as error:
            try:
                os.write(error_write_fd, encode_child_launch_error(error))
            except OSError:
                pass
            os._exit(127 if isinstance(error, FileNotFoundError) else 1)

    close_fd(slave_fd)
    slave_fd = None
    close_fd(error_write_fd)
    error_write_fd = None

    try:
        child_error = os.read(error_read_fd, 4096)
    finally:
        close_fd(error_read_fd)
        error_read_fd = None

    if child_error:
        close_fd(master_fd)
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        raise decode_child_launch_error(child_error)

    return PtyProcess(pid), master_fd


def create_session(message):
    session_id = message["sessionId"]
    shell_path = message.get("shellPath") or os.environ.get("SHELL") or "/bin/zsh"
    cwd = os.path.abspath(message["cwd"])
    cols = int(message.get("cols") or 140)
    rows = int(message.get("rows") or 42)
    command = message.get("command")
    master_fd = None

    try:
        environment = dict(os.environ)
        environment["TERM"] = "xterm-256color"
        provided_environment = message.get("env")
        if isinstance(provided_environment, dict):
            for key, value in provided_environment.items():
                if isinstance(key, str) and isinstance(value, str):
                    environment[key] = value

        argv = command if command else [shell_path, "-il"]
        proc, master_fd = spawn_pty_process(argv, cwd, environment, cols, rows)
    except Exception as error:
        if master_fd is not None:
            close_fd(master_fd)

        failed_command = command[0] if isinstance(command, list) and len(command) > 0 else shell_path
        if isinstance(error, FileNotFoundError) or (
            isinstance(error, LaunchError) and error.exit_code == 127
        ):
            send({
                "type": "data",
                "sessionId": session_id,
                "data": (
                    f"Hydra could not launch '{failed_command}' because it was not found on PATH.\r\n"
                    "Use an absolute agent command path in Settings when launching the installed app.\r\n"
                )
            })
            exit_code = 127
        else:
            send({
                "type": "data",
                "sessionId": session_id,
                "data": f"Hydra failed to launch the session: {error}\r\n"
            })
            exit_code = getattr(error, "exit_code", 1)

        send({
            "type": "exit",
            "sessionId": session_id,
            "exitCode": exit_code,
            "signal": None
        })
        return

    session = {
        "proc": proc,
        "master_fd": master_fd,
        "decoder": codecs.getincrementaldecoder("utf-8")(errors="replace"),
        "version": None
    }

    global next_session_version
    with sessions_lock:
        old_session = sessions.get(session_id)
        if old_session:
            close_session_resources(old_session)

        next_session_version += 1
        version = next_session_version
        session["version"] = version
        session_versions[session_id] = version
        sessions[session_id] = session
        selector.register(master_fd, selectors.EVENT_READ, ("session", session_id, version))

    send({
        "type": "created",
        "sessionId": session_id
    })

    def wait_for_exit():
        exit_code = proc.wait()
        cleanup_session(session_id, send_exit=False, expected_version=version)
        with sessions_lock:
            is_current_version = session_versions.get(session_id) == version
        if is_current_version:
            send({
                "type": "exit",
                "sessionId": session_id,
                "exitCode": exit_code,
                "signal": None
            })

    threading.Thread(target=wait_for_exit, daemon=True).start()


def current_session(session_id, expected_version=None):
    with sessions_lock:
        session = sessions.get(session_id)
        if not session:
            return None
        if expected_version is not None and session.get("version") != expected_version:
            return None
        return session


def handle_input(message):
    session = current_session(message["sessionId"])
    if not session:
        return

    data = (message.get("data") or "").encode("utf-8", errors="replace")
    if data:
        try:
            os.write(session["master_fd"], data)
        except OSError:
            pass


def handle_resize(message):
    session = current_session(message["sessionId"])
    if not session:
        return

    cols = int(message.get("cols") or 1)
    rows = int(message.get("rows") or 1)
    try:
        set_window_size(session["master_fd"], cols, rows)
    except OSError:
        pass


def kill_session(session_id):
    session = current_session(session_id)
    if not session:
        return

    proc = session["proc"]
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except ProcessLookupError:
        pass

    cleanup_session(session_id, send_exit=False, expected_version=session["version"])


def close_session_resources(session):
    master_fd = session["master_fd"]
    try:
        selector.unregister(master_fd)
    except Exception:
        pass

    close_fd(master_fd)


def cleanup_session(session_id, send_exit, expected_version=None):
    with sessions_lock:
        session = sessions.get(session_id)
        if not session:
            return False
        if expected_version is not None and session.get("version") != expected_version:
            return False

        sessions.pop(session_id, None)
        close_session_resources(session)

    if send_exit:
        send({
            "type": "exit",
            "sessionId": session_id,
            "exitCode": session["proc"].poll() or 0,
            "signal": None
        })
    return True


def handle_message(line):
    try:
        message = json.loads(line)
    except json.JSONDecodeError as error:
        send({"type": "error", "error": f"Invalid message: {error}"})
        return

    kind = message.get("type")

    if kind == "create":
        create_session(message)
        return
    if kind == "input":
        handle_input(message)
        return
    if kind == "resize":
        handle_resize(message)
        return
    if kind == "kill":
        kill_session(message["sessionId"])
        return
    if kind == "shutdown":
        shutdown()
        return

    send({"type": "error", "error": f"Unknown message type: {kind}"})


def read_stdin():
    global pending
    chunk = os.read(sys.stdin.fileno(), 4096)
    if not chunk:
        pending += stdin_decoder.decode(b"", final=True)
        shutdown()
        return

    pending += stdin_decoder.decode(chunk, final=False)

    while "\n" in pending:
        line, pending = pending.split("\n", 1)
        line = line.strip()
        if line:
            handle_message(line)


def read_session(session_id, expected_version):
    session = current_session(session_id, expected_version)
    if not session:
        return

    try:
        data = os.read(session["master_fd"], 4096)
    except OSError:
        data = b""

    if not data:
        tail = session["decoder"].decode(b"", final=True)
        if tail:
            send({
                "type": "data",
                "sessionId": session_id,
                "data": tail
            })
        return

    send({
        "type": "data",
        "sessionId": session_id,
        "data": session["decoder"].decode(data, final=False)
    })


def shutdown():
    with sessions_lock:
        session_ids = list(sessions.keys())

    for session_id in session_ids:
        kill_session(session_id)
    raise SystemExit(0)


def main():
    signal.signal(signal.SIGTERM, lambda *_: shutdown())
    signal.signal(signal.SIGINT, lambda *_: shutdown())

    while True:
        for key, _ in selector.select():
            if key.data == "stdin":
                read_stdin()
                continue

            kind, session_id, version = key.data
            if kind == "session":
                read_session(session_id, version)


if __name__ == "__main__":
    main()
