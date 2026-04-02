(function () {
  const postMessage = (name, payload) => {
    const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers[name];
    if (handler) {
      handler.postMessage(payload);
    }
  };

  const terminal = new Terminal({
    allowTransparency: false,
    convertEol: false,
    cursorBlink: true,
    cursorInactiveStyle: "outline",
    disableStdin: false,
    drawBoldTextInBrightColors: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
    fontSize: 13,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    scrollback: 10000,
    theme: {
      background: "#161616",
      foreground: "#f4f4f4",
      cursor: "#7dd3fc",
      cursorAccent: "#161616",
      selectionBackground: "rgba(125, 211, 252, 0.28)",
      black: "#161616",
      red: "#ff7b72",
      green: "#7ee787",
      yellow: "#e3b341",
      blue: "#79c0ff",
      magenta: "#d2a8ff",
      cyan: "#a5f3fc",
      white: "#c9d1d9",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc"
    }
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);

  const terminalElement = document.getElementById("terminal");
  const shellElement = document.getElementById("terminal-shell");
  let isLive = false;
  let fitScheduled = false;

  const reportSize = () => {
    postMessage("terminalResize", { cols: terminal.cols, rows: terminal.rows });
  };

  const fit = () => {
    fitAddon.fit();
    reportSize();
  };

  const scheduleFit = () => {
    if (fitScheduled) {
      return;
    }

    fitScheduled = true;
    window.requestAnimationFrame(() => {
      fitScheduled = false;
      fit();
    });
  };

  terminal.onData((data) => {
    if (isLive) {
      postMessage("terminalInput", data);
    }
  });

  terminal.onBinary((data) => {
    if (isLive) {
      postMessage("terminalBinaryInput", data);
    }
  });

  terminal.onResize(() => {
    reportSize();
  });

  terminal.open(terminalElement);

  const resizeObserver = new ResizeObserver(() => {
    scheduleFit();
  });
  resizeObserver.observe(shellElement);

  window.addEventListener("resize", scheduleFit);

  window.terminalBridge = {
    focus() {
      terminal.focus();
    },
    reset(text) {
      terminal.reset();
      terminal.clear();
      if (text) {
        terminal.write(text);
      }
      scheduleFit();
    },
    setLive(nextValue) {
      isLive = !!nextValue;
      terminal.options.disableStdin = !isLive;
      if (isLive) {
        terminal.focus();
      }
    },
    write(text) {
      if (text) {
        terminal.write(text);
      }
    }
  };

  scheduleFit();
  postMessage("terminalReady", {});
})();
