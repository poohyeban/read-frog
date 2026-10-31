"""Reproduce the checked-in Mock Provider comparison; no network or model calls."""

import gzip
import json
import math
import statistics
import sys
from pathlib import Path

root = Path(sys.argv[1] if len(sys.argv) > 1 else "docs/lite/subtitle-v2")


def load(name):
    with gzip.open(root / f"{name}.json.gz", "rt") as source:
        return json.load(source)


def percentiles(values):
    values = sorted(value for value in values if value is not None)
    return {
        "observations": len(values),
        "p50": round(statistics.median(values), 4) if values else None,
        "p95": round(values[math.ceil(len(values) * 0.95) - 1], 4) if values else None,
    }


summary = {
    "method": "P50 median, P95 nearest rank; null means no observed ready result, not zero latency",
    "continuity": {},
    "wallClock": {},
}
for revision in ("before", "after", "fast-only", "quality-cache"):
    data = load(f"continuity-{revision}")
    assert not data["errors"]
    rates = {}
    for rate in (1, 2, 4):
        samples = [sample for sample in data["samples"] if sample["rate"] == rate]
        cues = {}
        for index in (1, 2, 3, 5, 10):
            times = [sample["readyAt"][str(index)] for sample in samples]
            deadline = (index - 1) * 2000 / rate
            cues[index] = {
                "readyAtMs": percentiles(times),
                "lateMs": percentiles(
                    [max(0, time - deadline) if time is not None else None for time in times]
                ),
                "beforeDisplayPercent": round(
                    100 * sum(time is not None and time <= deadline for time in times) / len(times), 2
                ),
            }
        windows = {}
        for seconds in (20, 30, 60):
            flags = [
                cue["ready"]
                for sample in samples
                for cue in sample["beforeDisplay"]
                if 1 < cue["index"] and cue["deadlineMs"] <= seconds * 1000
            ]
            windows[seconds] = round(100 * sum(flags) / len(flags), 2)
        rates[rate] = {
            "samples": len(samples),
            "cues": cues,
            "windowBeforeDisplayPercentExcludingInitialCue": windows,
            "mockProcessorStarts": percentiles([sample["requests"] for sample in samples]),
            "mockProcessorCompletions": percentiles([sample["completed"] for sample in samples]),
            "mockProcessorCancellations": percentiles([sample["cancelled"] for sample in samples]),
            "waitingCuesPerMinuteExcludingInitialCue": percentiles(
                [sum(not cue["ready"] for cue in sample["beforeDisplay"] if cue["index"] > 1) for sample in samples]
            ),
            "replayImmediatePercent": round(100 * sum(sample["replayImmediate"] for sample in samples) / len(samples), 2),
            "replayNewPrefetchTasks": percentiles([sample["replayNewTasks"] for sample in samples]),
            "afterStopStarts": sum(sample["afterStopRequests"] for sample in samples),
        }
    summary["continuity"][revision] = rates
    if revision not in ("before", "after"):
        continue
    data = load(f"wall-{revision}")
    assert not data["errors"]
    scenarios = {}
    for name in dict.fromkeys(sample["name"] for sample in data["scenarios"]):
        samples = [sample for sample in data["scenarios"] if sample["name"] == name]
        latencies = []
        for sample in samples:
            first = next((
                published["at"] for published in sample["published"]
                if any(start <= sample["targetTimeMs"] < end for start, end in zip(published["starts"], published["ends"]))
            ), None)
            origin = sample["changedAt"] if name in ("asyncResume", "seekForward", "seekBackward", "rapidSeek", "stopStart") else sample["started"]
            latencies.append(None if first is None else first - origin)
        scenarios[name] = {
            "firstCueReadyMs": percentiles(latencies),
            "mockProcessorStarts": percentiles([sum(event["type"].endswith(":execute") for event in sample["events"]) for sample in samples]),
            "afterStopStarts": sum(event["type"].endswith(":execute") and event["at"] > sample["stopped"] for sample in samples for event in sample["events"]),
        }
    summary["wallClock"][revision] = {
        "scenarios": scenarios,
        "scales": [{
            "cues": scale["size"],
            "lookupMs": percentiles(scale["lookup"]),
            "timeupdateMs": percentiles(scale["timeupdate"]),
            "bulk500Ms": percentiles(scale["bulk500"]),
            "sameCueReactCommits": scale["sameCueCommits"],
            "heapBytes": scale["heapBytes"],
        } for scale in data["scales"]],
    }
summary["budget"] = json.loads((root / "budget-browser.json").read_text())
(root / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(root / "summary.json")
