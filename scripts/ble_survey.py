"""Read-only BLE survey of a Xiaomi Smart Band from macOS (CoreBluetooth via bleak).

What it does:
  1. Scans and prints advertisement data for Xiaomi-looking devices.
  2. Optionally connects to one of them and enumerates every GATT service,
     characteristic and descriptor with its properties.
  3. Reads only the standard Device Information (0x180A) and Battery Level
     (0x2A19) characteristics.

What it never does: write a characteristic or descriptor, enable notifications
or indications, request pairing/bonding, or read any vendor characteristic.

Usage:
  uv run scripts/ble_survey.py                  # scan only, Xiaomi candidates
  uv run scripts/ble_survey.py --all            # scan only, every device
  uv run scripts/ble_survey.py --connect        # scan, then survey the band
  uv run scripts/ble_survey.py --connect --address <CoreBluetooth UUID>
"""

import argparse
import asyncio
import json
import re
import sys
from datetime import datetime
from pathlib import Path

from bleak import BleakClient, BleakScanner

XIAOMI_COMPANY_ID = 0x038F
NAME_RE = re.compile(r"(Xiaomi|Smart Band|Mi Band|Redmi)", re.IGNORECASE)


def u16(short: str) -> str:
    return f"0000{short.lower()}-0000-1000-8000-00805f9b34fb"


# UUIDs Gadgetbridge knows for the Xiaomi protobuf protocol (XiaomiUuids.java)
KNOWN = {
    u16("fe95"): "Xiaomi service (BLE V1 encrypted set, and BLE V2)",
    u16("0051"): "V1 command read (notify)",
    u16("0052"): "V1 command write",
    u16("0053"): "V1 activity data",
    u16("0055"): "V1 data upload",
    u16("005e"): "V2 RX (watch -> phone, notify)",
    u16("005f"): "V2 TX (phone -> watch, write)",
    "16186f00-0000-1000-8000-00807f9b34fb": "Mi Watch Lite / Redmi Watch service",
    "16187f00-0000-1000-8000-00807f9b34fb": "Mi Watch 4C / Redmi Band service",
    "1314f000-1000-9000-7000-301291e21220": "Mi Watch Color service",
    "7495fe00-a7f3-424b-92dd-4a006a3aef56": "Mi Watch CN service",
    u16("1101"): "Serial Port Profile (Classic, should not appear in GATT)",
}

# The only characteristics this script will read.
READ_ALLOWLIST = {
    u16("2a29"): "Manufacturer Name",
    u16("2a24"): "Model Number",
    u16("2a25"): "Serial Number",
    u16("2a27"): "Hardware Revision",
    u16("2a26"): "Firmware Revision",
    u16("2a28"): "Software Revision",
    u16("2a23"): "System ID",
    u16("2a50"): "PnP ID",
    u16("2a19"): "Battery Level",
}


def hexs(b: bytes) -> str:
    return b.hex(" ")


def mask_serial(value: str) -> str:
    return value if len(value) <= 4 else "*" * (len(value) - 4) + value[-4:]


def is_candidate(device, adv) -> bool:
    name = adv.local_name or device.name or ""
    if NAME_RE.search(name):
        return True
    if XIAOMI_COMPANY_ID in adv.manufacturer_data:
        return True
    if any(u.lower() in KNOWN for u in adv.service_uuids):
        return True
    return any(u.lower() == u16("fe95") for u in adv.service_data)


def describe_adv(device, adv) -> dict:
    return {
        "address": device.address,
        "name": adv.local_name or device.name,
        "rssi": adv.rssi,
        "tx_power": adv.tx_power,
        "service_uuids": adv.service_uuids,
        "service_data": {k: hexs(v) for k, v in adv.service_data.items()},
        "manufacturer_data": {f"0x{k:04X}": hexs(v) for k, v in adv.manufacturer_data.items()},
    }


async def scan(timeout: float, show_all: bool):
    print(f"Scanning for {timeout:.0f}s ...")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    rows = [(d, a) for d, a in found.values() if show_all or is_candidate(d, a)]
    rows.sort(key=lambda r: r[1].rssi, reverse=True)
    if not rows:
        print("No matching devices. Is the band advertising? Try --all or a longer --timeout.")
    for device, adv in rows:
        info = describe_adv(device, adv)
        print(f"\n- {info['name']!r}  rssi={info['rssi']}  address={info['address']}")
        for key in ("service_uuids", "service_data", "manufacturer_data", "tx_power"):
            if info[key]:
                print(f"    {key}: {info[key]}")
        for u in adv.service_uuids:
            if u.lower() in KNOWN:
                print(f"    known: {u} = {KNOWN[u.lower()]}")
    return rows


def pick_band(rows, address: str | None):
    if address:
        for device, adv in rows:
            if device.address.lower() == address.lower():
                return device, adv
        return None
    for device, adv in rows:
        if re.search(r"Smart Band 10", adv.local_name or device.name or ""):
            return device, adv
    return None


async def survey(device, adv, connect_timeout: float = 20) -> dict:
    result = {"advertisement": describe_adv(device, adv), "services": [], "reads": {}}
    print(f"\nConnecting to {result['advertisement']['name']!r} ({device.address}) ...")
    async with BleakClient(device, timeout=connect_timeout) as client:
        print(f"Connected. MTU={client.mtu_size}")
        for service in client.services:
            srow = {"uuid": service.uuid, "handle": service.handle,
                    "description": service.description, "known": KNOWN.get(service.uuid.lower()),
                    "characteristics": []}
            print(f"\n[service] {service.uuid}  handle={service.handle}  {service.description}"
                  + (f"  <== {srow['known']}" if srow["known"] else ""))
            for char in service.characteristics:
                crow = {"uuid": char.uuid, "handle": char.handle, "properties": char.properties,
                        "description": char.description, "known": KNOWN.get(char.uuid.lower()),
                        "descriptors": [{"uuid": d.uuid, "handle": d.handle, "description": d.description}
                                        for d in char.descriptors]}
                srow["characteristics"].append(crow)
                print(f"  [char] {char.uuid}  handle={char.handle}  props={','.join(char.properties)}"
                      f"  {char.description}" + (f"  <== {crow['known']}" if crow["known"] else ""))
                for d in char.descriptors:
                    print(f"      [desc] {d.uuid}  handle={d.handle}  {d.description}")
            result["services"].append(srow)

        # Reads: standard Device Information and Battery Level only.
        for service in client.services:
            for char in service.characteristics:
                label = READ_ALLOWLIST.get(char.uuid.lower())
                if not label or "read" not in char.properties:
                    continue
                try:
                    raw = bytes(await client.read_gatt_char(char))
                except Exception as e:  # noqa: BLE001 - report and continue
                    result["reads"][label] = {"error": repr(e)}
                    print(f"read {label}: ERROR {e!r}")
                    continue
                if label == "Battery Level" and raw:
                    value = f"{raw[0]}%"
                else:
                    value = raw.decode("utf-8", "replace").rstrip("\x00")
                if label == "Serial Number":
                    value = mask_serial(value)
                result["reads"][label] = {"value": value,
                                          "hex": hexs(raw) if label != "Serial Number" else "(masked)"}
                print(f"read {label}: {value!r}")
    print("\nDisconnected.")
    return result


def compare(result: dict) -> None:
    seen = {s["uuid"].lower() for s in result["services"]}
    seen |= {c["uuid"].lower() for s in result["services"] for c in s["characteristics"]}
    print("\nGadgetbridge UUID comparison:")
    for uuid, label in KNOWN.items():
        print(f"  {'FOUND  ' if uuid in seen else 'missing'}  {uuid}  {label}")
    v2 = all(u16(x) in seen for x in ("fe95", "005e", "005f"))
    v1 = all(u16(x) in seen for x in ("fe95", "0051", "0052"))
    print(f"\nBLE V2 path (FE95 + 005E/005F): {'PRESENT' if v2 else 'absent'}")
    print(f"BLE V1 path (FE95 + 0051/0052): {'PRESENT' if v1 else 'absent'}")


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--all", action="store_true", help="print every advertising device")
    ap.add_argument("--connect", action="store_true", help="connect and enumerate GATT (read-only)")
    ap.add_argument("--address", help="CoreBluetooth UUID of the band (from a previous scan)")
    ap.add_argument("--connect-timeout", type=float, default=20.0)
    args = ap.parse_args()

    rows = await scan(args.timeout, args.all)
    if not args.connect:
        return 0

    picked = pick_band(rows, args.address)
    if not picked:
        print("\nNo 'Smart Band 10' found to connect to; pass --address from the scan output.")
        return 1

    result = await survey(*picked, args.connect_timeout)
    compare(result)

    out = Path(__file__).resolve().parent.parent / "out"
    out.mkdir(exist_ok=True)
    path = out / f"gatt-{datetime.now():%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(result, indent=2))
    print(f"\nSaved {path}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
