import SwiftUI
import WebKit

private enum TerminalMessageName {
    static let ready = "terminalReady"
    static let input = "terminalInput"
    static let binaryInput = "terminalBinaryInput"
    static let resize = "terminalResize"
}

private final class TerminalMessageProxy: NSObject, WKScriptMessageHandler {
    weak var coordinator: TerminalConsoleView.Coordinator?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        coordinator?.handle(message: message)
    }
}

struct TerminalConsoleView: NSViewRepresentable {
    let sessionID: UUID
    let replayText: String
    let isLive: Bool
    let onInput: (String) -> Void
    let onBinaryInput: (String) -> Void
    let onResize: (Int, Int) -> Void

    final class Coordinator: NSObject, WKNavigationDelegate {
        var currentSessionID: UUID
        var lastReplayText = ""
        var lastIsLive = false
        var isReady = false
        weak var webView: WKWebView?

        var currentReplayText = ""
        var currentIsLive = false

        var inputHandler: (String) -> Void
        var binaryInputHandler: (String) -> Void
        var resizeHandler: (Int, Int) -> Void

        fileprivate let messageProxy = TerminalMessageProxy()

        init(
            sessionID: UUID,
            inputHandler: @escaping (String) -> Void,
            binaryInputHandler: @escaping (String) -> Void,
            resizeHandler: @escaping (Int, Int) -> Void
        ) {
            currentSessionID = sessionID
            self.inputHandler = inputHandler
            self.binaryInputHandler = binaryInputHandler
            self.resizeHandler = resizeHandler
            super.init()
            messageProxy.coordinator = self
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            self.webView = webView
            isReady = true
            syncIfPossible()
        }

        func handle(message: WKScriptMessage) {
            switch message.name {
            case TerminalMessageName.ready:
                isReady = true
                syncIfPossible()
            case TerminalMessageName.input:
                if let value = message.body as? String {
                    inputHandler(value)
                }
            case TerminalMessageName.binaryInput:
                if let value = message.body as? String {
                    binaryInputHandler(value)
                }
            case TerminalMessageName.resize:
                guard let body = message.body as? [String: Any] else {
                    return
                }

                let columns = body["cols"] as? Int ?? 0
                let rows = body["rows"] as? Int ?? 0

                guard columns > 0, rows > 0 else {
                    return
                }

                resizeHandler(columns, rows)
            default:
                return
            }
        }

        func reload(for sessionID: UUID, in webView: WKWebView, load: (WKWebView) -> Void) {
            currentSessionID = sessionID
            lastReplayText = ""
            lastIsLive = false
            isReady = false
            self.webView = webView
            load(webView)
        }

        func updateState(replayText: String, isLive: Bool) {
            currentReplayText = replayText
            currentIsLive = isLive
            syncIfPossible()
        }

        private func syncIfPossible() {
            guard let webView, isReady else {
                return
            }

            if lastIsLive != currentIsLive {
                lastIsLive = currentIsLive
                evaluate("window.terminalBridge && window.terminalBridge.setLive(\(currentIsLive ? "true" : "false"))", in: webView)
            }

            guard lastReplayText != currentReplayText else {
                if currentIsLive {
                    evaluate("window.terminalBridge && window.terminalBridge.focus()", in: webView)
                }
                return
            }

            if currentReplayText.hasPrefix(lastReplayText) {
                let delta = String(currentReplayText.dropFirst(lastReplayText.count))
                if !delta.isEmpty {
                    evaluate("window.terminalBridge && window.terminalBridge.write(\(javaScriptStringLiteral(delta)))", in: webView)
                }
            } else {
                evaluate("window.terminalBridge && window.terminalBridge.reset(\(javaScriptStringLiteral(currentReplayText)))", in: webView)
            }

            lastReplayText = currentReplayText

            if currentIsLive {
                evaluate("window.terminalBridge && window.terminalBridge.focus()", in: webView)
            }
        }

        private func evaluate(_ script: String, in webView: WKWebView) {
            webView.evaluateJavaScript(script)
        }

        private func javaScriptStringLiteral(_ value: String) -> String {
            let encoded = (try? JSONSerialization.data(withJSONObject: [value])) ?? Data(#"[""]"#.utf8)
            let arrayLiteral = String(decoding: encoded, as: UTF8.self)
            return String(arrayLiteral.dropFirst().dropLast())
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            sessionID: sessionID,
            inputHandler: onInput,
            binaryInputHandler: onBinaryInput,
            resizeHandler: onResize
        )
    }

    func makeNSView(context: Context) -> WKWebView {
        let userContentController = WKUserContentController()
        userContentController.add(context.coordinator.messageProxy, name: TerminalMessageName.ready)
        userContentController.add(context.coordinator.messageProxy, name: TerminalMessageName.input)
        userContentController.add(context.coordinator.messageProxy, name: TerminalMessageName.binaryInput)
        userContentController.add(context.coordinator.messageProxy, name: TerminalMessageName.resize)

        let configuration = WKWebViewConfiguration()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.userContentController = userContentController

        let webView = WKWebView(frame: .zero, configuration: configuration)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.setValue(false, forKey: "drawsBackground")
        loadTerminalPage(in: webView)
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.inputHandler = onInput
        context.coordinator.binaryInputHandler = onBinaryInput
        context.coordinator.resizeHandler = onResize

        if context.coordinator.currentSessionID != sessionID {
            context.coordinator.updateState(replayText: replayText, isLive: isLive)
            context.coordinator.reload(for: sessionID, in: webView) { terminalWebView in
                loadTerminalPage(in: terminalWebView)
            }
            return
        }

        context.coordinator.webView = webView
        context.coordinator.updateState(replayText: replayText, isLive: isLive)
    }

    static func dismantleNSView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: TerminalMessageName.ready)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: TerminalMessageName.input)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: TerminalMessageName.binaryInput)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: TerminalMessageName.resize)
        webView.navigationDelegate = nil
    }

    private func loadTerminalPage(in webView: WKWebView) {
        guard let terminalURL = terminalPageURL else {
            webView.loadHTMLString("<html><body style='background:#111;color:#eee;font-family:monospace'>Missing terminal resources.</body></html>", baseURL: nil)
            return
        }

        let rootURL = terminalURL.deletingLastPathComponent()
        webView.loadFileURL(terminalURL, allowingReadAccessTo: rootURL)
    }

    private var terminalPageURL: URL? {
        Bundle.module.resourceURL?
            .appending(path: "Resources")
            .appending(path: "Terminal")
            .appending(path: "terminal.html")
    }
}
