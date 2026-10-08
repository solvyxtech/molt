REGIONS = {"US-CA": 725, "US-NY": 400, "US-OR": 0, "DE": 1900, "FR": 2000}


def rate_bps(region):
    if region not in REGIONS:
        raise ValueError("unknown region: " + str(region))
    return REGIONS[region]


def compute_tax(base_cents, region):
    """Tax in cents on base_cents, rounded half up (floor division, so also for credits)."""
    return (base_cents * rate_bps(region) + 5000) // 10000
