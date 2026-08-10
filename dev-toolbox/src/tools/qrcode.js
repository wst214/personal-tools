import QRCode from 'qrcode/lib/browser';
import jsQR from 'jsqr';
import { el, btn, toast, download, copyBtn, debounce } from '../ui/helpers.js';

export const qrcodeTool = {
  id: 'qrcode',
  name: '二维码',
  category: '其它',
  icon: '▦',
  keywords: 'qrcode qr',
  desc: '生成与解析二维码',
  render(container) {
    const text = el('textarea', { class: 'tx', placeholder: '输入要生成二维码的文本或链接…', text: 'https://github.com/rememberber/MooTool' });
    const size = el('select', { class: 'select' }, ['128', '192', '256', '384', '512'].map((s) => el('option', { value: s, text: s })));
    size.value = '256';
    const ecl = el('select', { class: 'select' }, ['L', 'M', 'Q', 'H'].map((s) => el('option', { value: s, text: s })));
    const margin = el('input', { class: 'input', type: 'number', value: '2', min: '0', max: '10' });
    const dark = el('input', { type: 'color', value: '#000000' });
    const light = el('input', { type: 'color', value: '#ffffff' });
    const img = el('img', { class: 'qr-img', alt: '二维码预览' });
    let dataUrl = '';

    const gen = async () => {
      const t = text.value.trim();
      if (!t) { toast('请输入文本', 'warn'); return; }
      try {
        dataUrl = await QRCode.toDataURL(t, {
          width: +size.value,
          margin: +margin.value || 1,
          errorCorrectionLevel: ecl.value,
          color: { dark: dark.value, light: light.value },
        });
        img.src = dataUrl;
      } catch (e) { toast(e.message, 'error'); }
    };
    [text, size, ecl, margin, dark, light].forEach((c) => c.addEventListener('input', debounce(gen, 150)));

    const fileInput = el('input', { type: 'file', accept: 'image/*' });
    const decResult = el('textarea', { class: 'tx', placeholder: '解析结果…' });
    decResult.readOnly = true;
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      try {
        const bmp = await createImageBitmap(f);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bmp, 0, 0);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const res = jsQR(data.data, canvas.width, canvas.height);
        if (res) { decResult.value = res.data; toast('解析成功', 'success'); }
        else { decResult.value = ''; toast('未识别到二维码', 'warn'); }
      } catch (e) { toast(e.message, 'error'); }
    });

    container.append(
      el('div', { class: 'grid-2' }, [
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: '生成二维码' }),
          text,
          el('div', { class: 'form-row' }, [
            el('div', { class: 'field' }, [el('label', { text: '尺寸' }), size]),
            el('div', { class: 'field' }, [el('label', { text: '容错' }), ecl]),
            el('div', { class: 'field' }, [el('label', { text: '边距' }), margin]),
          ]),
          el('div', { class: 'form-row' }, [
            el('div', { class: 'field' }, [el('label', { text: '前景' }), dark]),
            el('div', { class: 'field' }, [el('label', { text: '背景' }), light]),
          ]),
          el('div', { class: 'form-row' }, [btn('生成', gen, { variant: 'primary' }), btn('下载 PNG', () => dataUrl && download('qrcode.png', dataUrl)), copyBtn(() => text.value)]),
          el('div', { class: 'qr-preview' }, [img]),
        ]),
        el('div', { class: 'card' }, [
          el('div', { class: 'card-title', text: '解析二维码' }),
          fileInput,
          decResult,
        ]),
      ]),
    );
    gen();
  },
};
