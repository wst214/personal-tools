const PAYLOAD_START = 10;
const CRC_AND_TAIL_SIZE = 4;
const FRAME_LENGTH_BASE = 7;
const HEADER = [0x5a, 0x4b];
const TAIL = [0x0d, 0x0a];

const COMMAND_UPLOAD = "0001";
const COMMAND_SURGE_STRIKE = "000A";
const COMMAND_TIME_CALIBRATION = "0102";

const SPD = {
  DEVICE_TYPE: 0x18,
  WAVEFORM_MARKER: 0xaa,
  OFFSET_WAVEFORM_DATA_LENGTH: 10,
  OFFSET_RANGE_TYPE: 12,
  OFFSET_WAVEFORM_DATA: 13,
  WAVEFORM_DATA_BLOCK_SIZE: 2014,
  MIN_HEARTBEAT_FRAME_LENGTH: 42,
  MAX_HEARTBEAT_FRAME_LENGTH: 64,
  WAVEFORM_FIXED_HEADER_SIZE: 12,
  PEAK_DATA_BLOCK_SIZE: 14,
  STRIKE_TIME_SIZE: 7,
  RANGE_FACTOR_HIGH: 50,
  RANGE_FACTOR_LOW: 1,
  FROM_END_POSITIVE_PEAK: 24,
  FROM_END_NEGATIVE_PEAK: 22,
  FROM_END_POSITIVE_ACCUM: 20,
  FROM_END_NEGATIVE_ACCUM: 16,
  FROM_END_YEAR: 11,
  FROM_END_MONTH: 9,
  FROM_END_DAY: 8,
  FROM_END_HOUR: 7,
  FROM_END_MINUTE: 6,
  FROM_END_SECOND: 5,
};

export function parseProtocolText(input) {
  const normalized = normalizeHexInput(input);
  if (!normalized) {
    return {
      ok: false,
      inputHex: "",
      frames: [],
      errors: ["没有识别到十六进制协议内容"],
    };
  }
  if (normalized.length % 2 !== 0) {
    return {
      ok: false,
      inputHex: normalized,
      frames: [],
      errors: ["十六进制字符数量不是偶数，请检查是否漏了半个字节"],
    };
  }

  const bytes = hexToBytes(normalized);
  const { frames, warnings } = splitFrames(bytes);
  const parsedFrames = frames.map((frame, index) => parseFrame(frame, index));
  return {
    ok: parsedFrames.length > 0 && parsedFrames.every((frame) => frame.status === "PARSED"),
    inputHex: normalized,
    frameCount: parsedFrames.length,
    frames: parsedFrames,
    errors: parsedFrames.filter((frame) => frame.error).map((frame) => `frame[${frame.index}]: ${frame.error}`),
    warnings,
  };
}

export function normalizeHexInput(input) {
  if (!input) {
    return "";
  }
  return String(input)
    .replace(/0x/gi, "")
    .match(/[0-9a-fA-F]/g)
    ?.join("")
    .toUpperCase() ?? "";
}

function splitFrames(bytes) {
  const frames = [];
  const warnings = [];
  let cursor = 0;

  while (cursor < bytes.length) {
    const headerIndex = findHeader(bytes, cursor);
    if (headerIndex < 0) {
      if (cursor < bytes.length) {
        warnings.push(`末尾有 ${bytes.length - cursor} 字节未形成协议帧`);
      }
      break;
    }
    if (headerIndex > cursor) {
      warnings.push(`跳过帧头前噪声 ${headerIndex - cursor} 字节`);
    }
    if (headerIndex + 3 > bytes.length) {
      warnings.push("发现帧头，但长度字节不完整");
      break;
    }

    const frameLength = resolveFrameLength(bytes, headerIndex);
    if (frameLength < 0) {
      warnings.push("发现疑似半包，当前输入不足以切出完整帧");
      break;
    }
    if (headerIndex + frameLength > bytes.length) {
      warnings.push(`帧长度需要 ${frameLength} 字节，但剩余 ${bytes.length - headerIndex} 字节`);
      break;
    }
    frames.push(bytes.slice(headerIndex, headerIndex + frameLength));
    cursor = headerIndex + frameLength;
  }

  if (frames.length === 0 && bytes.length > 0) {
    warnings.push("没有找到帧头 5A4B");
  }
  return { frames, warnings };
}

function resolveFrameLength(bytes, offset) {
  if (bytes[offset + 3] === SPD.DEVICE_TYPE) {
    const spdLength = resolveSpdFrameLength(bytes, offset);
    if (spdLength !== null) {
      return spdLength;
    }
  }
  const declaredLength = bytes[offset + 2] + FRAME_LENGTH_BASE;
  if (offset + declaredLength < bytes.length
      && bytes[offset + declaredLength - 1] === TAIL[0]
      && bytes[offset + declaredLength] === TAIL[1]) {
    return declaredLength + 1;
  }
  const earlyTailLength = findEarlyTailLength(bytes, offset, declaredLength);
  return earlyTailLength ?? declaredLength;
}

function resolveSpdFrameLength(bytes, offset) {
  if (bytes[offset + 2] === SPD.WAVEFORM_MARKER) {
    if (offset + SPD.OFFSET_WAVEFORM_DATA_LENGTH + 1 >= bytes.length) {
      return -1;
    }
    const dataLength = uint16(bytes, offset + SPD.OFFSET_WAVEFORM_DATA_LENGTH);
    const frameLength = SPD.WAVEFORM_FIXED_HEADER_SIZE + dataLength + CRC_AND_TAIL_SIZE;
    const min = SPD.WAVEFORM_FIXED_HEADER_SIZE
      + SPD.WAVEFORM_DATA_BLOCK_SIZE
      + SPD.PEAK_DATA_BLOCK_SIZE
      + SPD.STRIKE_TIME_SIZE
      + CRC_AND_TAIL_SIZE;
    return frameLength >= min ? frameLength : null;
  }

  const heartbeatLength = bytes[offset + 2] + FRAME_LENGTH_BASE;
  if (heartbeatLength > SPD.MAX_HEARTBEAT_FRAME_LENGTH) {
    return -1;
  }
  if (heartbeatLength < SPD.MIN_HEARTBEAT_FRAME_LENGTH
      && offset + SPD.MIN_HEARTBEAT_FRAME_LENGTH <= bytes.length
      && hasTail(bytes.slice(offset, offset + SPD.MIN_HEARTBEAT_FRAME_LENGTH))) {
    return SPD.MIN_HEARTBEAT_FRAME_LENGTH;
  }
  return heartbeatLength;
}

function parseFrame(bytes, index) {
  const base = buildBaseFrame(bytes, index);
  if (!hasTail(bytes)) {
    return { ...base, status: "INVALID_FRAME", crcValid: false, error: "帧尾不是 0D0A" };
  }

  const crcValid = validateCrc(bytes);
  const parsed = dispatchByDevice(bytes, base);
  return {
    ...base,
    status: parsed.error ? "UNSUPPORTED" : "PARSED",
    crcValid,
    crcNote: crcValid ? "CRC16 Modbus 校验通过" : "CRC16 Modbus 校验失败，字段仍按帧内容尝试解析",
    parsed: parsed.data,
    error: parsed.error,
  };
}

function buildBaseFrame(bytes, index) {
  const deviceType = hex(bytes.slice(3, 4));
  const deviceAddress = hex(bytes.slice(4, 8));
  const commandType = hex(bytes.slice(8, 10));
  return {
    index,
    frameHex: hex(bytes),
    lengthByte: bytes[2],
    frameLength: bytes.length,
    deviceType,
    deviceName: deviceName(deviceType),
    deviceAddress,
    commandType,
    payloadHex: hex(bytes.slice(PAYLOAD_START, Math.max(PAYLOAD_START, bytes.length - CRC_AND_TAIL_SIZE))),
    crcHex: hex(bytes.slice(Math.max(0, bytes.length - CRC_AND_TAIL_SIZE), Math.max(0, bytes.length - 2))),
  };
}

function dispatchByDevice(bytes, base) {
  const type = base.deviceType;
  const command = base.commandType;
  try {
    if ((type === "01" || type === "19") && command === COMMAND_UPLOAD) return ok(parseAtmosphere(bytes, base));
    if (type === "03" && command === COMMAND_UPLOAD) return ok(parseGrounding(bytes, base));
    if (type === "0F" && command === COMMAND_UPLOAD) return ok(parsePdu(bytes, base));
    if ((type === "05" || type === "15") && command === COMMAND_UPLOAD) return ok(parseSurgeCurrent(bytes, base));
    if (type === "09" && command === COMMAND_UPLOAD) return ok(parseDisconnectCard(bytes, base));
    if (type === "10" && command === COMMAND_UPLOAD) return ok(parseRemoteTerminal(bytes, base));
    if (type === "17" && command === COMMAND_UPLOAD) return ok(parsePowerBoard(bytes, base));
    if (type === "14" && [COMMAND_UPLOAD, COMMAND_SURGE_STRIKE, COMMAND_TIME_CALIBRATION].includes(command)) {
      return ok(parseSurgeMonitor(bytes, base));
    }
    if (type === "18" && command === COMMAND_UPLOAD) return ok(parseSpdWaveform(bytes, base));
    return { data: baseFields(base), error: `暂不支持 deviceType=${type}, commandType=${command}` };
  } catch (error) {
    return { data: baseFields(base), error: error.message };
  }
}

function parseAtmosphere(bytes, base) {
  requireLength(bytes, PAYLOAD_START + 12 + 2, "大气电场帧长度不足");
  const data = baseFields(base);
  data.instantValue = int16(bytes, 10);
  data.averageValue = int16(bytes, 12);
  data.changeRate = int16(bytes, 14);
  data.deviceVoltage = scale(uint16(bytes, 16), 2);
  data.motorSpeed = uint16(bytes, 18);
  data.warningLevel = uint16(bytes, 20);

  if (base.deviceType === "01" && bytes.length >= 23) {
    data.circuitNumber = byteHex(bytes[22]);
  }
  if (base.deviceType === "19" && bytes.length >= 68) {
    const timeType = uint16(bytes, 22);
    if (timeType === 1 || timeType === 2) {
      data.gpsTimeType = timeType;
      data.year = uint16(bytes, 24);
      data.month = uint16(bytes, 26);
      data.day = uint16(bytes, 28);
      data.hour = uint16(bytes, 30);
      data.minute = uint16(bytes, 32);
      data.second = uint16(bytes, 34);
      data.longitudeDirection = direction(bytes, 36);
      data.longitude = coordinate(timeType === 1 ? float32(bytes, 38) : float32Le(bytes, 38));
      data.latitudeDirection = direction(bytes, 42);
      data.latitude = coordinate(timeType === 1 ? float32(bytes, 44) : float32Le(bytes, 44));
      data.card = ascii(bytes, 48, 20);
    }
  }
  return data;
}

function parseGrounding(bytes, base) {
  requireLength(bytes, PAYLOAD_START + 10 + CRC_AND_TAIL_SIZE, "接地电阻帧长度不足");
  return {
    ...baseFields(base),
    resistanceValue: uint16(bytes, 10),
    temperature: uint16(bytes, 12),
    humidity: uint16(bytes, 14),
    phValue: uint16(bytes, 16),
    soilResistivity: uint16(bytes, 18),
  };
}

function parsePdu(bytes, base) {
  requireLength(bytes, PAYLOAD_START + 16 + CRC_AND_TAIL_SIZE, "iSPD/PDU 帧长度不足");
  return {
    ...baseFields(base),
    strikeCount: uint16(bytes, 10),
    strikeCurrent: uint16(bytes, 12),
    humidity: scale(uint16(bytes, 14), 2),
    ambientTemperature: scale(uint16(bytes, 16), 2),
    targetTemperature: scale(uint16(bytes, 18), 2),
    workingVoltage: scale(uint16(bytes, 20), 1),
    leakageCurrent: scale(uint16(bytes, 22), 1),
    switchStatus: uint16(bytes, 24),
  };
}

function parseSurgeCurrent(bytes, base) {
  const data = baseFields(base);
  data.lightningStrikeCurrent = scale(uint16(bytes, 10), 2);
  data.year = uint16(bytes, 12);
  data.month = bytes[14];
  data.day = bytes[15];
  data.hour = bytes[16];
  data.minute = bytes[17];
  data.second = bytes[18];

  if (base.deviceType === "05") {
    requireLength(bytes, PAYLOAD_START + 13 + CRC_AND_TAIL_SIZE, "05 雷电流帧长度不足");
    data.lightningStrikeNum = uint16(bytes, 19);
    data.batteryVoltage = scale(uint16(bytes, 21), 3);
    return data;
  }

  requireLength(bytes, 68, "15 GPS 雷电流帧长度不足");
  data.millisecond = uint16(bytes, 19);
  data.lightningStrikeNum = uint16(bytes, 21);
  data.batteryVoltage = scale(uint16(bytes, 23), 3);
  data.realYear = uint16(bytes, 25);
  data.realMonth = bytes[27];
  data.realDay = bytes[28];
  data.realHour = bytes[29];
  data.realMinute = bytes[30];
  data.realSecond = bytes[31];
  data.realMillisecond = uint16(bytes, 32);
  data.latitude = coordinate(float32Le(bytes, 34));
  data.latitudeDirection = ascii(bytes, 38, 1);
  data.longitude = coordinate(float32Le(bytes, 39));
  data.longitudeDirection = ascii(bytes, 43, 1);
  data.card = ascii(bytes, 44, 20);
  return data;
}

function parseDisconnectCard(bytes, base) {
  requireLength(bytes, 17, "智能断接卡帧长度不足");
  return {
    ...baseFields(base),
    disconnectStatus: bytes[10],
    batteryVoltage: scale(uint16(bytes, 11), 2),
  };
}

function parseRemoteTerminal(bytes, base) {
  requireLength(bytes, 47, "远程监测控制终端帧长度不足");
  return {
    ...baseFields(base),
    powerSupplyType: bytes[10],
    voltage: float32(bytes, 11),
    current: float32(bytes, 15),
    activePower: float32(bytes, 19),
    powerFactor: float32(bytes, 23),
    frequency: float32(bytes, 27),
    totalActiveEnergy: float32(bytes, 31),
    relayNc: String(bytes[35]),
    relay24v: String(bytes[36]),
    relay12v: String(bytes[37]),
    relay6v: String(bytes[38]),
    dcVoltage24v: scale(uint16(bytes, 39), 2),
    dcVoltage12v: scale(uint16(bytes, 41), 2),
    dcVoltage6v: scale(uint16(bytes, 43), 2),
    dcVoltage5v: scale(uint16(bytes, 45), 2),
  };
}

function parsePowerBoard(bytes, base) {
  requireLength(bytes, 41, "电源控制板帧长度不足");
  return {
    ...baseFields(base),
    voltage15v: scale(uint16(bytes, 10), 3),
    voltage24v: scale(uint16(bytes, 12), 3),
    voltage12v: scale(uint16(bytes, 14), 3),
    voltage6v: scale(uint16(bytes, 16), 3),
    uploadFrequency: bytes[18],
    iccidHex: base.payloadHex.length >= 38 ? base.payloadHex.slice(18, 38) : null,
    deviceTemperature: scale(int16(bytes, 29), 1),
    fanStartTemperature: bytes[31],
    fanStopTemperature: bytes[32],
    fanControlStatus: bytes[33],
    version: bytes[36],
  };
}

function parseSurgeMonitor(bytes, base) {
  const data = baseFields(base);
  if (base.commandType === COMMAND_UPLOAD) {
    requireLength(bytes, 17, "避雷器 0001 实时帧长度不足");
    data.leakageCurrent = scale(uint16(bytes, 10), 1);
    data.batteryVoltage = scale(uint16(bytes, 12), 3);
    return data;
  }
  if (base.commandType === COMMAND_SURGE_STRIKE) {
    requireLength(bytes, 27, "避雷器 000A 雷击帧长度不足");
    data.strikeCurrent = scale(int16(bytes, 10), 2);
    data.year = uint16(bytes, 12);
    data.month = bytes[14];
    data.day = bytes[15];
    data.hour = bytes[16];
    data.minute = bytes[17];
    data.second = bytes[18];
    data.millisecond = uint16(bytes, 19);
    data.strikeCount = uint16(bytes, 21);
    return data;
  }
  requireLength(bytes, 20, "避雷器 0102 时间校准帧长度不足");
  data.year = uint16(bytes, 10);
  data.month = bytes[12];
  data.day = bytes[13];
  data.hour = bytes[14];
  data.minute = bytes[15];
  data.second = bytes[16];
  data.messageKind = "TIME_CALIBRATION";
  return data;
}

function parseSpdWaveform(bytes, base) {
  if (isSpdWaveformFrame(bytes)) {
    const len = bytes.length;
    const rangeType = bytes[SPD.OFFSET_RANGE_TYPE];
    const factor = rangeType === 0x02 ? SPD.RANGE_FACTOR_HIGH : SPD.RANGE_FACTOR_LOW;
    return {
      ...baseFields(base),
      messageKind: "WAVEFORM",
      rangeType: byteHex(rangeType),
      positivePeakCurrent: uint16(bytes, len - SPD.FROM_END_POSITIVE_PEAK) * factor,
      negativePeakCurrent: uint16(bytes, len - SPD.FROM_END_NEGATIVE_PEAK) * factor,
      positiveAccumulatedValue: uint32(bytes, len - SPD.FROM_END_POSITIVE_ACCUM),
      negativeAccumulatedValue: uint32(bytes, len - SPD.FROM_END_NEGATIVE_ACCUM),
      year: uint16(bytes, len - SPD.FROM_END_YEAR),
      month: bytes[len - SPD.FROM_END_MONTH],
      day: bytes[len - SPD.FROM_END_DAY],
      hour: bytes[len - SPD.FROM_END_HOUR],
      minute: bytes[len - SPD.FROM_END_MINUTE],
      second: bytes[len - SPD.FROM_END_SECOND],
      waveformHex: hex(bytes.slice(SPD.OFFSET_WAVEFORM_DATA, SPD.OFFSET_WAVEFORM_DATA + SPD.WAVEFORM_DATA_BLOCK_SIZE)),
    };
  }
  if (isSpdHeartbeatFrame(bytes)) {
    return {
      ...baseFields(base),
      messageKind: "HEARTBEAT",
      card: ascii(bytes, 10, 20),
      heartbeatFrequencyMinutes: bytes[30],
      year: uint16(bytes, 31),
      month: bytes[33],
      day: bytes[34],
      hour: bytes[35],
      minute: bytes[36],
      second: bytes[37],
    };
  }
  throw new Error("SPD 波形帧布局无法识别");
}

function isSpdWaveformFrame(bytes) {
  if (bytes[2] !== SPD.WAVEFORM_MARKER || bytes[3] !== SPD.DEVICE_TYPE) return false;
  const dataLength = uint16(bytes, SPD.OFFSET_WAVEFORM_DATA_LENGTH);
  return bytes.length === SPD.WAVEFORM_FIXED_HEADER_SIZE + dataLength + CRC_AND_TAIL_SIZE;
}

function isSpdHeartbeatFrame(bytes) {
  return bytes[3] === SPD.DEVICE_TYPE && bytes.length >= SPD.MIN_HEARTBEAT_FRAME_LENGTH && !isSpdWaveformFrame(bytes);
}

function baseFields(base) {
  return {
    deviceType: base.deviceType,
    deviceName: base.deviceName,
    deviceAddress: base.deviceAddress,
    commandType: base.commandType,
  };
}

function deviceName(type) {
  return {
    "01": "低误报雷暴预警仪",
    "19": "GPS版低误报雷暴预警仪",
    "03": "接地电阻监测仪",
    "0F": "智能监测型iSPD/智能防雷PDU",
    "05": "雷电流峰值监测仪",
    "15": "GPS版本雷电流智能监测仪",
    "09": "智能断接卡",
    "10": "定位仪远程监测控制终端",
    "17": "电源控制板",
    "14": "避雷器在线监测仪",
    "18": "SPD多重雷击波形监测",
  }[type] ?? "未知设备";
}

function requireLength(bytes, min, message) {
  if (bytes.length < min) {
    throw new Error(`${message}: 当前 ${bytes.length} 字节，需要至少 ${min} 字节`);
  }
}

function ok(data) {
  return { data };
}

function findHeader(bytes, from) {
  for (let i = from; i < bytes.length - 1; i += 1) {
    if (bytes[i] === HEADER[0] && bytes[i + 1] === HEADER[1]) return i;
  }
  return -1;
}

function findEarlyTailLength(bytes, offset, declaredLength) {
  const maxEnd = Math.min(bytes.length, offset + declaredLength);
  for (let end = offset + 9; end <= maxEnd; end += 1) {
    if (bytes[end - 2] === TAIL[0] && bytes[end - 1] === TAIL[1]) {
      return end - offset;
    }
  }
  return null;
}

function hasTail(bytes) {
  return bytes.length >= 2 && bytes[bytes.length - 2] === TAIL[0] && bytes[bytes.length - 1] === TAIL[1];
}

function validateCrc(bytes) {
  if (bytes.length < 6) return false;
  const expectedLo = bytes[bytes.length - 4];
  const expectedHi = bytes[bytes.length - 3];
  const actual = crc16Modbus(bytes.slice(0, bytes.length - 4));
  return expectedLo === (actual & 0xff) && expectedHi === ((actual >> 8) & 0xff);
}

function crc16Modbus(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 1) ? ((crc >> 1) ^ 0xa001) : (crc >> 1);
    }
  }
  return crc & 0xffff;
}

function hexToBytes(value) {
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < value.length; i += 2) {
    bytes[i / 2] = Number.parseInt(value.slice(i, i + 2), 16);
  }
  return Array.from(bytes);
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byteHex(byte)).join("");
}

function byteHex(byte) {
  return (byte & 0xff).toString(16).toUpperCase().padStart(2, "0");
}

function uint16(bytes, offset) {
  return ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff);
}

function int16(bytes, offset) {
  const value = uint16(bytes, offset);
  return value > 0x7fff ? value - 0x10000 : value;
}

function uint32(bytes, offset) {
  return ((bytes[offset] & 0xff) * 0x1000000)
    + ((bytes[offset + 1] & 0xff) << 16)
    + ((bytes[offset + 2] & 0xff) << 8)
    + (bytes[offset + 3] & 0xff);
}

function float32(bytes, offset) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint8(0, bytes[offset]);
  view.setUint8(1, bytes[offset + 1]);
  view.setUint8(2, bytes[offset + 2]);
  view.setUint8(3, bytes[offset + 3]);
  return round(view.getFloat32(0, false), 6);
}

function float32Le(bytes, offset) {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint8(0, bytes[offset]);
  view.setUint8(1, bytes[offset + 1]);
  view.setUint8(2, bytes[offset + 2]);
  view.setUint8(3, bytes[offset + 3]);
  return round(view.getFloat32(0, true), 6);
}

function ascii(bytes, offset, length) {
  return String.fromCharCode(...bytes.slice(offset, offset + length)).replace(/\0/g, "").trim();
}

function direction(bytes, offset) {
  const first = bytes[offset];
  const second = bytes[offset + 1];
  if (second >= 65 && second <= 90) return String.fromCharCode(second);
  if (first >= 65 && first <= 90) return String.fromCharCode(first);
  return ascii(bytes, offset, 2);
}

function scale(raw, places) {
  return Number((raw / (10 ** places)).toFixed(places));
}

function coordinate(value) {
  return round(value, 6);
}

function round(value, digits) {
  return Number(Number(value).toFixed(digits));
}
