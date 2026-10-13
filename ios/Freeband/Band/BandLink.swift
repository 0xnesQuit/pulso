import CoreBluetooth
import Foundation

/// What a session needs to find and unlock one band.
struct BandTarget {
    let id: UUID
    let name: String
    let mac: String?
    let macSuffix: String?
    /// Candidate auth keys, tried in order until the band's HMAC matches.
    let keys: [Data]
}

/// One BLE session with a band at a time: find it (iOS connection or advertisement), open an
/// SPP v2 session on FE95/005E/005F, authenticate as an iOS companion, read battery and live
/// stats, then always hand the channel back (unsubscribe 005E, release the connection) so
/// Mi Fitness keeps working. Protocol details: findings.md, sections 4–6.
final class BandLink: NSObject, ObservableObject {
    /// `send` authenticates, sends the given protobuf commands encrypted, then lets go.
    enum Purpose: Equatable { case check, sync, live, send([Data]) }

    /// How a session ended. A sync is complete only when every listed file arrived; anything
    /// less is partial (what arrived is kept) and does not count as a successful sync.
    enum Outcome: Equatable {
        case complete
        case partial(String)
        case failed(LinkError)

        var isSuccess: Bool { self == .complete }

        var label: String {
            switch self {
            case .complete: return "complete"
            case .partial(let reason): return "partial: \(reason)"
            case .failed(let error): return "failed: \(error.code)"
            }
        }
    }

    /// Why a session failed. `message` keeps the existing user-facing sentences (localization
    /// comes with the redesign).
    enum LinkError: Error, Equatable {
        /// The band answered but refused the session: Mi Fitness holds the channel.
        case bandHeldByMiFitness
        case bluetoothOff
        case unauthorized
        case bluetoothUnsupported
        case bluetoothNotReady
        /// The key did not match the band's HMAC (every candidate tried).
        case wrongKey
        /// Not connected to iOS and not advertising.
        case notFound
        /// No answer before authentication completed.
        case timeout
        case disconnected
        case connectFailed
        /// The band does not expose FE95/005E/005F.
        case channelUnavailable
        /// Subscribing to 005E failed.
        case channelRefused
        /// The session ended (stopped) before the band was read.
        case notRead

        var code: String {
            switch self {
            case .bandHeldByMiFitness: return "band_held_by_mi_fitness"
            case .bluetoothOff: return "bluetooth_off"
            case .unauthorized: return "unauthorized"
            case .bluetoothUnsupported: return "bluetooth_unsupported"
            case .bluetoothNotReady: return "bluetooth_not_ready"
            case .wrongKey: return "wrong_key"
            case .notFound: return "not_found"
            case .timeout: return "timeout"
            case .disconnected: return "disconnected"
            case .connectFailed: return "connect_failed"
            case .channelUnavailable: return "channel_unavailable"
            case .channelRefused: return "channel_refused"
            case .notRead: return "not_read"
            }
        }

        var message: String {
            switch self {
            case .bandHeldByMiFitness: return "Bant kimlik doğrulamayı reddetti. Mi Fitness'ı kapatıp tekrar dene."
            case .bluetoothOff: return BandLink.message(for: .poweredOff)
            case .unauthorized: return BandLink.message(for: .unauthorized)
            case .bluetoothUnsupported: return BandLink.message(for: .unsupported)
            case .bluetoothNotReady: return BandLink.message(for: .unknown)
            case .wrongKey: return "Anahtar bu bantla eşleşmiyor. Bandı Mi Fitness'ta senkronize edip anahtarı yeniden oku."
            case .notFound: return "Bant bulunamadı. Bileğinde, yakında ve şarjlı olduğundan emin ol."
            case .timeout: return "Bant cevap vermedi. Mi Fitness'ı kapatıp tekrar dene."
            case .disconnected: return "Bağlantı koptu. Bandı yakına getirip tekrar dene."
            case .connectFailed: return "Banda bağlanılamadı. Bluetooth'u kapatıp açıp tekrar dene."
            case .channelUnavailable: return "Bu bant Freeband'in kullandığı BLE kanalını açmıyor."
            case .channelRefused: return "Bant veri kanalını açmadı. Tekrar dene."
            case .notRead: return "Bant okunamadı."
            }
        }

        static func bluetooth(_ state: CBManagerState) -> LinkError {
            switch state {
            case .poweredOff: return .bluetoothOff
            case .unauthorized: return .unauthorized
            case .unsupported: return .bluetoothUnsupported
            default: return .bluetoothNotReady
            }
        }
    }

    enum Phase: Equatable {
        case idle, searching, connecting, authenticating, reading, live, done
        /// The session ended with part of the data (see Outcome.partial).
        case partial(String)
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
            case .partial(let reason): return reason
            case .failed(let message): return message
            }
        }
    }

    static let fe95 = CBUUID(string: "FE95")
    static let rxUUID = CBUUID(string: "005E")
    static let txUUID = CBUUID(string: "005F")
    static let liveLimit: TimeInterval = 120
    static let syncWindow: TimeInterval = 12
    /// Upper bound for a sync that also fetches activity files.
    static let fileSyncLimit: TimeInterval = 120

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
    /// Once per session, on the main queue.
    var onFinish: ((UUID, Outcome) -> Void)?
    /// How the last session ended.
    @Published private(set) var lastOutcome: Outcome?
    /// After authentication: which candidate key worked and the band's own Bluetooth name.
    var onIdentified: ((UUID, Int, String?) -> Void)?
    /// Past activity files already stored need not be fetched again (today's always are).
    var hasActivityFile: ((UUID, String) -> Bool)?
    /// A complete, CRC-checked activity file; `today` when it came from the band's today list.
    var onActivityFile: ((UUID, ActivityFileID, Data, Bool) -> Void)?

    /// Firmware, serial and model, read after authentication.
    var onDeviceInfo: ((UUID, MiAuth.DeviceInfo) -> Void)?
    /// Worn / charging / asleep, read after authentication and pushed by the band when it changes.
    @Published private(set) var deviceState: MiAuth.DeviceState?

    /// Activity files fetched / requested in this sync.
    @Published private(set) var fileProgress: (done: Int, total: Int)?

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
    private var realtimeOn = false

    // activity-file sync (docs/ACTIVITY.md): list today, list past, then one file at a time
    private enum FileStage { case idle, listingToday, listingPast, fetching, done }
    private var fileStage = FileStage.idle
    private var todayIDs: [ActivityFileID] = []
    private var fileQueue: [ActivityFileID] = []
    private var currentFile: ActivityFileID?
    private var currentRetried = false
    private var assembler = ActivityAssembler()
    private var fileToken = 0
    private var run = 0
    private var keyIndex = 0
    private var pendingStart: (() -> Void)?
    /// Files that arrived complete (CRC-checked) in this sync.
    private var filesReceived = 0
    /// The file list did not arrive in time; the sync went on without files.
    private var fileListMissing = false

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
        realtimeOn = false
        keyIndex = 0
        deviceState = nil
        fileStage = .idle
        todayIDs = []
        fileQueue = []
        currentFile = nil
        fileProgress = nil
        filesReceived = 0
        fileListMissing = false
        active = true
        note("başlat: \(target.name), \(target.keys.count) anahtar")

        after(25, thisRun) { [weak self] in
            guard let self, self.active, !self.authed else { return }
            self.fail(.timeout)
        }

        switch central.state {
        case .poweredOn:
            locate(thisRun)
        case .unknown, .resetting:
            phase = .searching
            pendingStart = { [weak self] in self?.locate(thisRun) }
        default:
            fail(.bluetooth(central.state))
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
            self.fail(.notFound)
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
        if let id = target?.id { onIdentified?(id, keyIndex, peripheral?.name) }
        // Every session keeps the band's clock and time zone right (Mi Fitness may be gone) and
        // reads what the band is and how it is worn.
        sendCommand(MiAuth.clockCommand(is24Hour: MiAuth.phoneUses24Hour), encrypted: true)
        sendCommand(MiAuth.systemGet(2), encrypted: true)
        sendCommand(MiAuth.systemGet(78), encrypted: true)
        if case .send(let commands) = purpose {
            phase = .reading
            note("auth tamam → \(commands.count) komut gönderiliyor")
            for command in commands { sendCommand(command, encrypted: true) }
            let thisRun = run
            after(2.0, thisRun) { [weak self] in self?.finish() }
            return
        }
        phase = purpose == .live ? .live : .reading
        note("auth tamam → pil + canlı istatistik")
        sendCommand(MiAuth.batteryCommand(), encrypted: true)
        sendCommand(MiAuth.realtimeCommand(start: true), encrypted: true)
        realtimeOn = true
        if purpose == .sync {
            fileStage = .listingToday
            note("→ bugünün dosya listesi")
            sendCommand(MiAuth.activityListCommand(today: true), encrypted: true)
            let listRun = run
            after(10, listRun) { [weak self] in
                guard let self, self.fileStage == .listingToday || self.fileStage == .listingPast else { return }
                self.note("dosya listesi gelmedi, dosyasız devam")
                self.fileListMissing = true
                self.fileStage = .done
                self.finishSyncIfDone()
            }
        }
        let thisRun = run
        let window = purpose == .live ? Self.liveLimit : (purpose == .sync ? Self.fileSyncLimit : Self.syncWindow)
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
                fail(.bandHeldByMiFitness)
                return
            }
            guard let target, keyIndex < target.keys.count else { return }
            guard let result = MiAuth.confirmCommand(authKey: target.keys[keyIndex], phoneNonce: phoneNonce,
                                                     watchNonce: watchNonce, watchHmac: watchHmac,
                                                     deviceName: "Freeband") else {
                if keyIndex + 1 < target.keys.count {
                    retryWithNextKey()
                } else {
                    fail(.wrongKey)
                }
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
            case .sync where live.heartRate > 10: finishSyncIfDone()
            default: break
            }

        case (8, 1) where fileStage == .listingToday:
            todayIDs = ActivityFileID.list(MiAuth.activityFileIDBytes(command))
            note("← bugün \(todayIDs.count) dosya; → geçmiş listesi")
            fileStage = .listingPast
            sendCommand(MiAuth.activityListCommand(today: false), encrypted: true)

        case (8, 2) where fileStage == .listingPast:
            let past = ActivityFileID.list(MiAuth.activityFileIDBytes(command))
            let id = target?.id
            let wanted = past.filter { file in
                guard let id, let has = hasActivityFile else { return true }
                return !has(id, file.hex)
            }
            fileQueue = Array(Set(todayIDs + wanted)).sorted()
            note("← geçmiş \(past.count) dosya, \(wanted.count) yeni; toplam \(fileQueue.count) istenecek")
            fileProgress = (0, fileQueue.count)
            fileStage = .fetching
            fetchNextFile()

        case (8, 3), (8, 5):
            break

        case (2, 2):
            if let info = MiAuth.deviceInfo(command), let id = target?.id {
                note("← cihaz: \(info.model), firmware \(info.firmware)")
                onDeviceInfo?(id, info)
            }

        case (2, 78), (2, 79):
            if let state = MiAuth.deviceState(command) { deviceState = state }

        case (2, 3):
            note("← saat ayarlandı (durum \(command.varints[100] ?? 0))")

        default:
            note("← \(type)/\(subtype) işlenmedi")
        }
    }

    // MARK: activity files

    private func fetchNextFile() {
        guard active, fileStage == .fetching else { return }
        guard !fileQueue.isEmpty else {
            fileStage = .done
            currentFile = nil
            note("dosyalar tamam")
            finishSyncIfDone()
            return
        }
        let file = fileQueue.removeFirst()
        currentFile = file
        currentRetried = false
        requestCurrentFile()
    }

    private func requestCurrentFile() {
        guard let file = currentFile else { return }
        assembler = ActivityAssembler()
        sendCommand(MiAuth.activityFetchCommand(file.data), encrypted: true)
        armFileTimer()
    }

    /// 5 s per chunk; one retry, then the file is skipped for this sync.
    private func armFileTimer() {
        fileToken += 1
        let token = fileToken
        after(5, run) { [weak self] in
            guard let self, self.fileToken == token, self.fileStage == .fetching, let file = self.currentFile else { return }
            if !self.currentRetried {
                self.currentRetried = true
                self.note("dosya \(file.hex) cevap vermedi, tekrar")
                self.requestCurrentFile()
            } else {
                self.note("dosya \(file.hex) atlandı")
                self.advanceFileProgress()
                self.fetchNextFile()
            }
        }
    }

    private func receiveActivityChunk(_ packet: Data) {
        guard fileStage == .fetching, let file = currentFile else { return }
        switch assembler.add(packet) {
        case .needMore:
            armFileTimer()
        case .complete(let data):
            fileToken += 1
            if let id = target?.id { onActivityFile?(id, file, data, todayIDs.contains(file)) }
            filesReceived += 1
            advanceFileProgress()
            fetchNextFile()
        case .failed(let reason):
            fileToken += 1
            note("dosya \(file.hex) bozuk: \(reason)")
            advanceFileProgress()
            fetchNextFile()
        }
    }

    private func advanceFileProgress() {
        if let progress = fileProgress { fileProgress = (progress.done + 1, progress.total) }
    }

    /// A sync ends once its files are in and a heart-rate reading has arrived (or the limit hits).
    private func finishSyncIfDone() {
        guard purpose == .sync else { return }
        let filesDone = fileStage == .done || fileStage == .idle
        if filesDone, (stats?.heartRate ?? 0) > 10 { finish() }
        if filesDone, fileStage == .done, stats != nil {
            // files finished; give the pulse a few seconds, then end anyway
            let thisRun = run
            after(8, thisRun) { [weak self] in
                guard let self, self.active, self.purpose == .sync else { return }
                self.finish()
            }
        }
    }

    private func emit(_ draft: SampleDraft) {
        guard let id = target?.id else { return }
        onSample?(id, draft)
    }

    /// The band rejected this key: drop the session and start again with the next candidate.
    private func retryWithNextKey() {
        keyIndex += 1
        note("anahtar tutmadı, \(keyIndex + 1). anahtar deneniyor")
        if let p = peripheral {
            if let rx, rx.isNotifying { p.setNotifyValue(false, for: rx) }
            central.cancelPeripheralConnection(p)
        }
        peripheral = nil
        rx = nil
        tx = nil
        buffer = []
        writeQueue = []
        seq = 0
        keys = nil
        phoneNonce = Data()
        let thisRun = run
        after(1.0, thisRun) { [weak self] in self?.locate(thisRun) }
    }

    /// Stops the live stream, then releases the channel.
    private func finish() {
        guard active, !finishing else { return }
        finishing = true
        if authed, realtimeOn { sendCommand(MiAuth.realtimeCommand(start: false), encrypted: true) }
        let thisRun = run
        after(0.4, thisRun) { [weak self] in
            guard let self else { return }
            let outcome = self.authed ? self.completion() : .failed(.notRead)
            self.release()
            switch outcome {
            case .complete: self.phase = .done
            case .partial(let reason): self.phase = .partial(reason)
            case .failed(let error): self.phase = .failed(error.message)
            }
            self.note("sonuç: \(outcome.label)")
            self.lastOutcome = outcome
            if let id = self.target?.id { self.onFinish?(id, outcome) }
        }
    }

    /// An authenticated session: complete unless it was a sync whose file list never came or
    /// whose files did not all arrive (skipped, corrupt, or cut off by the time limit or a stop).
    private func completion() -> Outcome {
        guard purpose == .sync else { return .complete }
        if fileListMissing || fileStage == .idle || fileStage == .listingToday || fileStage == .listingPast {
            return .partial("Dosya listesi alınamadı; kayıtlar sonraki senkronda.")
        }
        let total = fileProgress?.total ?? 0
        if filesReceived < total {
            return .partial("\(total) dosyadan \(filesReceived) tanesi alındı; kalanı sonraki senkronda.")
        }
        return .complete
    }

    private func fail(_ error: LinkError) {
        guard active else { return }
        note("hata: \(error.code): \(error.message)")
        release()
        phase = .failed(error.message)
        lastOutcome = .failed(error)
        if let id = target?.id { onFinish?(id, .failed(error)) }
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
        if channel == 5 {
            receiveActivityChunk(body)
            return
        }
        guard channel == 1, let command = PBMessage(body) else { return }
        if command.varints[1] == 2, command.varints[2] == 110 {
            // Unknown everywhere (docs/CAPABILITIES.md §16); keep the bytes for decoding later.
            note("← 2/110 \(body.count) bayt: \(body.map { String(format: "%02x", $0) }.joined())")
        }
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
        case .unauthorized: return "Freeband'in Bluetooth izni yok. Ayarlar > Freeband'den izin ver."
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
            fail(.bluetooth(central.state))
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
        fail(.connectFailed)
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard active, peripheral == self.peripheral else { return }
        fail(.disconnected)
    }
}

extension BandLink: CBPeripheralDelegate {
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard active else { return }
        guard let service = peripheral.services?.first(where: { $0.uuid == Self.fe95 }) else {
            fail(.channelUnavailable)
            return
        }
        peripheral.discoverCharacteristics([Self.rxUUID, Self.txUUID], for: service)
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard active else { return }
        rx = service.characteristics?.first { $0.uuid == Self.rxUUID }
        tx = service.characteristics?.first { $0.uuid == Self.txUUID }
        guard let rx, tx != nil else {
            fail(.channelUnavailable)
            return
        }
        peripheral.setNotifyValue(true, for: rx)
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard active, characteristic.uuid == Self.rxUUID else { return }
        if error != nil {
            fail(.channelRefused)
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
