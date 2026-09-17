import { C } from './config.js';

export async function notify(text) {
  console.log('TG_NOTICE', text.replace(/\n/g, ' | '));
  if (!C.TELEGRAM_BOT_TOKEN || !C.TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${C.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: C.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
    if (!r.ok) throw new Error(`HTTP_${r.status}_${await r.text()}`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.description || 'telegram_error');
    return true;
  } catch (e) {
    console.error('TELEGRAM_SEND_FAIL', e.message);
    return false;
  }
}
