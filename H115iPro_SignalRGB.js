
/*
 * Corsair Hydro H115i Pro RGB
 * SignalRGB plugin v20
 *
 * Hardware:
 *   VID: 0x1B1C
 *   PID: 0x0C13
 *   USB interface: 0
 *
 * Features:
 *   - SignalRGB canvas-synchronised logo
 *   - Coolant temperature monitoring
 *   - Radiator fan RPM monitoring (x2)
 *   - Pump RPM monitoring
 *   - Quiet / Balanced / Performance pump modes
 *
 * Protocol based on the Asetek Pro implementation
 * used by liquidctl.
 */

// --------------------------------------------------
// Device information
// --------------------------------------------------

export function Name() {
    return "Corsair Hydro H115i Pro RGB";
}

export function Publisher() {
    return "Community";
}

export function VendorId() {
    return 0x1B1C;
}

export function ProductId() {
    return 0x0C13;
}

export function Type() {
    return "rawusb";
}

export function Size() {
    return [1, 1];
}

export function LedNames() {
    return ["Logo"];
}

export function LedPositions() {
    return [[0, 0]];
}

export function ImageUrl() {
    return "https://www.allround-pc.com/wp-content/uploads/2018/01/Corsair-H115i-Pro-Beleuchtung-1280x740.jpg";
}

export function Validate(endpoint) {
    return endpoint.interface === 0;
}

// --------------------------------------------------
// User controls
// --------------------------------------------------

export function ControllableParameters() {
    return [
        {
            property: "PumpMode",
            label: "Pump Mode",
            type: "combobox",
            values: [
                "Quiet",
                "Balanced",
                "Performance"
            ],
            default: "Performance"
        }
    ];
}

// --------------------------------------------------
// USB constants
// --------------------------------------------------

const USB_OUT = 0x01;
const USB_IN = 0x81;
const USB_TIMEOUT = 1000;

const CMD_COOLANT = 0xA9;
const CMD_FAN = 0x41;
const CMD_PUMP_MODE = 0x33;
const CMD_PUMP_SPEED = 0x31;
const CMD_SET_PUMP_MODE = 0x32;

const CMD_WRITE_COLOR_LIST = 0x56;
const CMD_SET_FIXED_LIGHTING = 0x55;

// --------------------------------------------------
// Runtime state
// --------------------------------------------------

let initialized = false;

let frameCounter = 0;
let successfulPolls = 0;

let coolantTemperature = 0;
let fan1RPM = 0;
let fan2RPM = 0;
let pumpRPM = 0;

let currentPumpMode = "Unknown";

let lastSentColor = null;

// --------------------------------------------------
// Logging
// --------------------------------------------------

function Log(message) {
    device.log("[H115i v20] " + message);
}

// --------------------------------------------------
// USB communication
// --------------------------------------------------

function GetData(result) {
    if (!result || !result.data) {
        return [];
    }

    return result.data;
}

function WriteTransaction(command) {
    return device.bulk_transfer(
        USB_OUT,
        command,
        command.length,
        USB_TIMEOUT
    );
}

function ReadTransaction(command, responseLength) {
    const writeResult = WriteTransaction(command);

    if (!writeResult ||
        writeResult.length !== command.length) {
        return null;
    }

    const receiveBuffer =
        new Array(responseLength).fill(0);

    const readResult = device.bulk_transfer(
        USB_IN,
        receiveBuffer,
        responseLength,
        USB_TIMEOUT
    );

    if (!readResult || readResult.length < 0) {
        return null;
    }

    return GetData(readResult);
}

function SendDeviceCommand(command, responseLength) {
    const writeResult = WriteTransaction(command);

    if (!writeResult ||
        writeResult.length !== command.length) {
        Log(
            "Write failed: 0x" +
            command[0].toString(16)
        );

        return false;
    }

    const receiveBuffer =
        new Array(responseLength).fill(0);

    const readResult = device.bulk_transfer(
        USB_IN,
        receiveBuffer,
        responseLength,
        USB_TIMEOUT
    );

    if (readResult && readResult.length >= 0) {
        return true;
    }

    Log(
        "No acknowledgement for command 0x" +
        command[0].toString(16)
    );

    // The command was written successfully.
    return true;
}

// --------------------------------------------------
// Pump control
// --------------------------------------------------

function ModeToIndex(mode) {
    switch (mode) {
        case "Quiet":
            return 0;

        case "Balanced":
            return 1;

        case "Performance":
            return 2;

        default:
            return 2;
    }
}

function IndexToMode(index) {
    switch (index) {
        case 0:
            return "Quiet";

        case 1:
            return "Balanced";

        case 2:
            return "Performance";

        default:
            return "Unknown";
    }
}

function SetPumpMode(mode) {
    const requestedMode = ModeToIndex(mode);

    Log("Requesting pump mode: " + mode);

    try {
        const response = ReadTransaction(
            [CMD_SET_PUMP_MODE, requestedMode],
            5
        );

        if (response && response.length >= 5) {
            Log("Pump mode command acknowledged");
        } else {
            Log(
                "No command acknowledgement; " +
                "checking via telemetry"
            );
        }
    } catch (error) {
        Log("Pump mode error: " + error);
    }
}

export function onPumpModeChanged() {
    if (!initialized) {
        return;
    }

    SetPumpMode(PumpMode);
}

// --------------------------------------------------
// Canvas RGB synchronisation
// --------------------------------------------------

function NormalizeColor(color) {
    if (!color || color.length < 3) {
        return null;
    }

    const red = Math.max(
        0,
        Math.min(255, Math.round(color[0]))
    );

    const green = Math.max(
        0,
        Math.min(255, Math.round(color[1]))
    );

    const blue = Math.max(
        0,
        Math.min(255, Math.round(color[2]))
    );

    return [red, green, blue];
}

function ColorsEqual(a, b) {
    return a &&
        b &&
        a[0] === b[0] &&
        a[1] === b[1] &&
        a[2] === b[2];
}

function ApplyCanvasColor() {
    if (!initialized) {
        return;
    }

    try {
        // The H115i Pro has one RGB lighting zone:
        // the pump-head logo.
        const canvasColor = device.color(0, 0);
        const color = NormalizeColor(canvasColor);

        if (!color) {
            return;
        }

        // Avoid unnecessary USB traffic when the
        // SignalRGB canvas colour has not changed.
        if (ColorsEqual(color, lastSentColor)) {
            return;
        }

        const red = color[0];
        const green = color[1];
        const blue = color[2];

        // The Asetek Pro fixed-lighting protocol
        // expects two identical RGB triplets.
        const colorCommand = [
            CMD_WRITE_COLOR_LIST,
            0x02,
            red,
            green,
            blue,
            red,
            green,
            blue
        ];

        if (!SendDeviceCommand(colorCommand, 3)) {
            return;
        }

        if (!SendDeviceCommand(
            [CMD_SET_FIXED_LIGHTING, 0x01],
            3
        )) {
            return;
        }

        lastSentColor = [
            red,
            green,
            blue
        ];

    } catch (error) {
        Log("Canvas RGB error: " + error);
    }
}

// --------------------------------------------------
// USBXpress initialization
// --------------------------------------------------

function ConfigureUSBXpress() {
    try {
        device.control_transfer(
            0x40,
            0x02,
            0x02,
            0x00,
            [],
            0,
            USB_TIMEOUT
        );

        Log("USBXpress CTS configured");

        return true;

    } catch (error) {
        Log("USBXpress initialization failed: " + error);

        return false;
    }
}

// --------------------------------------------------
// Telemetry
// --------------------------------------------------

function ReadCoolantTemperature() {
    const data = ReadTransaction(
        [CMD_COOLANT],
        6
    );

    if (!data || data.length < 5) {
        return false;
    }

    coolantTemperature =
        data[3] + (data[4] / 10);

    return true;
}

function ReadFanSpeed(fanIndex) {
    const data = ReadTransaction(
        [CMD_FAN, fanIndex],
        6
    );

    if (!data || data.length < 6) {
        return null;
    }

    return (data[4] << 8) | data[5];
}

function ReadPumpMode() {
    const data = ReadTransaction(
        [CMD_PUMP_MODE],
        4
    );

    if (!data || data.length < 4) {
        return false;
    }

    currentPumpMode = IndexToMode(data[3]);

    return true;
}

function ReadPumpSpeed() {
    const data = ReadTransaction(
        [CMD_PUMP_SPEED],
        5
    );

    if (!data || data.length < 5) {
        return false;
    }

    pumpRPM = (data[3] << 8) | data[4];

    return true;
}

function PollTelemetry() {
    try {
        const coolantOK = ReadCoolantTemperature();

        const fan1 = ReadFanSpeed(0);
        const fan2 = ReadFanSpeed(1);

        const modeOK = ReadPumpMode();
        const pumpOK = ReadPumpSpeed();

        if (
            coolantOK &&
            fan1 !== null &&
            fan2 !== null &&
            modeOK &&
            pumpOK
        ) {
            fan1RPM = fan1;
            fan2RPM = fan2;

            device.SetTemperature(
                "Coolant Temperature",
                coolantTemperature
            );

            device.setRPM(
                "Radiator Fan 1",
                fan1RPM
            );

            device.setRPM(
                "Radiator Fan 2",
                fan2RPM
            );

            device.setRPM(
                "Pump",
                pumpRPM
            );

            successfulPolls++;

            if (successfulPolls % 10 === 0) {
                Log(
                    "Coolant: " +
                    coolantTemperature.toFixed(1) +
                    " C | Fan 1: " +
                    fan1RPM +
                    " RPM | Fan 2: " +
                    fan2RPM +
                    " RPM | Pump: " +
                    pumpRPM +
                    " RPM | Mode: " +
                    currentPumpMode
                );
            }
        }

    } catch (error) {
        Log("Telemetry error: " + error);
    }
}

// --------------------------------------------------
// Lifecycle
// --------------------------------------------------

export function Initialize() {
    Log("Initializing Corsair Hydro H115i Pro");

    initialized = false;

    frameCounter = 0;
    successfulPolls = 0;

    lastSentColor = null;

    device.createTemperatureSensor(
        "Coolant Temperature"
    );

    device.createFanControl(
        "Radiator Fan 1"
    );

    device.createFanControl(
        "Radiator Fan 2"
    );

    device.createFanControl(
        "Pump"
    );

    if (!ConfigureUSBXpress()) {
        Log("Initialization stopped");
        return;
    }

    initialized = true;

    Log("Initialization completed");
    Log("Canvas synchronisation enabled");
}

export function Render() {
    if (!initialized) {
        return;
    }

    // Keep lighting responsive to SignalRGB effects.
    ApplyCanvasColor();

    // Telemetry polling at approximately one-second
    // intervals, independent of the lighting updates.
    frameCounter++;

    if (frameCounter >= 30) {
        frameCounter = 0;
        PollTelemetry();
    }
}

export function Shutdown() {
    initialized = false;

    lastSentColor = null;

    Log("Plugin shutdown");
}
