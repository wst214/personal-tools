const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const baseUrl = process.env.TUNNEL_PANEL_URL || "http://127.0.0.1:5760";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    assert.equal(await page.title(), "内网穿透面板 · WST Lab");
    assert.equal(await page.locator('input[name="provider"]').count(), 2);
    assert.equal(await page.locator("#targetInput").count(), 1);
    assert.equal(await page.locator("#startBtn").count(), 1);
    assert.equal(await page.locator("#stopBtn").count(), 1);
    assert.equal(await page.locator("#logBox").count(), 1);

    await page.locator("#startBtn").click();
    await page.locator("#errorCard:not(.hidden)").waitFor();
    assert.match(await page.locator("#errorText").innerText(), /请输入本地地址/);

    await page.setViewportSize({ width: 375, height: 812 });
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      inputHeight: document.querySelector("#targetInput").getBoundingClientRect().height,
    }));
    assert.ok(layout.scrollWidth <= layout.viewport, "页面不应横向溢出");
    assert.ok(layout.inputHeight < 80, "移动端输入框高度应小于 80px");

    console.log("Tunnel panel UI checks passed.");
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
