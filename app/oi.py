import io
import pickle
from array import array
from bisect import bisect_left, bisect_right

KEEP_MS = 26 * 3600_000  # храним чуть больше суток — хватает на окно 24ч
STEP_MS = 60_000  # одна точка в минуту
WINDOWS = {"oi5m": 5, "oi15m": 15, "oi1h": 60, "oi4h": 240, "oi24h": 1440}


class OiSeries:
    """Открытый интерес монеты (в монетах): минутные точки за ~26 часов."""

    __slots__ = ("ts", "v")

    def __init__(self):
        self.ts = array("q")
        self.v = array("d")

    def add(self, ts: int, v: float):
        if self.ts and ts - self.ts[-1] < STEP_MS:
            self.v[-1] = v  # в пределах минуты просто обновляем значение
            return
        self.ts.append(ts)
        self.v.append(v)
        cut = ts - KEEP_MS
        if self.ts[0] < cut:
            n = bisect_left(self.ts, cut)
            del self.ts[:n]
            del self.v[:n]

    def merge(self, points):
        """Добавляет историю с биржи; свои «живые» точки в приоритете."""
        buckets = {ts // STEP_MS: (ts, v) for ts, v in points}
        buckets.update({ts // STEP_MS: (ts, v) for ts, v in zip(self.ts, self.v)})
        items = sorted(buckets.values())
        if not items:
            return
        cut = items[-1][0] - KEEP_MS
        items = [i for i in items if i[0] >= cut]
        self.ts = array("q", (i[0] for i in items))
        self.v = array("d", (i[1] for i in items))

    def latest(self) -> float | None:
        return self.v[-1] if self.v else None

    def change(self, minutes: int, now_ms: int) -> float | None:
        """Изменение ОИ в монетах за окно, %. None — если данных не хватает."""
        if not self.ts:
            return None
        window = minutes * 60_000
        if now_ms - self.ts[-1] > max(window, 15 * 60_000):
            return None  # данные протухли
        ref = now_ms - window
        i = bisect_right(self.ts, ref) - 1
        if i < 0:
            return None
        # точка до начала окна не должна быть слишком старой (дыра в данных / крупный шаг истории)
        if ref - self.ts[i] > max(330_000, window // 2):
            return None
        base = self.v[i]
        return (self.v[-1] / base - 1) * 100 if base > 0 else None


class _SafeUnpickler(pickle.Unpickler):
    def find_class(self, module, name):  # в файле только словарь из bytes — никаких классов
        raise pickle.UnpicklingError("unexpected object in oi file")


def dump(series: dict[str, OiSeries]) -> bytes:
    return pickle.dumps({k: (s.ts.tobytes(), s.v.tobytes()) for k, s in series.items()}, protocol=4)


def load(data: bytes, now_ms: int) -> dict[str, OiSeries]:
    out = {}
    for key, (ts_b, v_b) in _SafeUnpickler(io.BytesIO(data)).load().items():
        s = OiSeries()
        s.ts.frombytes(ts_b)
        s.v.frombytes(v_b)
        n = bisect_left(s.ts, now_ms - KEEP_MS)
        if n:
            del s.ts[:n]
            del s.v[:n]
        if len(s.ts) == len(s.v) and s.ts:
            out[key] = s
    return out
