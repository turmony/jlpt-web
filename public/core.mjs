export function adjacentRanges(start, end) {
  if (!/^\d+$/.test(String(start)) || !/^\d+$/.test(String(end))) return null;
  start = Number(start); end = Number(end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 9999) return null;
  const size = end - start + 1;
  return {
    previous: start - size >= 1 ? [start - size, start - 1] : null,
    next: end + size <= 9999 ? [end + 1, end + size] : null,
  };
}

export function selectCards(catalog, level, start, end) {
  if (!/^N[1-5]$/.test(level) || !/^\d+$/.test(String(start)) || !/^\d+$/.test(String(end))) {
    throw new Error('请选择等级，并输入整数编号。');
  }
  start = Number(start);
  end = Number(end);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > 9999) {
    throw new Error('编号须为 1–9999，结束编号不能小于开始编号。');
  }
  const byNumber = new Map(catalog.cards.filter(c => c.level === level).map(c => [c.number, c]));
  const selected = [];
  for (let number = start; number <= end; number++) {
    const card = byNumber.get(number);
    const id = `${level}-G-${String(number).padStart(4, '0')}`;
    if (!card) throw new Error(`未找到 ${id}，请调整区间。`);
    if (!card.images?.connection || !card.images?.example) {
      throw new Error(`${id} 尚未配齐接续与例句图片，请选择其他区间。`);
    }
    selected.push(card);
  }
  return selected;
}

export function createSession(cards, savedId) {
  let index = Math.max(0, cards.findIndex(c => c.id === savedId));
  let side = 'connection';
  return {
    cards,
    get index() { return index; },
    get current() { return cards[index]; },
    get side() { return side; },
    move(delta) {
      const next = Math.max(0, Math.min(cards.length - 1, index + delta));
      if (next !== index) { index = next; side = 'connection'; }
    },
    toggle() { side = side === 'connection' ? 'example' : 'connection'; },
    jump(number) {
      const next = cards.findIndex(c => c.number === Number(number));
      if (next < 0) throw new Error('该编号不在当前区间内。');
      index = next;
      side = 'connection';
    },
  };
}

export function createTapHandler({ single, double, delay = 300 }) {
  let pending = null;
  const cancel = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };
  return {
    cancel,
    start(point) {
      if (pending && Math.hypot(pending.point.x - point.x, pending.point.y - point.y) <= 36) {
        clearTimeout(pending.timer);
      }
    },
    tap(value, point) {
      if (pending) {
        const previous = pending;
        const close = Math.hypot(previous.point.x - point.x, previous.point.y - point.y) <= 36;
        cancel();
        if (close) { double(); return; }
        single(previous.value);
      }
      pending = { value, point, timer: setTimeout(() => {
        pending = null;
        single(value);
      }, delay) };
    },
  };
}
