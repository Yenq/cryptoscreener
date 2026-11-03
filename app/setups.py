"""Авто-определение сетапа «пробой уровня».

Уровень — горизонталь, по которой цена несколько раз разворачивалась: касание = локальный экстремум (пивот),
для лонга — максимум (сопротивление), для шорта — минимум (поддержка). Параметры:
  tolerance   — касания должны лежать в пределах этого % друг от друга;
  min_gap / max_gap — расстояние между соседними касаниями, в свечах;
  min_touches — сколько касаний минимум;
  pivot       — сколько свечей по бокам должно быть «ниже» пивота, чтобы он считался касанием;
  lookback    — на сколько свечей назад искать;
  breakout    — на сколько % за уровень цена должна уйти, чтобы это считалось пробоем;
  confirm     — «close»: пробой засчитан по закрытию свечи, «price»: сразу по текущей цене.
Пока уровень не пробит: между первым касанием и пробоем ни одна свеча не закрывалась за уровнем.
Последнее касание должно быть не дальше max_gap свечей от пробоя (уровень «свежий»).
"""
from dataclasses import dataclass


@dataclass
class Params:
    direction: str = "long"  # long — пробой вверх, short — вниз
    tolerance: float = 0.01  # доля
    min_gap: int = 5
    max_gap: int = 500
    min_touches: int = 2
    pivot: int = 2
    lookback: int = 500
    breakout: float = 0.001  # доля
    confirm: str = "close"
    near: float = 0.03  # для режима «формируется»: цена не дальше этой доли от уровня


@dataclass
class Setup:
    direction: str
    status: str  # "breakout" | "forming"
    level: float
    touches: list  # [(time_ms, price)]
    price: float
    distance_pct: float  # на сколько % цена за уровнем (для пробоя > 0) или не дошла до него (формируется < 0)


def _pivots(vals, k):
    """Индексы подтверждённых пивотов (k свечей справа уже закрыты)."""
    out = []
    for i in range(k, len(vals) - k):
        w = vals[i]
        if w >= max(vals[i - k:i]) and w > max(vals[i + 1:i + 1 + k]):
            out.append(i)
    return out


def detect(candles, p: Params, live_price: float | None = None, want: str = "breakout") -> Setup | None:
    """candles — ЗАКРЫТЫЕ свечи [(ts_ms, o, h, l, c, v), ...] по возрастанию времени.
    want="breakout" — ищем состоявшийся пробой, want="forming" — уровень, к которому цена подходит снизу."""
    n = len(candles)
    if n < 2 * p.pivot + 3:
        return None
    sg = 1 if p.direction == "long" else -1
    # приводим к «лонгу»: для шорта зеркалим цены знаком — проценты считаем от |значения|, т.е. от реальной цены
    H = [sg * c[2] if sg == 1 else -c[3] for c in candles]
    C = [sg * c[4] for c in candles]
    T = [c[0] for c in candles]

    if p.confirm == "price" or want == "forming":
        if live_price is None:
            return None
        jb, price = n, sg * live_price  # «текущая» свеча ещё не закрыта
    else:
        jb, price = n - 1, C[n - 1]

    start = max(0, n - p.lookback)
    piv = [i for i in _pivots(H, p.pivot) if i >= start]
    if len(piv) < p.min_touches:
        return None

    best = None
    seen = set()
    for a in reversed(piv[-60:]):  # якорь — верхняя граница полосы касаний
        top = H[a]
        band = [i for i in piv if top - p.tolerance * abs(top) <= H[i] <= top]
        key = tuple(band)
        if len(band) < p.min_touches or key in seen:
            continue
        seen.add(key)
        # самая длинная цепочка касаний с допустимыми расстояниями между соседними
        length, prev = {}, {}
        for x, i in enumerate(band):
            length[i], prev[i] = 1, None
            for k in band[:x]:
                if p.min_gap <= i - k <= p.max_gap and length[k] + 1 > length[i]:
                    length[i], prev[i] = length[k] + 1, k
        for end in band:
            if length[end] < p.min_touches or jb - end > p.max_gap:
                continue
            chain = []
            t = end
            while t is not None:
                chain.append(t)
                t = prev[t]
            chain.reverse()
            level = max(H[i] for i in chain)
            if want == "breakout":
                if not price > level + p.breakout * abs(level):
                    continue
            else:
                if price > level or (level - price) > p.near * abs(level):
                    continue
            # уровень цел: ни одно закрытие после первого касания не было за уровнем
            if any(C[t] > level for t in range(chain[0] + 1, min(jb, n))):
                continue
            cand = (len(chain), end, level, chain)
            if best is None or cand[:2] > best[:2]:
                best = cand
    if best is None:
        return None
    _, _, level, chain = best
    dist = (price - level) / abs(level) * 100
    return Setup(p.direction, want, sg * level, [(T[i], sg * H[i]) for i in chain], sg * price, round(dist, 3))
