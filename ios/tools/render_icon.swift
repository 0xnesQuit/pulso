// Renders the Freeband v3 app icon (docs/design-v3-spec.md section 5): one open 270° arc, the
// ScoreArc shape with its gap at the bottom, a uniform 72px stroke on 1024 with square (butt)
// ends, so it reads as a gauge and not a power symbol. Flat: no red, gradients or dither.
//
// Writes three opaque 1024×1024 PNGs into an asset catalog app icon set:
//   AppIcon.png         #171A20 arc on #F4F4F4 (default, light)
//   AppIcon-Dark.png    #F4F4F4 arc on #0E0F12 (luminosity: dark)
//   AppIcon-Tinted.png  white arc on black, greyscale for the iOS 18 tint (luminosity: tinted)
//
// Run from ios/: swift tools/render_icon.swift Freeband/Resources/Assets.xcassets/AppIcon.appiconset
import AppKit
import CoreGraphics

let outDir = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".", isDirectory: true)
let size = 1024
let stroke: CGFloat = 72
/// Centre-line radius: the arc's outer diameter is 600px, inside the icon grid's centre circle.
let radius: CGFloat = 300 - stroke / 2

func rgb(_ hex: UInt32) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

func render(arc: UInt32, on background: UInt32, to name: String) throws {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.setFillColor(rgb(background))
    ctx.fill(CGRect(x: 0, y: 0, width: size, height: size))

    // CoreGraphics is y-up: the arc runs clockwise from 225° (lower left) over the top to -45°
    // (lower right), leaving the 90° gap at the bottom.
    // Optical centring: the open bottom makes the shape top-heavy, so centre its bounding box
    // (top of the stroke to the lowest corner of the butt ends) rather than the circle.
    let top = radius + stroke / 2
    let bottom = radius * sin(.pi / 4) + stroke / 2 * cos(.pi / 4)
    let centreY = CGFloat(size) / 2 - (top - bottom) / 2
    let centre = CGPoint(x: CGFloat(size) / 2, y: centreY)

    ctx.setStrokeColor(rgb(arc))
    ctx.setLineWidth(stroke)
    ctx.setLineCap(.butt)
    ctx.addArc(center: centre, radius: radius, startAngle: .pi * 1.25, endAngle: -.pi * 0.25, clockwise: true)
    ctx.strokePath()

    let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
    let url = outDir.appendingPathComponent(name)
    try rep.representation(using: .png, properties: [:])!.write(to: url)
    print("wrote \(url.path)")
}

try render(arc: 0x171A20, on: 0xF4F4F4, to: "AppIcon.png")
try render(arc: 0xF4F4F4, on: 0x0E0F12, to: "AppIcon-Dark.png")
try render(arc: 0xFFFFFF, on: 0x000000, to: "AppIcon-Tinted.png")
