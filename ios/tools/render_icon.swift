// Renders the Freeband app icon (1024×1024, opaque): the 24-hour dial on a pixel grid with a
// 4×4 Bayer dither, as in docs/DESIGN.md v2.
// Run: swift tools/render_icon.swift Freeband/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit
import CoreGraphics

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"
let size = 1024
let n = 48                      // pixel grid: coarse enough to read as pixels on a home screen
let cell = Double(size) / Double(n)

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}
let bayer: [[Double]] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map { $0.map { ($0 + 0.5) / 16 } }

let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(rgb(0x0A0A0A))
ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

// A plausible day of steps per hour.
let steps: [Double] = [0, 0, 0, 0, 0, 0, 0.15, 0.55, 0.9, 0.35, 0.3, 0.45, 0.7, 0.5, 0.3, 0.25, 0.4, 0.85, 1.0, 0.6, 0.3, 0.12, 0, 0]
let c = Double(n) / 2
let track = Double(n) * 0.27
let barStart = track + 2.0
let barMax = Double(n) * 0.13
let nowHour = 18.5

func put(_ x: Int, _ y: Int, _ color: UInt32) {
    // CoreGraphics y grows upwards; flip so row 0 is the top.
    ctx.setFillColor(rgb(color))
    ctx.fill(CGRect(x: Double(x) * cell, y: Double(n - 1 - y) * cell, width: cell, height: cell))
}

for y in 0..<n {
    for x in 0..<n {
        let dx = Double(x) + 0.5 - c, dy = Double(y) + 0.5 - c
        let r = (dx * dx + dy * dy).squareRoot()
        var a = atan2(dx, -dy); if a < 0 { a += 2 * .pi }
        let hour = a / (2 * .pi) * 24
        let t = bayer[y % 4][x % 4]
        let h = Int(hour), off = hour - Double(h)
        if r >= barStart, off > 0.18, off < 0.82, steps[h] > 0, r <= barStart + max(1, steps[h] * barMax) {
            put(x, y, 0x8BE36B); continue
        }
        if abs(r - track) <= 1.1 {
            let night = hour >= 22 || hour < 6
            if t < (night ? 0.18 : 0.45) { put(x, y, 0x4A4A4A) }
        }
    }
}
// a pixel heart at the centre
let heart = [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."]
for (row, line) in heart.enumerated() {
    for (col, ch) in line.enumerated() where ch == "X" { put(Int(c) - 3 + col, Int(c) - 3 + row, 0xFF5C5C) }
}
// now tick
let a = nowHour / 24 * 2 * .pi
for s in stride(from: track - 2.0, through: track + 2.0, by: 0.5) {
    put(Int((c + sin(a) * s).rounded(.down)), Int((c - cos(a) * s).rounded(.down)), 0xEDEDED)
}

let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
