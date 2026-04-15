import AppKit
import Foundation

extension NSColor {
  convenience init(hex: UInt32, alpha: CGFloat = 1) {
    let red = CGFloat((hex >> 16) & 0xff) / 255
    let green = CGFloat((hex >> 8) & 0xff) / 255
    let blue = CGFloat(hex & 0xff) / 255
    self.init(srgbRed: red, green: green, blue: blue, alpha: alpha)
  }
}

func scaledRect(_ x: CGFloat, _ y: CGFloat, _ width: CGFloat, _ height: CGFloat, scale: CGFloat) -> NSRect {
  NSRect(x: x * scale, y: y * scale, width: width * scale, height: height * scale)
}

func roundedRect(_ rect: NSRect, radius: CGFloat) -> NSBezierPath {
  NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)
}

func fill(_ path: NSBezierPath, gradient: NSGradient, angle: CGFloat) {
  NSGraphicsContext.saveGraphicsState()
  path.addClip()
  gradient.draw(in: path, angle: angle)
  NSGraphicsContext.restoreGraphicsState()
}

func drawIcon(at size: Int, outputURL: URL) throws {
  let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: size,
    pixelsHigh: size,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bitmapFormat: [],
    bytesPerRow: 0,
    bitsPerPixel: 0
  )

  guard let bitmap = rep else {
    throw NSError(domain: "IconGeneration", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to allocate bitmap image rep."])
  }

  bitmap.size = NSSize(width: size, height: size)

  guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else {
    throw NSError(domain: "IconGeneration", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to create graphics context."])
  }

  let scale = CGFloat(size) / 1024

  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  context.imageInterpolation = .high

  let cgContext = context.cgContext

  cgContext.translateBy(x: 0, y: CGFloat(size))
  cgContext.scaleBy(x: 1, y: -1)

  let canvas = NSRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size))
  NSColor.clear.setFill()
  canvas.fill()

  let outerRect = scaledRect(88, 88, 848, 848, scale: scale)
  let outerPath = roundedRect(outerRect, radius: 222 * scale)

  let outerShadow = NSShadow()
  outerShadow.shadowColor = NSColor.black.withAlphaComponent(0.20)
  outerShadow.shadowBlurRadius = 44 * scale
  outerShadow.shadowOffset = NSSize(width: 0, height: 20 * scale)
  outerShadow.set()
  NSColor(hex: 0x221f1a).setFill()
  outerPath.fill()

  NSGraphicsContext.restoreGraphicsState()
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  cgContext.translateBy(x: 0, y: CGFloat(size))
  cgContext.scaleBy(x: 1, y: -1)

  let outerGradient = NSGradient(colorsAndLocations:
    (NSColor(hex: 0x51463c), 0.0),
    (NSColor(hex: 0x2a241f), 0.48),
    (NSColor(hex: 0x171410), 1.0)
  )!
  fill(outerPath, gradient: outerGradient, angle: 90)

  let glowRect = scaledRect(136, 120, 752, 260, scale: scale)
  let glowPath = roundedRect(glowRect, radius: 180 * scale)
  NSColor(hex: 0xdec8a0, alpha: 0.08).setFill()
  glowPath.fill()

  NSColor(hex: 0xd1b17b, alpha: 0.42).setStroke()
  outerPath.lineWidth = 6 * scale
  outerPath.stroke()

  let frameInsetRect = scaledRect(132, 132, 760, 760, scale: scale)
  let frameInsetPath = roundedRect(frameInsetRect, radius: 190 * scale)
  NSColor(hex: 0xf7efdd, alpha: 0.08).setStroke()
  frameInsetPath.lineWidth = 3 * scale
  frameInsetPath.stroke()

  let workspaceRect = scaledRect(186, 186, 652, 652, scale: scale)
  let workspaceShadow = NSShadow()
  workspaceShadow.shadowColor = NSColor.black.withAlphaComponent(0.16)
  workspaceShadow.shadowBlurRadius = 20 * scale
  workspaceShadow.shadowOffset = NSSize(width: 0, height: 10 * scale)
  workspaceShadow.set()
  let workspacePath = roundedRect(workspaceRect, radius: 124 * scale)
  NSColor(hex: 0xf1e8d8).setFill()
  workspacePath.fill()

  NSGraphicsContext.restoreGraphicsState()
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = context
  cgContext.translateBy(x: 0, y: CGFloat(size))
  cgContext.scaleBy(x: 1, y: -1)

  let workspaceGradient = NSGradient(colorsAndLocations:
    (NSColor(hex: 0xf4efe5), 0.0),
    (NSColor(hex: 0xebe1d0), 0.54),
    (NSColor(hex: 0xe3d4bc), 1.0)
  )!
  fill(workspacePath, gradient: workspaceGradient, angle: 90)

  NSColor(hex: 0x4d4439, alpha: 0.16).setStroke()
  workspacePath.lineWidth = 3 * scale
  workspacePath.stroke()

  let toolbarRect = scaledRect(220, 218, 584, 94, scale: scale)
  let toolbarPath = roundedRect(toolbarRect, radius: 42 * scale)
  let toolbarGradient = NSGradient(colorsAndLocations:
    (NSColor(hex: 0xe6dac7), 0.0),
    (NSColor(hex: 0xd9ccb7), 1.0)
  )!
  fill(toolbarPath, gradient: toolbarGradient, angle: 90)

  for (index, color) in [0xe18473, 0xe0b16d, 0x8fb27c].enumerated() {
    let dotRect = scaledRect(CGFloat(252 + (index * 28)), 250, 18, 18, scale: scale)
    let dotPath = roundedRect(dotRect, radius: 9 * scale)
    NSColor(hex: UInt32(color)).setFill()
    dotPath.fill()
  }

  let sidebarRect = scaledRect(220, 336, 152, 468, scale: scale)
  let sidebarPath = roundedRect(sidebarRect, radius: 56 * scale)
  let sidebarGradient = NSGradient(colorsAndLocations:
    (NSColor(hex: 0x5b5147), 0.0),
    (NSColor(hex: 0x413a33), 1.0)
  )!
  fill(sidebarPath, gradient: sidebarGradient, angle: 90)

  for (index, width) in [92, 84, 98, 74, 88].enumerated() {
    let pillRect = scaledRect(246, CGFloat(382 + (index * 62)), CGFloat(width), 18, scale: scale)
    let pillPath = roundedRect(pillRect, radius: 9 * scale)
    NSColor(hex: 0xf4ece0, alpha: index == 0 ? 0.72 : 0.42).setFill()
    pillPath.fill()
  }

  let editorRect = scaledRect(404, 336, 400, 250, scale: scale)
  let editorPath = roundedRect(editorRect, radius: 56 * scale)
  NSColor(hex: 0xfcf8f1, alpha: 0.96).setFill()
  editorPath.fill()
  NSColor(hex: 0x5a4e43, alpha: 0.12).setStroke()
  editorPath.lineWidth = 2 * scale
  editorPath.stroke()

  let selectionRect = scaledRect(434, 400, 188, 42, scale: scale)
  let selectionPath = roundedRect(selectionRect, radius: 20 * scale)
  NSColor(hex: 0xdccaa8, alpha: 0.88).setFill()
  selectionPath.fill()

  for (index, width) in [236, 280, 212, 248].enumerated() {
    let lineRect = scaledRect(438, CGFloat(462 + (index * 34)), CGFloat(width), 16, scale: scale)
    let linePath = roundedRect(lineRect, radius: 8 * scale)
    NSColor(hex: 0x544a3f, alpha: index == 0 ? 0.88 : 0.44).setFill()
    linePath.fill()
  }

  let terminalRect = scaledRect(404, 610, 400, 194, scale: scale)
  let terminalPath = roundedRect(terminalRect, radius: 56 * scale)
  let terminalGradient = NSGradient(colorsAndLocations:
    (NSColor(hex: 0x2f2822), 0.0),
    (NSColor(hex: 0x1e1a16), 1.0)
  )!
  fill(terminalPath, gradient: terminalGradient, angle: 90)

  NSColor(hex: 0xf8eed8, alpha: 0.09).setStroke()
  terminalPath.lineWidth = 2 * scale
  terminalPath.stroke()

  let promptStroke = NSBezierPath()
  promptStroke.lineWidth = 18 * scale
  promptStroke.lineCapStyle = .round
  promptStroke.lineJoinStyle = .round
  promptStroke.move(to: NSPoint(x: 454 * scale, y: 690 * scale))
  promptStroke.line(to: NSPoint(x: 490 * scale, y: 722 * scale))
  promptStroke.line(to: NSPoint(x: 454 * scale, y: 754 * scale))
  NSColor(hex: 0xf2e6ce, alpha: 0.96).setStroke()
  promptStroke.stroke()

  let cursorRect = scaledRect(510, 742, 74, 18, scale: scale)
  let cursorPath = roundedRect(cursorRect, radius: 9 * scale)
  NSColor(hex: 0xcdb07a).setFill()
  cursorPath.fill()

  for (index, width) in [180, 132, 168].enumerated() {
    let cmdRect = scaledRect(454, CGFloat(646 + (index * 34)), CGFloat(width), 14, scale: scale)
    let cmdPath = roundedRect(cmdRect, radius: 7 * scale)
    NSColor(hex: 0xf4ecd9, alpha: index == 0 ? 0.56 : 0.28).setFill()
    cmdPath.fill()
  }

  let edgeLightRect = scaledRect(694, 198, 100, 102, scale: scale)
  let edgeLightPath = roundedRect(edgeLightRect, radius: 34 * scale)
  NSColor(hex: 0xffffff, alpha: 0.12).setFill()
  edgeLightPath.fill()

  NSGraphicsContext.restoreGraphicsState()

  guard let pngData = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "IconGeneration", code: 4, userInfo: [NSLocalizedDescriptionKey: "Unable to encode PNG data."])
  }

  try pngData.write(to: outputURL)
}

let fileManager = FileManager.default
let scriptURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
let buildDirectoryURL = scriptURL.deletingLastPathComponent()
let iconsetURL = buildDirectoryURL.appendingPathComponent("icon.iconset", isDirectory: true)
let previewURL = buildDirectoryURL.appendingPathComponent("icon-preview.png")

if fileManager.fileExists(atPath: iconsetURL.path) {
  try fileManager.removeItem(at: iconsetURL)
}

try fileManager.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

let iconsetFiles: [(String, Int)] = [
  ("icon_16x16.png", 16),
  ("icon_16x16@2x.png", 32),
  ("icon_32x32.png", 32),
  ("icon_32x32@2x.png", 64),
  ("icon_128x128.png", 128),
  ("icon_128x128@2x.png", 256),
  ("icon_256x256.png", 256),
  ("icon_256x256@2x.png", 512),
  ("icon_512x512.png", 512),
  ("icon_512x512@2x.png", 1024)
]

for (fileName, size) in iconsetFiles {
  try drawIcon(at: size, outputURL: iconsetURL.appendingPathComponent(fileName))
}

try drawIcon(at: 1024, outputURL: previewURL)
print("Generated iconset at \(iconsetURL.path)")
