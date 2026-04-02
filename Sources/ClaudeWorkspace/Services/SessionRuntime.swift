import Darwin
import Foundation

struct PTYPair {
    let master: FileHandle
    let slave: FileHandle
}

enum PTYFactory {
    static func open(columns: UInt16 = 140, rows: UInt16 = 42) throws -> PTYPair {
        var masterFD: Int32 = 0
        var slaveFD: Int32 = 0
        var windowSize = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)

        guard openpty(&masterFD, &slaveFD, nil, nil, &windowSize) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }

        return PTYPair(
            master: FileHandle(fileDescriptor: masterFD, closeOnDealloc: true),
            slave: FileHandle(fileDescriptor: slaveFD, closeOnDealloc: true)
        )
    }

    static func resize(fileDescriptor: Int32, columns: UInt16, rows: UInt16) {
        var windowSize = winsize(ws_row: rows, ws_col: columns, ws_xpixel: 0, ws_ypixel: 0)
        _ = ioctl(fileDescriptor, TIOCSWINSZ, &windowSize)
    }
}

final class SessionRuntime: @unchecked Sendable {
    let sessionID: UUID
    var onOutput: ((Data) -> Void)?
    var onExit: ((Int32) -> Void)?

    private let process = Process()
    private let masterHandle: FileHandle
    private let slaveHandle: FileHandle
    private let readQueue: DispatchQueue
    private var readSource: DispatchSourceRead?
    private var processGroupID: pid_t?

    init(sessionID: UUID, executablePath: String, arguments: [String] = [], currentDirectoryURL: URL) throws {
        self.sessionID = sessionID
        let pty = try PTYFactory.open()
        masterHandle = pty.master
        slaveHandle = pty.slave
        readQueue = DispatchQueue(label: "ClaudeWorkspace.SessionRuntime.\(sessionID.uuidString)")

        if executablePath.contains("/") {
            process.executableURL = URL(fileURLWithPath: executablePath)
            process.arguments = arguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [executablePath] + arguments
        }

        process.currentDirectoryURL = currentDirectoryURL
        process.standardInput = slaveHandle
        process.standardOutput = slaveHandle
        process.standardError = slaveHandle
        process.environment = {
            var environment = ProcessInfo.processInfo.environment
            environment["TERM"] = "xterm-256color"
            return environment
        }()
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                self?.onExit?(process.terminationStatus)
            }
        }
    }

    func start() throws {
        try process.run()
        let groupID = getpgid(process.processIdentifier)
        if groupID > 0 {
            processGroupID = groupID
        }
        try? slaveHandle.close()

        let source = DispatchSource.makeReadSource(
            fileDescriptor: masterHandle.fileDescriptor,
            queue: readQueue
        )

        source.setEventHandler { [weak self] in
            guard let self else {
                return
            }

            let amountToRead = max(Int(source.data), 1)
            var buffer = [UInt8](repeating: 0, count: min(amountToRead, 4096))
            let bytesRead = Darwin.read(self.masterHandle.fileDescriptor, &buffer, buffer.count)

            guard bytesRead > 0 else {
                return
            }

            let data = Data(buffer.prefix(Int(bytesRead)))
            DispatchQueue.main.async {
                self.onOutput?(data)
            }
        }

        source.resume()
        readSource = source
    }

    func send(_ string: String) {
        guard process.isRunning else {
            return
        }

        let data = Data(string.utf8)
        data.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress else {
                return
            }

            _ = Darwin.write(masterHandle.fileDescriptor, baseAddress, buffer.count)
        }
    }

    func sendBinary(_ string: String) {
        guard process.isRunning else {
            return
        }

        let bytes = string.unicodeScalars.map { UInt8(truncatingIfNeeded: $0.value) }
        bytes.withUnsafeBytes { buffer in
            guard let baseAddress = buffer.baseAddress else {
                return
            }

            _ = Darwin.write(masterHandle.fileDescriptor, baseAddress, buffer.count)
        }
    }

    func resize(columns: UInt16, rows: UInt16) {
        PTYFactory.resize(
            fileDescriptor: masterHandle.fileDescriptor,
            columns: columns,
            rows: rows
        )
    }

    func stop() {
        guard process.isRunning else {
            return
        }

        if let processGroupID, killpg(processGroupID, SIGTERM) == 0 {
            return
        }

        process.terminate()
    }
}
