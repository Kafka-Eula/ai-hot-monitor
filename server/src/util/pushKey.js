/** push_subs 行 → web-push 订阅对象（keys 列以 JSON 字符串存储） */
export function toPushSubscription(endpoint, keys) {
  let parsed = keys;
  if (typeof keys === 'string') {
    try {
      parsed = JSON.parse(keys);
    } catch {
      parsed = {};
    }
  }
  return { endpoint, keys: parsed || {} };
}
