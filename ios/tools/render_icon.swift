// Renders the OpenBand app icon (1024×1024, opaque) from the 24-hour dial motif.
// Run: swift tools/render_icon.swift OpenBand/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png
import AppKit
import CoreGraphics

let size = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "AppIcon.png"

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
let s = CGFloat(size)
let center = CGPoint(x: s / 2, y: s / 2)

// Night background
ctx.setFillColor(rgb(0x121A2B))
ctx.fill(CGRect(x: 0, y: 0, width: s, height: s))

// Angle for hour h: 00 at top, clockwise (CoreGraphics y goes up).
func angle(_ hour: CGFloat) -> CGFloat { .pi / 2 - hour / 24 * 2 * .pi }
func point(_ hour: CGFloat, _ r: CGFloat) -> CGPoint {
    CGPoint(x: center.x + cos(angle(hour)) * r, y: center.y + sin(angle(hour)) * r)
}

// Dial track
let trackR: CGFloat = 0.25 * s
ctx.setLineWidth(0.03 * s)
ctx.setStrokeColor(rgb(0x2A3348))
ctx.addArc(center: center, radius: trackR, startAngle: 0, endAngle: 2 * .pi, clockwise: false)
ctx.strokePath()

// Night shading 22–06 on the track
ctx.setStrokeColor(rgb(0x0A0F1A))
ctx.addArc(center: center, radius: trackR, startAngle: angle(22), endAngle: angle(30), clockwise: true)
ctx.strokePath()

// Hourly step bars (a plausible day) on the outer arc, Saffron
let steps: [CGFloat] = [0, 0, 0, 0, 0, 0, 0.15, 0.55, 0.9, 0.35, 0.3, 0.45, 0.7, 0.5, 0.3, 0.25, 0.4, 0.85, 1.0, 0.6, 0.3, 0.12, 0, 0]
ctx.setLineCap(.round)
ctx.setStrokeColor(rgb(0xF0B43A))
ctx.setLineWidth(0.03 * s)
for (hour, v) in steps.enumerated() where v > 0 {
    let h = CGFloat(hour) + 0.5
    ctx.move(to: point(h, trackR + 0.045 * s))
    ctx.addLine(to: point(h, trackR + 0.045 * s + v * 0.10 * s))
    ctx.strokePath()
}

// "Now" tick and centre pulse, Pomegranate
let now: CGFloat = 18.5
ctx.setStrokeColor(rgb(0xF0566A))
ctx.setLineWidth(0.02 * s)
ctx.move(to: point(now, trackR - 0.045 * s))
ctx.addLine(to: point(now, trackR + 0.02 * s))
ctx.strokePath()
ctx.setFillColor(rgb(0xF0566A))
let dot: CGFloat = 0.075 * s
ctx.fillEllipse(in: CGRect(x: center.x - dot / 2, y: center.y - dot / 2, width: dot, height: dot))

let image = ctx.makeImage()!
let rep = NSBitmapImageRep(cgImage: image)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
print("wrote \(out)")
