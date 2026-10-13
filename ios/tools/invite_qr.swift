// Renders an OpenBand invite QR code (opens the hub's /join page with the code in the fragment).
// Run: swift tools/invite_qr.swift <invite code> <output.png> [hub URL]
import AppKit
import CoreImage

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: invite_qr.swift <code> <out.png> [hub]"); exit(1) }
let hub = args.count > 3 ? args[3] : "https://openband.cobanov.dev"
let link = "\(hub)/join#invite=\(args[1])"

let filter = CIFilter(name: "CIQRCodeGenerator")!
filter.setValue(Data(link.utf8), forKey: "inputMessage")
filter.setValue("M", forKey: "inputCorrectionLevel")
let qr = filter.outputImage!.transformed(by: CGAffineTransform(scaleX: 24, y: 24))

let context = CIContext()
let cg = context.createCGImage(qr, from: qr.extent)!
let quiet: CGFloat = 96
let size = CGSize(width: qr.extent.width + quiet * 2, height: qr.extent.height + quiet * 2)
let image = NSImage(size: size)
image.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: size).fill()
NSGraphicsContext.current?.imageInterpolation = .none
NSGraphicsContext.current?.cgContext.draw(cg, in: CGRect(x: quiet, y: quiet, width: qr.extent.width, height: qr.extent.height))
image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: args[2]))
print("\(link) -> \(args[2])")
