EU = ("DE", "FR")


def money(cents, region):
    neg = cents < 0
    whole, frac = divmod(abs(cents), 100)
    if region in EU:
        s = f"{whole:,}".replace(",", ".") + "," + f"{frac:02d}" + " €"
    else:
        s = "$" + f"{whole:,}" + "." + f"{frac:02d}"
    return "-" + s if neg else s
