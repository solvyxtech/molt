from datetime import datetime, timezone


def to_dt(ts):
    """Event timestamp (epoch seconds, or an ISO-8601 string) -> datetime."""
    if isinstance(ts, str):
        return datetime.fromisoformat(ts)  # still takes the written wall clock, not the UTC instant
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def day_of(ts):
    return to_dt(ts).strftime("%Y-%m-%d")


def hour_of(ts):
    return to_dt(ts).hour
