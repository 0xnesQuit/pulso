import CoreBluetooth
import Foundation

// Two modes against a band that iOS already holds a connection to:
//  - survey: read-only GATT listing (Phase 2). Never writes, never enables notifications;
//    the only reads are standard Device Information and Battery Level.
//  - auth: Phase 3 PoC. Subscribes to 005E, starts an SPP v2 session on 005F, authenticates
//    with the Mi Fitness key and asks for the battery level over the encrypted channel.

struct Candidate: Identifiable {
    let id: UUID
    let name: String
    var source: String
    let peripheral: CBPeripheral
}

struct CharRow: Identifiable {
    let id = UUID()
    let uuid: String
    let properties: [String]
    var value: String?
    var descriptors: [String] = []
}

struct ServiceRow: Identifiable {
    let id = UUID()
    let uuid: String
    let isPrimary: Bool
    var characteristics: [CharRow] = []
}

final class Probe: NSObject, ObservableObject {
    static let fe95 = CBUUID(string: "FE95")
    static let rxUUID = CBUUID(string: "005E")
    static let txUUID = CBUUID(string: "005F")
    // Services iOS is asked about when looking for an already connected band.
    static let retrieveServices = [fe95, CBUUID(string: "180A"), CBUUID(string: "180F")]
    static let readAllowlist: Set<String> = ["2A29", "2A24", "2A25", "2A27", "2A26", "2A28", "2A19"]
    static let known: [String: String] = [
        "FE95": "Xiaomi", "005E": "V2 RX (notify)", "005F": "V2 TX (write)",
        "0051": "V1 komut oku", "0052": "V1 komut yaz", "0053": "V1 aktivite", "0055": "V1 yükleme",
        "180A": "Device Information", "180F": "Battery", "1800": "GAP", "1801": "GATT",
        "180D": "Heart Rate", "FDAB": "Xiaomi Proximity Unlock",
        "2A29": "Üretici", "2A24": "Model", "2A25": "Seri no", "2A27": "Donanım rev.",
        "2A26": "Firmware rev.", "2A28": "Yazılım rev.", "2A19": "Pil",
    ]

    private enum Mode { case survey, auth }

    @Published var state = "Başlatılıyor…"
    @Published var candidates: [Candidate] = []
    @Published var services: [ServiceRow] = []
    @Published var connectedName: String?
    @Published var log: [String] = []

    @Published var bandKey: BandKey? = KeyVault.load()
    @Published var foundKeys: [BandKey] = []
    @Published var authState = "Başlamadı"
    @Published var authLog: [String] = []
    @Published var authBattery: String?
    @Published var live: MiAuth.LiveStats?
    @Published var liveUpdated: Date?
    @Published var liveRunning = false

    static let liveLimit: TimeInterval = 120

    private var central: CBCentralManager!
    private var target: CBPeripheral?
    private var mode = Mode.survey
    private var serviceIndex: [ObjectIdentifier: Int] = [:]
    private var charIndex: [ObjectIdentifier: (Int, Int)] = [:]

    // auth session state
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var rxBuffer: [UInt8] = []
    private var writeQueue: [Data] = []
    private var dataSeq: UInt8 = 0
    private var phoneNonce = Data()
    private var sessionKeys: MiAuth.SessionKeys?
    private var authStep = 0
    private var authActive = false
    private var runID = 0

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: survey

    func refresh() {
        guard central.state == .poweredOn else { return }
        candidates.removeAll()
        let connected = central.retrieveConnectedPeripherals(withServices: Self.retrieveServices)
        note("iOS'ta bağlı \(connected.count) aday (FE95/180A/180F)")
        for p in connected { add(p, source: "iOS'ta bağlı") }
        central.scanForPeripherals(withServices: nil, options: nil)
        state = "Taranıyor (10 sn)…"
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let self, self.central.isScanning else { return }
            self.central.stopScan()
            self.state = self.candidates.isEmpty ? "Aday bulunamadı" : "Bir adaya dokun"
        }
    }

    func probe(_ c: Candidate) {
        central.stopScan()
        mode = .survey
        services.removeAll()
        serviceIndex.removeAll()
        charIndex.removeAll()
        target = c.peripheral
        c.peripheral.delegate = self
        state = "Bağlanıyor…"
        note("bağlanılıyor: \(c.name) [\(c.source)]")
        central.connect(c.peripheral, options: nil)
    }

    var hasV2: Bool { has("FE95", chars: ["005E", "005F"]) }
    var hasV1: Bool { has("FE95", chars: ["0051", "0052"]) }

    private func has(_ service: String, chars: [String]) -> Bool {
        guard let s = services.first(where: { $0.uuid == service }) else { return false }
        let seen = Set(s.characteristics.map(\.uuid))
        return chars.allSatisfy(seen.contains)
    }

    private func add(_ p: CBPeripheral, source: String) {
        if let i = candidates.firstIndex(where: { $0.id == p.identifier }) {
            if !candidates[i].source.contains(source) { candidates[i].source += " + " + source }
            return
        }
        candidates.append(Candidate(id: p.identifier, name: p.name ?? "(isimsiz)", source: source, peripheral: p))
    }

    private func note(_ s: String) {
        log.append("\(Date().formatted(date: .omitted, time: .standard))  \(s)")
    }

    // MARK: key

    func importKey(from url: URL) {
        do {
            foundKeys = try KeyLoader.load(from: url)
            let band = connectedName ?? candidates.first?.name
            let pick = foundKeys.first { $0.name == band } ?? foundKeys.first { $0.name.contains("Smart Band") } ?? foundKeys[0]
            choose(pick)
            authNote("\(foundKeys.count) key bulundu, seçilen: \(pick.name) \(pick.masked)")
        } catch {
            authNote("key okunamadı: \(error.localizedDescription)")
        }
    }

    func choose(_ key: BandKey) {
        bandKey = key
        KeyVault.save(key)
    }

    // MARK: auth (Phase 3)

    func runAuth() {
        guard bandKey != nil else { authNote("önce key seç"); return }
        guard central.state == .poweredOn else { authNote("Bluetooth hazır değil"); return }
        central.stopScan()
        let connected = central.retrieveConnectedPeripherals(withServices: [Self.fe95])
        guard let band = connected.first(where: { ($0.name ?? "").contains("Smart Band") }) ?? connected.first else {
            authNote("iOS'ta bağlı FE95 cihazı yok")
            return
        }
        mode = .auth
        authLog.removeAll()
        authBattery = nil
        live = nil
        liveUpdated = nil
        runID += 1
        let run = runID
        rx = nil
        tx = nil
        rxBuffer.removeAll()
        writeQueue.removeAll()
        dataSeq = 0
        sessionKeys = nil
        authStep = 0
        authActive = true
        target = band
        band.delegate = self
        authState = "Bağlanıyor…"
        authNote("hedef: \(band.name ?? "(isimsiz)")")
        central.connect(band, options: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.runID == run, self.authActive, self.authStep < 4 else { return }
            self.authState = "Zaman aşımı (adım \(self.authStep))"
            self.authNote("20 sn içinde tamamlanmadı; son adım \(self.authStep)")
            self.endAuthSession()
        }
    }

    private func authNote(_ s: String) {
        authLog.append("\(Date().formatted(date: .omitted, time: .standard))  \(s)")
    }

    /// Hands the channel back: unsubscribes from 005E and releases this app's use of the
    /// connection, so nothing here answers frames meant for Mi Fitness.
    /// Stops the live stream (Health 46) and then releases the channel.
    func stopLive(reason: String) {
        guard authActive else { return }
        authNote("durduruluyor: \(reason)")
        if authStep >= 4 { sendCommand(MiAuth.realtimeCommand(start: false), encrypted: true) }
        let run = runID
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, self.runID == run else { return }
            self.endAuthSession()
            self.authState = "Durduruldu (\(reason))"
        }
    }

    private func endAuthSession() {
        authActive = false
        liveRunning = false
        writeQueue.removeAll()
        if let p = target {
            if let rx, rx.isNotifying { p.setNotifyValue(false, for: rx) }
            central.cancelPeripheralConnection(p)
        }
        authNote("oturum bırakıldı (005E aboneliği kapatıldı, bağlantı serbest)")
    }

    private func startSession() {
        authStep = 1
        authState = "Oturum açılıyor…"
        authNote("→ SessionConfig START (seq 0)")
        send(MiFrame.encode(kind: MiFrame.kindSessionConfig, seq: 0, payload: MiFrame.startSessionPayload))
    }

    private func sendCommand(_ protobuf: Data, encrypted: Bool) {
        var body = protobuf
        if encrypted, let keys = sessionKeys {
            body = MiCrypto.ctr(key: keys.encryptionKey, protobuf)
        }
        // channel 1 (protobuf / auth), opcode 1 plaintext or 2 encrypted
        let payload = Data([0x01, encrypted ? 0x02 : 0x01]) + body
        send(MiFrame.encode(kind: MiFrame.kindData, seq: dataSeq, payload: payload))
        dataSeq &+= 1
    }

    private func send(_ frame: Data) {
        guard let p = target else { return }
        let size = max(20, p.maximumWriteValueLength(for: .withoutResponse))
        var offset = 0
        while offset < frame.count {
            writeQueue.append(frame.subdata(in: offset..<min(offset + size, frame.count)))
            offset += size
        }
        pump()
    }

    private func pump() {
        guard let p = target, let tx else { return }
        while !writeQueue.isEmpty, p.canSendWriteWithoutResponse {
            p.writeValue(writeQueue.removeFirst(), for: tx, type: .withoutResponse)
        }
    }

    private func receive(_ chunk: Data) {
        guard authActive else { return }
        rxBuffer.append(contentsOf: chunk)
        for packet in MiFrame.drain(&rxBuffer) {
            switch packet.kind {
            case MiFrame.kindSessionConfig:
                authNote("← SessionConfig (opcode \(packet.payload.first ?? 0))")
                if authStep == 1 { startAuth() }
            case MiFrame.kindData:
                send(MiFrame.encode(kind: MiFrame.kindAck, seq: packet.seq, payload: Data()))
                handleData(packet)
            case MiFrame.kindAck:
                break
            case MiFrame.kindNack:
                authNote("← NACK, bileklik seq \(packet.seq) bekliyor")
            default:
                authNote("← bilinmeyen paket türü \(packet.kind)")
            }
        }
    }

    private func startAuth() {
        authStep = 2
        authState = "Auth 1/2…"
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        phoneNonce = nonce
        authNote("→ auth adım 1 (telefon nonce'u)")
        sendCommand(MiAuth.nonceCommand(phoneNonce: nonce), encrypted: false)
    }

    private func handleData(_ packet: MiFrame.Packet) {
        guard packet.payload.count >= 2 else { return }
        let channel = packet.payload[0] & 0x0F
        let opcode = packet.payload[1]
        var body = Data(packet.payload.dropFirst(2))
        if opcode == 2 {
            guard let keys = sessionKeys else {
                authNote("← şifreli paket geldi ama oturum anahtarı yok")
                return
            }
            body = MiCrypto.ctr(key: keys.decryptionKey, body)
        }
        guard channel == 1, let command = PBMessage(body) else {
            authNote("← kanal \(channel), opcode \(opcode), \(body.count) bayt (çözülmedi)")
            return
        }
        let type = command.varints[1] ?? 0
        let subtype = command.varints[2] ?? 0

        switch (type, subtype) {
        case (MiAuth.commandTypeAuth, MiAuth.subtypeNonce):
            guard let verify = command.message(3)?.message(31),
                  let watchNonce = verify.blobs[1], let watchHmac = verify.blobs[2] else {
                authNote("← auth 26 ama deviceVerify yok (status \(command.message(3)?.varints[8] ?? 0))")
                authState = "Auth reddedildi"
                endAuthSession()
                return
            }
            guard let key = bandKey,
                  let result = MiAuth.confirmCommand(authKey: key.data, phoneNonce: phoneNonce,
                                                     watchNonce: watchNonce, watchHmac: watchHmac,
                                                     deviceName: "BandProbe") else {
                authNote("← bilekliğin HMAC'i tutmadı: key yanlış")
                authState = "Key yanlış"
                endAuthSession()
                return
            }
            let (confirm, keys) = result
            sessionKeys = keys
            authStep = 3
            authState = "Auth 2/2…"
            authNote("← bileklik nonce'u + HMAC doğru; → auth adım 3 (onay, device_type=IOS)")
            sendCommand(confirm, encrypted: false)

        case (MiAuth.commandTypeAuth, MiAuth.subtypeAuth):
            authStep = 4
            authState = "Bağlı, canlı veri bekleniyor…"
            authNote("← auth onaylandı; → pil isteği (2/1) ve canlı istatistik (8/45)")
            sendCommand(MiAuth.batteryCommand(), encrypted: true)
            sendCommand(MiAuth.realtimeCommand(start: true), encrypted: true)
            liveRunning = true
            let run = runID
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.liveLimit) { [weak self] in
                guard let self, self.runID == run else { return }
                self.stopLive(reason: "\(Int(Self.liveLimit)) sn doldu")
            }

        case (2, 1):
            if let level = MiAuth.batteryLevel(command) {
                authBattery = "\(level)%"
                authNote("← şifreli kanaldan pil: \(level)%")
            } else {
                authNote("← System/1 geldi ama pil alanı yok (alanlar \(command.fieldNumbers))")
            }

        case (8, 47):
            if let stats = MiAuth.liveStats(command) {
                if live == nil { authNote("← ilk canlı veri: \(stats.steps) adım, nabız \(stats.heartRate)") }
                live = stats
                liveUpdated = Date()
                authState = "Canlı"
            }

        case (8, 45), (8, 46):
            authNote("← canlı istatistik \(subtype == 45 ? "başlatma" : "durdurma") cevabı")

        default:
            authNote("← komut type \(type) subtype \(subtype) (\(body.count) bayt, işlenmedi)")
        }
    }

    /// Writes the current results as JSON (never the key) and returns its file URL for sharing.
    func reportFile() -> URL {
        let report: [String: Any] = [
            "generated": ISO8601DateFormatter().string(from: Date()),
            "peripheral_name": connectedName.map { $0 as Any } ?? NSNull(),
            "ble_v2_path": hasV2,
            "ble_v1_path": hasV1,
            "services": services.map { s in
                [
                    "uuid": s.uuid,
                    "primary": s.isPrimary,
                    "characteristics": s.characteristics.map { c in
                        [
                            "uuid": c.uuid,
                            "properties": c.properties,
                            "value": c.value.map { $0 as Any } ?? NSNull(),
                            "descriptors": c.descriptors,
                        ] as [String: Any]
                    },
                ] as [String: Any]
            },
            "log": log,
            "auth_state": authState,
            "auth_battery": authBattery.map { $0 as Any } ?? NSNull(),
            "live": live.map { ["steps": $0.steps, "calories": $0.calories, "heart_rate": $0.heartRate,
                                "standing_hours": $0.standingHours] as Any } ?? NSNull(),
            "auth_log": authLog,
            "key_used": bandKey.map { "\($0.name) \($0.masked)" as Any } ?? NSNull(),
        ]
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("bandprobe-report.json")
        let data = (try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])) ?? Data()
        try? data.write(to: url)
        return url
    }
}

extension Probe: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch central.state {
        case .poweredOn: refresh()
        case .unauthorized: state = "Bluetooth izni yok: Ayarlar → BandProbe"
        case .poweredOff: state = "Bluetooth kapalı"
        default: state = "Bluetooth durumu: \(central.state.rawValue)"
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]
        guard serviceData?[Self.fe95] != nil else { return }
        add(peripheral, source: "FE95 reklamı")
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        connectedName = peripheral.name
        switch mode {
        case .survey:
            state = "Bağlandı, servisler keşfediliyor…"
            note("bağlandı: \(peripheral.name ?? "(isimsiz)")")
            peripheral.discoverServices(nil)
        case .auth:
            authNote("bağlandı, FE95 aranıyor")
            peripheral.discoverServices([Self.fe95])
        }
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        if mode == .auth {
            authState = "Bağlanamadı"
            authNote("bağlanamadı: \(error?.localizedDescription ?? "?")")
        } else {
            state = "Bağlanamadı"
            note("bağlanamadı: \(error?.localizedDescription ?? "?")")
        }
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if mode == .auth {
            authNote("bağlantı kapandı \(error?.localizedDescription ?? "")")
        } else {
            note("bağlantı kapandı \(error?.localizedDescription ?? "")")
        }
    }
}

extension Probe: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        if mode == .auth {
            guard let service = peripheral.services?.first(where: { $0.uuid == Self.fe95 }) else {
                authNote("FE95 servisi bulunamadı \(error?.localizedDescription ?? "")")
                return
            }
            peripheral.discoverCharacteristics([Self.rxUUID, Self.txUUID], for: service)
            return
        }
        if let error { note("servis keşfi hatası: \(error.localizedDescription)") }
        for s in peripheral.services ?? [] {
            serviceIndex[ObjectIdentifier(s)] = services.count
            services.append(ServiceRow(uuid: s.uuid.uuidString, isPrimary: s.isPrimary))
            peripheral.discoverCharacteristics(nil, for: s)
        }
        state = "\(services.count) servis bulundu"
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        if mode == .auth {
            rx = service.characteristics?.first { $0.uuid == Self.rxUUID }
            tx = service.characteristics?.first { $0.uuid == Self.txUUID }
            guard let rx, tx != nil else {
                authNote("005E/005F bulunamadı")
                return
            }
            authNote("005E bildirimi açılıyor (yazma boyu \(peripheral.maximumWriteValueLength(for: .withoutResponse)))")
            peripheral.setNotifyValue(true, for: rx)
            return
        }
        if let error { note("\(service.uuid.uuidString) karakteristik hatası: \(error.localizedDescription)") }
        guard let si = serviceIndex[ObjectIdentifier(service)] else { return }
        for c in service.characteristics ?? [] {
            charIndex[ObjectIdentifier(c)] = (si, services[si].characteristics.count)
            services[si].characteristics.append(CharRow(uuid: c.uuid.uuidString, properties: Self.names(c.properties)))
            peripheral.discoverDescriptors(for: c)
            if Self.readAllowlist.contains(c.uuid.uuidString), c.properties.contains(.read) {
                peripheral.readValue(for: c)
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard mode == .auth, characteristic.uuid == Self.rxUUID else { return }
        if let error {
            authNote("bildirim açılamadı: \(error.localizedDescription)")
            authState = "Bildirim açılamadı"
            return
        }
        if characteristic.isNotifying, authStep == 0 { startSession() }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pump()
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverDescriptorsFor characteristic: CBCharacteristic, error: Error?) {
        guard let idx = charIndex[ObjectIdentifier(characteristic)] else { return }
        services[idx.0].characteristics[idx.1].descriptors = (characteristic.descriptors ?? []).map(\.uuid.uuidString)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        if mode == .auth, characteristic.uuid == Self.rxUUID {
            if let value = characteristic.value { receive(value) }
            return
        }
        guard let idx = charIndex[ObjectIdentifier(characteristic)] else { return }
        if let error {
            services[idx.0].characteristics[idx.1].value = "okuma hatası: \(error.localizedDescription)"
            return
        }
        let data = characteristic.value ?? Data()
        let key = characteristic.uuid.uuidString
        var text: String
        if key == "2A19", let level = data.first {
            text = "\(level)%"
        } else {
            text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .controlCharacters)
        }
        if key == "2A25", text.count > 4 {
            text = String(repeating: "*", count: text.count - 4) + text.suffix(4)
        }
        services[idx.0].characteristics[idx.1].value = text
    }

    static func names(_ p: CBCharacteristicProperties) -> [String] {
        let all: [(CBCharacteristicProperties, String)] = [
            (.broadcast, "broadcast"), (.read, "read"), (.writeWithoutResponse, "write-without-response"),
            (.write, "write"), (.notify, "notify"), (.indicate, "indicate"),
            (.authenticatedSignedWrites, "signed-write"), (.extendedProperties, "extended"),
            (.notifyEncryptionRequired, "notify-encrypted"), (.indicateEncryptionRequired, "indicate-encrypted"),
        ]
        return all.filter { p.contains($0.0) }.map(\.1)
    }
}
