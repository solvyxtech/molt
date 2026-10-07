from format import EU, money as fmt_money
from tax import compute_tax, rate_bps


def _discount(sub, coupon):
    if coupon == "SAVE10":
        return sub * 10 // 100
    if coupon == "FIVER":
        return 500 if sub >= 2000 else 0
    if coupon is not None and coupon != "":
        raise ValueError("unknown coupon: " + str(coupon))
    return 0


def render(order):
    region = order["region"]
    lines = order["lines"]
    sub = sum(ln["qty"] * ln["cents"] for ln in lines)
    coupon = order.get("coupon")
    disc = _discount(sub, coupon)
    base = sub - disc
    tax = compute_tax(base, region)
    ship = (0 if base >= 5000 else 599) + (300 if region in EU else 0)
    total = base + tax + ship

    def money(c):
        return fmt_money(c, region)

    out = ["INVOICE " + str(order["id"]), "Customer: " + order["customer"], "Region: " + region, "-" * 44]
    for ln in lines:
        desc = ln["desc"]
        if len(desc) > 20:
            desc = desc[:19] + "…"
        out.append(f"{desc:<20} {ln['qty']:>3} x {money(ln['cents']):>10} {money(ln['qty'] * ln['cents']):>12}")
    out.append("-" * 44)
    out.append(f"{'Subtotal':<20}{money(sub):>24}")
    if disc:
        out.append(f"{'Discount (' + coupon + ')':<20}{money(-disc):>24}")
    out.append(f"{'Tax (' + format(rate_bps(region) / 100, 'g') + '%)':<20}{money(tax):>24}")
    out.append(f"{'Shipping':<20}{money(ship):>24}")
    out.append(f"{'TOTAL':<20}{money(total):>24}")
    return "\n".join(out) + "\n"
