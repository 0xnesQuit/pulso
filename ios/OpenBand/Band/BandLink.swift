import CoreBluetooth
import Foundation

/// What a session needs to find and unlock one band.
struct BandTarget {
    let id: UUID
    let name: String
    let mac: String?
    let macSuffix: String?
    let key: Data
}

/// One BLE session with a band at a time: find it (iOS connection or advertisement), open an
/// SPP v2 session on FE95/005E/005F, authenticate as an iOS companion, read battery and live
/// stats, then always hand the channel back (unsubscribe 005E, release the connection) so
/// Mi Fitness keeps working. Protocol details: findings.md, sections 4–6.
final class BandLink: NSObject, ObservableObject {
    enum Purpose { case check, sync, live }

    enum Phase: Equatable {
        case idle, searching, connecting, authenticating, reading, live, done
        case failed(String)

        var isBusy: Bool {
            switch self {
            case .searching, .connecting, .authenticating, .reading, .live: return true
            default: return false
            }
        }

        var label: String {
            switch self {
            case .idle: return ""
            case .searching: return "Bant aranıyor…"
            case .connecting: return "Bağlanılıyor…"
            case .authenticating: return "Kimlik doğrulanıyor…"
            case .reading: return "Veri okunuyor…"
            case .live: return "Canlı"
            case .done: return "Senkronize edildi"
            case .failed(let message): return message
            }
        }
    }

    static let fe95 = CBUUID(string: "FE95")
    static let rxUUID = CBUUID(string: "005E")
    static let txUUID = CBUUID(string: "005F")
    static let liveLimit: TimeInterval = 120
    static let syncWindow: TimeInterval = 12

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var bandID: UUID?
    @Published private(set) var stats: MiAuth.LiveStats?
    @Published private(set) var battery: Int?
    @Published private(set) var log: [String] = []
    /// Bands iOS holds a connection to right now (no session needed to know this).
    @Published private(set) var nearby: Set<UUID> = []
    @Published private(set) var bluetooth: CBManagerState = .unknown

    /// Every observation, on the main queue.
    var onSample: ((UUID, SampleDraft) -> Void)?
    /// Once per session, on the main queue; `true` when the band was read.
    var onFinish: ((UUID, Bool) -> Void)?

    private var central: CBCentralManager!
    private var target: BandTarget?
    private var purpose = Purpose.sync
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var buffer: [UInt8] = []
    private var writeQueue: [Data] = []
    private var seq: UInt8 = 0
    private var phoneNonce = Data()
    private var keys: MiAuth.SessionKeys?
    private var active = false
    private var authed = false
    private var finishing = false
    private var run = 0
    private var pendingStart: (() -> Void)?

    override init() {
        super.init()
        central = CBCentralManager(delegate: self, queue: .main)
    }

    // MARK: control

    func start(_ target: BandTarget, purpose: Purpose) {
        guard !phase.isBusy else { return }
        run += 1
        let thisRun = run
        self.target = target
        self.purpose = purpose
        bandID = target.id
        stats = nil
        battery = nil
        log = []
        peripheral = nil
        rx = nil
        tx = nil
        buffer = []
        writeQueue = []
        seq = 0
        keys = nil
        phoneNonce = Data()
        authed = false
        finishing = false
        active = true
        note("başlat: \(target.name)")

        after(25, thisRun) { [weak self] in
            guard let self, self.active, !self.authed else { return }
            self.fail("Bant cevap vermedi. Mi Fitness'ı kapatıp tekrar dene.")
        }

        switch central.state {
        case .poweredOn:
            locate(thisRun)
        case .unknown, .resetting:
            phase = .searching
            pendingStart = { [weak self] in self?.locate(thisRun) }
        default:
            fail(Self.message(for: central.state))
        }
    }

    /// Ends live or sync early; what was read so far is kept.
    func stop() {
        guard active else { return }
        note("kullanıcı durdurdu")
        finish()
    }

    /// Cheap check, no session: which of these bands is connected to the phone at the moment.
    func refreshNearby(_ bands: [(id: UUID, suffix: String?)]) {
        guard central.state == .poweredOn else {
            nearby = []
            return
        }
        let connected = central.retrieveConnectedPeripherals(withServices: [Self.fe95]).compactMap { $0.name?.uppercased() }
        nearby = Set(bands.compactMap { band in
            guard let suffix = band.suffix, connected.contains(where: { $0.hasSuffix(suffix) }) else { return nil }
            return band.id
        })
    }

    // MARK: finding the band

    private func locate(_ thisRun: Int) {
        guard run == thisRun, active else { return }
        phase = .searching
        let connected = central.retrieveConnectedPeripherals(withServices: [Self.fe95])
        if let match = connected.first(where: { nameMatches($0.name) }) {
            note("iOS'ta bağlı: \(match.name ?? "?")")
            connect(match)
            return
        }
        note("iOS'ta bağlı değil, yayın aranıyor")
        central.scanForPeripherals(withServices: nil, options: nil)
        after(12, thisRun) { [weak self] in
            guard let self, self.phase == .searching else { return }
            self.central.stopScan()
            self.fail("Bant bulunamadı. Bileğinde, yakında ve şarjlı olduğundan emin ol.")
        }
    }

    private func nameMatches(_ name: String?) -> Bool {
        guard let suffix = target?.macSuffix, let name else { return false }
        return name.uppercased().hasSuffix(suffix)
    }

    /// MiBeacon service data under FE95 carries the MAC (reversed) when frame-control bit 4 is set.
    static func beaconMAC(_ data: Data) -> String? {
        let b = [UInt8](data)
        guard b.count >= 11, b[0] & 0x10 != 0 else { return nil }
        return b[5...10].reversed().map { String(format: "%02X", $0) }.joined()
    }

    private func connect(_ p: CBPeripheral) {
        central.stopScan()
        peripheral = p
        p.delegate = self
        phase = .connecting
        central.connect(p, options: nil)
    }

    // MARK: session

    private func startSession() {
        phase = .authenticating
        note("→ SessionConfig")
        send(MiFrame.encode(kind: MiFrame.kindSessionConfig, seq: 0, payload: MiFrame.startSessionPayload))
    }

    private func startAuth() {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        phoneNonce = nonce
        note("→ auth 1/2")
        sendCommand(MiAuth.nonceCommand(phoneNonce: nonce), encrypted: false)
    }

    private func didAuthenticate() {
        authed = true
        phase = purpose == .live ? .live : .reading
        note("auth tamam → pil + canlı istatistik")
        sendCommand(MiAuth.batteryCommand(), encrypted: true)
        sendCommand(MiAuth.realtimeCommand(start: true), encrypted: true)
        let thisRun = run
        let window = purpose == .live ? Self.liveLimit : Self.syncWindow
        after(window, thisRun) { [weak self] in
            guard let self, self.active else { return }
            self.note("süre doldu (\(Int(window)) sn)")
            self.finish()
        }
    }

    private func handle(_ command: PBMessage) {
        let type = command.varints[1] ?? 0
        let subtype = command.varints[2] ?? 0
        switch (type, subtype) {
        case (MiAuth.commandTypeAuth, MiAuth.subtypeNonce):
            guard let verify = command.message(3)?.message(31),
                  let watchNonce = verify.blobs[1], let watchHmac = verify.blobs[2] else {
                fail("Bant kimlik doğrulamayı reddetti. Mi Fitness'ı kapatıp tekrar dene.")
                return
            }
            guard let target,
                  let result = MiAuth.confirmCommand(authKey: target.key, phoneNonce: phoneNonce,
                                                     watchNonce: watchNonce, watchHmac: watchHmac,
                                                     deviceName: "OpenBand") else {
                fail("Anahtar bu bantla eşleşmiyor. Mi Fitness klasöründen anahtarı yeniden oku.")
                return
            }
            keys = result.keys
            note("→ auth 2/2")
            sendCommand(result.command, encrypted: false)

        case (MiAuth.commandTypeAuth, MiAuth.subtypeAuth):
            didAuthenticate()

        case (2, 1):
            guard let level = MiAuth.batteryLevel(command) else { return }
            battery = Int(level)
            emit(.battery(Int(level)))
            if purpose == .check, stats != nil { finish() }

        case (8, 47):
            guard let live = MiAuth.liveStats(command) else { return }
            stats = live
            emit(.live(live))
            switch purpose {
            case .check where battery != nil: finish()
            case .sync where live.heartRate > 10: finish()
            default: break
            }

        default:
            note("← \(type)/\(subtype) işlenmedi")
        }
    }

    private func emit(_ draft: SampleDraft) {
        guard let id = target?.id else { return }
        onSample?(id, draft)
    }

    /// Stops the live stream, then releases the channel.
    private func finish() {
        guard active, !finishing else { return }
        finishing = true
        if authed { sendCommand(MiAuth.realtimeCommand(start: false), encrypted: true) }
        let thisRun = run
        after(0.4, thisRun) { [weak self] in
            guard let self else { return }
            let ok = self.authed
            self.release()
            self.phase = ok ? .done : .failed("Bant okunamadı.")
            if let id = self.target?.id { self.onFinish?(id, ok) }
        }
    }

    private func fail(_ message: String) {
        guard active else { return }
        note("hata: \(message)")
        release()
        phase = .failed(message)
        if let id = target?.id { onFinish?(id, false) }
    }

    /// Hands the channel back to Mi Fitness.
    private func release() {
        active = false
        pendingStart = nil
        writeQueue = []
        if central.isScanning { central.stopScan() }
        if let p = peripheral {
            if let rx, rx.isNotifying { p.setNotifyValue(false, for: rx) }
            central.cancelPeripheralConnection(p)
        }
        note("kanal bırakıldı")
    }

    // MARK: frames

    private func sendCommand(_ protobuf: Data, encrypted: Bool) {
        var body = protobuf
        if encrypted, let keys { body = MiCrypto.ctr(key: keys.encryptionKey, protobuf) }
        let payload = Data([0x01, encrypted ? 0x02 : 0x01]) + body
        send(MiFrame.encode(kind: MiFrame.kindData, seq: seq, payload: payload))
        seq &+= 1
    }

    private func send(_ frame: Data) {
        guard let p = peripheral else { return }
        let size = max(20, p.maximumWriteValueLength(for: .withoutResponse))
        var offset = 0
        while offset < frame.count {
            writeQueue.append(frame.subdata(in: offset..<min(offset + size, frame.count)))
            offset += size
        }
        pump()
    }

    private func pump() {
        guard let p = peripheral, let tx else { return }
        while !writeQueue.isEmpty, p.canSendWriteWithoutResponse {
            p.writeValue(writeQueue.removeFirst(), for: tx, type: .withoutResponse)
        }
    }

    private func receive(_ chunk: Data) {
        guard active else { return }
        buffer.append(contentsOf: chunk)
        for packet in MiFrame.drain(&buffer) {
            switch packet.kind {
            case MiFrame.kindSessionConfig:
                if phoneNonce.isEmpty { startAuth() }
            case MiFrame.kindData:
                send(MiFrame.encode(kind: MiFrame.kindAck, seq: packet.seq, payload: Data()))
                decode(packet)
            case MiFrame.kindNack:
                note("← NACK \(packet.seq)")
            default:
                break
            }
        }
    }

    private func decode(_ packet: MiFrame.Packet) {
        guard packet.payload.count >= 2 else { return }
        let channel = packet.payload[0] & 0x0F
        let opcode = packet.payload[1]
        var body = Data(packet.payload.dropFirst(2))
        if opcode == 2 {
            guard let keys else { return }
            body = MiCrypto.ctr(key: keys.decryptionKey, body)
        }
        guard channel == 1, let command = PBMessage(body) else { return }
        handle(command)
    }

    // MARK: helpers

    private func after(_ seconds: TimeInterval, _ thisRun: Int, _ work: @escaping () -> Void) {
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, self.run == thisRun else { return }
            work()
        }
    }

    private func note(_ text: String) {
        log.append("\(Date().formatted(date: .omitted, time: .standard))  \(text)")
    }

    static func message(for state: CBManagerState) -> String {
        switch state {
        case .poweredOff: return "Bluetooth kapalı. Denetim Merkezi'nden aç."
        case .unauthorized: return "OpenBand'in Bluetooth izni yok. Ayarlar > OpenBand'den izin ver."
        case .unsupported: return "Bu cihaz Bluetooth LE desteklemiyor."
        default: return "Bluetooth hazır değil. Biraz sonra tekrar dene."
        }
    }
}

extension BandLink: CBCentralManagerDelegate {
    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        bluetooth = central.state
        if central.state == .poweredOn, let start = pendingStart {
            pendingStart = nil
            start()
        } else if active, central.state != .poweredOn, central.state != .unknown, central.state != .resetting {
            fail(Self.message(for: central.state))
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard phase == .searching, let target else { return }
        let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data]
        let advertisedName = advertisementData[CBAdvertisementDataLocalNameKey] as? String ?? peripheral.name
        var match = nameMatches(advertisedName)
        if !match, let beacon = serviceData?[Self.fe95], let mac = Self.beaconMAC(beacon),
           let wanted = target.mac?.uppercased().filter(\.isHexDigit) {
            match = mac == wanted
        }
        guard match else { return }
        note("yayında bulundu (\(RSSI) dBm)")
        connect(peripheral)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        guard active, peripheral == self.peripheral else { return }
        note("bağlandı")
        peripheral.discoverServices([Self.fe95])
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard active, peripheral == self.peripheral else { return }
        fail("Banda bağlanılamadı. Bluetooth'u kapatıp açıp tekrar dene.")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard active, peripheral == self.peripheral else { return }
        fail("Bağlantı koptu. Bandı yakına getirip tekrar dene.")
    }
}

extension BandLink: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard active else { return }
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.fe95 }) else {
            fail("Bu bant OpenBand'in kullandığı BLE kanalını açmıyor.")
            return
        }
        peripheral.discoverCharacteristics([Self.rxUUID, Self.txUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard active else { return }
        rx = service.characteristics?.first { $0.uuid == Self.rxUUID }
        tx = service.characteristics?.first { $0.uuid == Self.txUUID }
        guard let rx, tx != nil else {
            fail("Bu bant OpenBand'in kullandığı BLE kanalını açmıyor.")
            return
        }
        peripheral.setNotifyValue(true, for: rx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard active, characteristic.uuid == Self.rxUUID else { return }
        if error != nil {
            fail("Bant veri kanalını açmadı. Tekrar dene.")
        } else if characteristic.isNotifying, keys == nil, !authed {
            startSession()
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic.uuid == Self.rxUUID, let value = characteristic.value else { return }
        receive(value)
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pump()
    }
}
