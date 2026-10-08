from datetime import datetime, timezone


def to_dt(ts):
    """Event timestamp (epoch seconds, or an ISO-8601 string) -> aware UTC datetime."""
    if isinstance(ts, str):
        d = datetime.fromisoformat(ts)
        if d.tzinfo is None:
            return d.replace(tzinfo=timezone.utc)
        return d.astimezone(timezone.utc)
    return datetime.fromtimestamp(ts, tz=timezone.utc)


def day_of(ts):
    return to_dt(ts).strftime("%Y-%m-%d")


def hour_of(ts):
    return to_dt(ts).hour
# report.py is left alone: its numeric-timestamp hours are still machine-local
