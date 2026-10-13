// Checks KeyLoader against synthetic Mi Fitness caches.
// Build: swiftc ../../OpenBand/Band/KeyStore.swift main.swift -o /tmp/kstest
import Foundation
import SQLite3

@objc(MHWFakeDevice) final class FakeDevice: NSObject, NSCoding {
    let name: String, key: String, mac: String
    init(_ name: String, _ key: String, _ mac: String) { self.name = name; self.key = key; self.mac = mac }
    func encode(with c: NSCoder) { c.encode(name, forKey: "name"); c.encode(key, forKey: "encryptKey"); c.encode(mac, forKey: "mac"); c.encode(42, forKey: "did") }
    init?(coder: NSCoder) { nil }
}

let hex = "00112233445566778899aabbccddeeff"
func check(_ label: String, _ keys: [BandKey], name: String) {
    precondition(keys.count == 1 && keys[0].hex == hex && keys[0].name == name && keys[0].data.count == 16, "\(label): \(keys)")
    print("OK", label, keys[0].masked)
}

// 1. custom class objects
let custom = try! NSKeyedArchiver.archivedData(withRootObject: [FakeDevice("Xiaomi Smart Band 10 Pro D9B9", "0x" + hex.uppercased(), "20:25:CC:78:D9:B9"), FakeDevice("Other", "nope", "")], requiringSecureCoding: false)
check("custom-class archive", KeyLoader.parseRegisterList(custom), name: "Xiaomi Smart Band 10 Pro D9B9")

// 2. NSDictionary with the key as 16 bytes of NSData
let keyData = Data((0..<16).map { UInt8($0 * 0x11) })
let dictArchive = try! NSKeyedArchiver.archivedData(withRootObject: [["name": "Band Dict", "encryptKey": keyData] as NSDictionary], requiringSecureCoding: false)
check("NSDictionary archive", KeyLoader.parseRegisterList(dictArchive), name: "Band Dict")

// 3. whole folder: region-specific entry stored in data/<filename>, not inline
let root = FileManager.default.temporaryDirectory.appendingPathComponent("mifit-\(UUID().uuidString)")
let cache = root.appendingPathComponent("MHWCahe/123/VirtualDevice_registerList")
try! FileManager.default.createDirectory(at: cache.appendingPathComponent("data"), withIntermediateDirectories: true)
try! custom.write(to: cache.appendingPathComponent("data/f1"))
var db: OpaquePointer?
sqlite3_open(cache.appendingPathComponent("manifest.sqlite").path, &db)
sqlite3_exec(db, "CREATE TABLE manifest (key text, filename text, size integer, inline_data blob, modification_time integer, last_access_time integer, extended_data blob, primary key(key)); INSERT INTO manifest(key, filename, size) VALUES ('registerList_sg', 'f1', \(custom.count)); INSERT INTO manifest(key, inline_data) VALUES ('other', x'00');", nil, nil, nil)
sqlite3_close(db)
check("folder, registerList_sg in data/ file", try! KeyLoader.load(from: root), name: "Xiaomi Smart Band 10 Pro D9B9")

// 4. diagnostics when nothing matches never include key material
sqlite3_open(cache.appendingPathComponent("manifest.sqlite").path, &db)
sqlite3_exec(db, "DELETE FROM manifest WHERE key LIKE 'registerList%';", nil, nil, nil)
sqlite3_close(db)
do { _ = try KeyLoader.load(from: root); preconditionFailure("expected failure") } catch {
    let message = error.localizedDescription
    precondition(!message.contains(hex) && message.contains("other"), message)
    print("OK diagnostics:", message)
}
try? FileManager.default.removeItem(at: root)
