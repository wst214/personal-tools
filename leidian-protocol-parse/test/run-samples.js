import assert from "node:assert/strict";
import { parseProtocolText } from "../src/parser.js";

const samples = [
  {
    name: "01 atmosphere",
    hex: "5A4B140100010035000100050005001904A4061E00000411570D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "01");
      assert.equal(frame.parsed.instantValue, 5);
      assert.equal(frame.parsed.circuitNumber, "04");
    },
  },
  {
    name: "19 gps atmosphere",
    hex: "5A4B411900190004000100520050FFFF04B703960000000207EA0005000D000B001500340045CD6CD442004E39C51942383938363034343436313032353730353231383139AEFC0D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "19");
      assert.equal(frame.parsed.gpsTimeType, 2);
      assert.equal(frame.parsed.card, "89860444610257052181");
    },
  },
  {
    name: "03 grounding",
    hex: "5A4B11030001000100010010001A003C000703E836C90D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "03");
      assert.equal(frame.parsed.resistanceValue, 16);
      assert.equal(frame.parsed.temperature, 26);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "0F pdu",
    hex: "5A4B170F00040001000100000000081708C809C409501082011113D70D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "0F");
      assert.equal(frame.parsed.leakageCurrent, 422.6);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "05 surge current",
    hex: "5A4B1405000500010001200007E30912140000000117A388C00D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "05");
      assert.equal(frame.parsed.lightningStrikeCurrent, 81.92);
      assert.equal(frame.parsed.year, 2019);
    },
  },
  {
    name: "15 gps surge current",
    hex: "5A4B3D15800504560001F3DC07E80B0A082400000000001A6A07E80B0A08250F0000940F19424E0C42D44245383938363034463231303233373130343331303354750D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "15");
      assert.equal(frame.parsed.card, "898604F2102371043103");
      assert.equal(frame.parsed.latitudeDirection, "N");
    },
  },
  {
    name: "09 disconnect card",
    hex: "5A4B0A090009000100010102C6DE170D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "09");
      assert.equal(frame.parsed.disconnectStatus, 1);
      assert.equal(frame.parsed.batteryVoltage, 7.1);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "10 remote terminal",
    hex: "5A4B2C1000100001000101435C00003FC0000043A500003F73333342480000449A51EC00010101099804B1026C01F716FF0D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "10");
      assert.equal(frame.parsed.powerSupplyType, 1);
      assert.equal(frame.parsed.voltage, 220);
      assert.equal(frame.parsed.dcVoltage24v, 24.56);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "17 power board",
    hex: "5A4B22171700002800013AA95C432F9417BE02898604191524D015874700E9281E0100004129A10D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "17");
      assert.equal(frame.parsed.voltage15v, 15.017);
      assert.equal(frame.parsed.fanControlStatus, 1);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "14 surge monitor strike",
    hex: "5A4B141400140001000AFF4A07E70A1B101C070000003323860D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "14");
      assert.equal(frame.parsed.commandType, "000A");
      assert.equal(frame.parsed.strikeCount, 51);
      assert.equal(frame.crcValid, true);
    },
  },
  {
    name: "18 spd heartbeat",
    hex: "5A4B231800180001000138393836303742343033323544303031373039393C07E9061411122183510D0A",
    check: (frame) => {
      assert.equal(frame.parsed.deviceType, "18");
      assert.equal(frame.parsed.messageKind, "HEARTBEAT");
      assert.equal(frame.parsed.card, "898607B40325D0017099");
      assert.equal(frame.crcValid, true);
    },
  },
];

for (const sample of samples) {
  const result = parseProtocolText(sample.hex);
  assert.equal(result.frames.length, 1, sample.name);
  sample.check(result.frames[0]);
}

console.log(`sample tests passed: ${samples.length}`);
