"""run.py's `claim` field says who stood behind each "verified", and old text still parses."""
import sys
from pathlib import Path

LOCAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOCAL))
import run  # noqa: E402
import stats  # noqa: E402

IND = "verified (independent checks: minimax/minimax-m3)"
YOURS = "verified (your checks)"
OWN = "passed own checks (qwen/qwen3-235b-a22b), not verified"


def test_claim_of_carries_the_new_labels():
    assert run.claim_of({"kind": "job_end", "outcome": "verified", "tier": "verified", "claim": IND, "selfChecked": True}) == IND
    assert run.claim_of({"kind": "job_end", "outcome": "verified", "tier": "verified", "claim": YOURS}) == YOURS
    assert run.claim_of({"kind": "job_end", "outcome": "unverified", "tier": "passed-own-checks", "claim": OWN, "selfChecked": True}) == OWN


def test_claim_of_keeps_the_old_text_for_older_builds_and_other_outcomes():
    assert run.claim_of({"outcome": "verified", "selfChecked": True}) == "verified (self-checked)"
    assert run.claim_of({"outcome": "not proven", "selfChecked": True}) == "not proven (self-checked)"
    assert run.claim_of({"outcome": "verified"}) == "verified"
    assert run.claim_of({"outcome": "unverified", "tier": "passed-checks"}) == "unverified"
    assert run.claim_of({}) is None


def test_only_independent_or_person_claims_count_as_verified():
    assert stats.is_verified(IND)
    assert stats.is_verified(YOURS)
    assert not stats.is_verified(OWN)
    assert stats.is_verified("verified (self-checked)"), "old rows read as before"


def test_claim_basis_tells_them_apart_old_and_new():
    assert stats.claim_basis(IND) == "independent"
    assert stats.claim_basis(YOURS) == "person"
    assert stats.claim_basis(OWN) == "own"
    assert stats.claim_basis("verified (self-checked)") == "self-checked"
    assert stats.claim_basis("verified") == "unrecorded"
    assert stats.claim_basis("not proven (self-checked)") is None
    assert stats.claim_basis(None) is None


def test_claim_judge_names_the_judges():
    assert stats.claim_judge(IND) == ["minimax/minimax-m3"]
    assert stats.claim_judge("verified (independent checks: a, b)") == ["a", "b"]
    assert stats.claim_judge(OWN) == []


def test_passed_own_checks_is_a_tier_of_its_own():
    assert "passed-own-checks" in stats.TIERS
    rows = [{"tier": "passed-own-checks", "passed": True}, {"tier": "verified", "passed": False}]
    assert stats.tier_breakdown(rows) == {"passed-own-checks": (1, 1), "verified": (1, 0)}


UNTESTED = "passed checks that did not test this work, not verified"


def test_passed_untested_is_its_own_tier_and_never_verified():
    assert "passed-untested" in stats.TIERS
    assert not stats.is_verified(UNTESTED)
    assert stats.claim_basis(UNTESTED) == "untested"
    assert run.claim_of({"outcome": "unverified", "tier": "passed-untested", "claim": UNTESTED}) == UNTESTED


AUDIT = "verified (post-work audit: qwen3-coder-30b-a3b)"


def test_post_work_audit_label_parses():
    ev = {"kind": "job_end", "outcome": "verified", "tier": "verified-audit", "claim": AUDIT,
          "audit": {"judge": "qwen3-coder-30b-a3b", "drafted": 3, "grounded": 2, "accepted": ["audit:sum"]}}
    assert run.claim_of(ev) == AUDIT
    assert stats.is_verified(AUDIT)
    assert stats.claim_basis(AUDIT) == "audit"
    assert stats.claim_judge(AUDIT) == ["qwen3-coder-30b-a3b"]
    assert "verified-audit" in stats.TIERS
    assert stats.tier_breakdown([{"tier": "verified-audit", "passed": True}]) == {"verified-audit": (1, 1)}
