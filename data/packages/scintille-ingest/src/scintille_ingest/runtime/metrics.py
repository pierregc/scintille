"""Counters and gauges in the Prometheus text format, which OpenTelemetry collectors scrape."""

from collections import defaultdict


class Metrics:
    def __init__(self) -> None:
        self.counters: defaultdict[tuple[str, tuple[tuple[str, str], ...]], float] = defaultdict(
            float
        )
        self.gauges: dict[tuple[str, tuple[tuple[str, str], ...]], float] = {}

    def inc(self, name: str, value: float = 1, **labels: str) -> None:
        self.counters[(name, tuple(sorted(labels.items())))] += value

    def set(self, name: str, value: float, **labels: str) -> None:
        self.gauges[(name, tuple(sorted(labels.items())))] = value

    def render(self) -> str:
        lines: list[str] = []
        for kind, values in (("counter", self.counters), ("gauge", self.gauges)):
            for name in sorted({n for n, _ in values}):
                lines.append(f"# TYPE {name} {kind}")
                for (n, labels), value in sorted(values.items()):
                    if n == name:
                        label = ",".join(f'{k}="{v}"' for k, v in labels)
                        lines.append(
                            f"{name}{{{label}}} {value:g}" if label else f"{name} {value:g}"
                        )
        return "\n".join(lines) + "\n"
