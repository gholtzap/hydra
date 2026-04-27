import codecs
import fcntl
import json
import os
import pty
import selectors
import signal
import subprocess
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


def create_session(message):
    session_id = message["sessionId"]
    shell_path = message.get("shellPath") or os.environ.get("SHELL") or "/bin/zsh"
    cwd = os.path.abspath(message["cwd"])
    cols = int(message.get("cols") or 140)
    rows = int(message.get("rows") or 42)
    command = message.get("command")
    master_fd = None
    slave_fd = None

    try:
        master_fd, slave_fd = pty.openpty()
        set_window_size(slave_fd, cols, rows)

        environment = dict(os.environ)
        environment["TERM"] = "xterm-256color"
        provided_environment = message.get("env")
        if isinstance(provided_environment, dict):
            for key, value in provided_environment.items():
                if isinstance(key, str) and isinstance(value, str):
                    environment[key] = value

        argv = command if command else [shell_path, "-il"]

        def set_ctty():
            fcntl.ioctl(slave_fd, TIOCSCTTY, 0)

        proc = subprocess.Popen(
            argv,
            cwd=cwd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            env=environment,
            close_fds=True,
            start_new_session=True,
            preexec_fn=set_ctty
        )
    except Exception as error:
        if slave_fd is not None:
            try:
                os.close(slave_fd)
            except OSError:
                pass

        if master_fd is not None:
            try:
                os.close(master_fd)
            except OSError:
                pass

        failed_command = command[0] if isinstance(command, list) and len(command) > 0 else shell_path
        if isinstance(error, FileNotFoundError):
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
            exit_code = 1

        send({
            "type": "exit",
            "sessionId": session_id,
            "exitCode": exit_code,
            "signal": None
        })
        return

    os.close(slave_fd)

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

    try:
        os.close(master_fd)
    except OSError:
        pass


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
