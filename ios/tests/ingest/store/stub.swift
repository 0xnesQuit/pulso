// The one app type Data/Models.swift needs from Band/MiProtocol.swift (which pulls in
// CoreBluetooth and CryptoKit); same shape as the real one.
enum MiAuth {
    struct LiveStats: Equatable {
        let steps: UInt64
        let calories: UInt64
        let heartRate: UInt64
        let standingHours: UInt64
    }
}
