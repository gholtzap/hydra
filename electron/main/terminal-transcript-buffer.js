class TerminalTranscriptBuffer {
  constructor(seedText = "", maxLength = 160000) {
    this.maxLength = maxLength;
    this.committedText = "";
    this.currentLine = [];
    this.cursorColumn = 0;
    this.replaceSeed(seedText);
  }

  get renderedText() {
    return this.committedText + this.currentLine.join("");
  }

  consume(rawText) {
    this.apply(rawText);
    this.trimIfNeeded();
    return this.renderedText;
  }

  replaceSeed(text) {
    const newlineIndex = text.lastIndexOf("\n");

    if (newlineIndex >= 0) {
      this.committedText = text.slice(0, newlineIndex + 1);
      this.currentLine = Array.from(text.slice(newlineIndex + 1));
    } else {
      this.committedText = "";
      this.currentLine = Array.from(text);
    }

    this.cursorColumn = this.currentLine.length;
  }

  apply(rawText) {
    const chars = Array.from(rawText);
    let index = 0;

    while (index < chars.length) {
      const char = chars[index];

      if (char === "\u001b") {
        index = this.parseEscapeSequence(chars, index);
        continue;
      }

      switch (char) {
        case "\n":
          this.committedText += `${this.currentLine.join("")}\n`;
          this.currentLine = [];
          this.cursorColumn = 0;
          break;
        case "\r":
          this.cursorColumn = 0;
          break;
        case "\b":
        case "\u007f":
          if (this.cursorColumn > 0) {
            this.cursorColumn -= 1;

            if (this.cursorColumn < this.currentLine.length) {
              this.currentLine.splice(this.cursorColumn, 1);
            }
          }
          break;
        case "\t":
          this.write(char);
          break;
        default:
          if (!isControlCharacter(char)) {
            this.write(char);
          }
          break;
      }

      index += 1;
    }
  }

  parseEscapeSequence(chars, startIndex) {
    const nextIndex = startIndex + 1;
    if (nextIndex >= chars.length) {
      return startIndex + 1;
    }

    switch (chars[nextIndex]) {
      case "[":
        return this.parseCSISequence(chars, nextIndex + 1);
      case "]":
        return this.skipOSCSequence(chars, nextIndex + 1);
      default:
        return nextIndex + 1;
    }
  }

  parseCSISequence(chars, startIndex) {
    let index = startIndex;
    let parameterString = "";

    while (index < chars.length) {
      const char = chars[index];
      const code = char.charCodeAt(0);

      if (code >= 0x40 && code <= 0x7e) {
        this.applyCSI(char, parameterString);
        return index + 1;
      }

      parameterString += char;
      index += 1;
    }

    return index;
  }

  skipOSCSequence(chars, startIndex) {
    let index = startIndex;

    while (index < chars.length) {
      const char = chars[index];

      if (char === "\u0007") {
        return index + 1;
      }

      if (char === "\u001b" && index + 1 < chars.length && chars[index + 1] === "\\") {
        return index + 2;
      }

      index += 1;
    }

    return index;
  }

  applyCSI(finalChar, parameterString) {
    const parameters = parameterString.split(";").map((value) => Number.parseInt(value, 10) || 0);

    switch (finalChar) {
      case "m":
        return;
      case "K":
        this.clearLine(parameters[0] ?? 0);
        return;
      case "J":
        this.clearScreen(parameters[0] ?? 0);
        return;
      case "C":
        this.moveCursorForward(Math.max(parameters[0] ?? 1, 1));
        return;
      case "D":
        this.moveCursorBackward(Math.max(parameters[0] ?? 1, 1));
        return;
      case "G":
        this.moveCursorToColumn(Math.max((parameters[0] ?? 1) - 1, 0));
        return;
      case "P":
        this.deleteCharacters(Math.max(parameters[0] ?? 1, 1));
        return;
      case "X":
        this.eraseCharacters(Math.max(parameters[0] ?? 1, 1));
        return;
      default:
        return;
    }
  }

  write(char) {
    if (this.cursorColumn < this.currentLine.length) {
      this.currentLine[this.cursorColumn] = char;
    } else {
      while (this.currentLine.length < this.cursorColumn) {
        this.currentLine.push(" ");
      }

      this.currentLine.push(char);
    }

    this.cursorColumn += 1;
  }

  clearLine(mode) {
    switch (mode) {
      case 1: {
        const upperBound = Math.min(this.cursorColumn, this.currentLine.length);
        for (let index = 0; index < upperBound; index += 1) {
          this.currentLine[index] = " ";
        }
        return;
      }
      case 2:
        this.currentLine = [];
        this.cursorColumn = 0;
        return;
      default:
        if (this.cursorColumn < this.currentLine.length) {
          this.currentLine.splice(this.cursorColumn);
        }
    }
  }

  clearScreen(mode) {
    if (mode === 2 || mode === 3) {
      this.committedText = "";
      this.currentLine = [];
      this.cursorColumn = 0;
    }
  }

  moveCursorForward(amount) {
    this.cursorColumn += amount;
  }

  moveCursorBackward(amount) {
    this.cursorColumn = Math.max(this.cursorColumn - amount, 0);
  }

  moveCursorToColumn(column) {
    this.cursorColumn = Math.max(column, 0);
  }

  deleteCharacters(count) {
    if (this.cursorColumn < this.currentLine.length) {
      const upperBound = Math.min(this.cursorColumn + count, this.currentLine.length);
      this.currentLine.splice(this.cursorColumn, upperBound - this.cursorColumn);
    }
  }

  eraseCharacters(count) {
    if (this.cursorColumn >= this.currentLine.length) {
      return;
    }

    const upperBound = Math.min(this.cursorColumn + count, this.currentLine.length);
    for (let index = this.cursorColumn; index < upperBound; index += 1) {
      this.currentLine[index] = " ";
    }
  }

  trimIfNeeded() {
    if (this.renderedText.length > this.maxLength) {
      this.replaceSeed(this.renderedText.slice(-this.maxLength));
    }
  }

  static visibleText(rawText) {
    return new TerminalTranscriptBuffer("", Math.max(rawText.length * 2, 4096)).consume(rawText);
  }
}

function isControlCharacter(char) {
  const code = char.codePointAt(0) || 0;
  return (code >= 0 && code <= 0x1f) || code === 0x7f;
}

module.exports = {
  TerminalTranscriptBuffer
};
