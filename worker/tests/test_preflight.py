"""`preflight.delivery_problems` — the check that would have collapsed
2026-09-26's three deploy cycles into one.

Each fault that morning was found by running a job: one attempt, one missing
variable, one redeploy. These assert the opposite property — that **every**
missing variable for every enabled channel is reported at once.
"""

from __future__ import annotations

from licitaqui import preflight

OFF: dict[str, str] = {}

EMAIL_ON = {
    "EMAIL_DELIVERY": "send",
    "AUTH_EMAIL_FROM": "noreply@licitaquiapp.com.br",
    "AUTH_RESEND_KEY": "re_x",
}
WHATSAPP_ON = {
    "WHATSAPP_DELIVERY": "send",
    "EVOLUTION_API_URL": "https://evo.test",
    "EVOLUTION_API_KEY": "k",
    "EVOLUTION_INSTANCE": "i",
}


def test_every_channel_off_is_not_a_problem() -> None:
    """Dry run is the default everywhere — CI, a laptop, a fresh container.

    Demanding credentials for a channel nobody turned on would make the safe
    state the inconvenient one, which is how safe states stop being used.
    """
    assert preflight.delivery_problems(OFF) == []


def test_a_fully_configured_channel_is_not_a_problem() -> None:
    assert preflight.delivery_problems({**EMAIL_ON, **WHATSAPP_ON}) == []


def test_the_exact_morning_of_2026_09_26() -> None:
    """`EMAIL_DELIVERY=send` with neither the sender nor the key.

    Both were found one deploy apart. Here they arrive together, which is the
    whole point of the module.
    """
    problems = preflight.delivery_problems({"EMAIL_DELIVERY": "send"})

    assert len(problems) == 1
    assert "AUTH_EMAIL_FROM" in problems[0]
    assert "AUTH_RESEND_KEY" in problems[0]


def test_either_resend_key_name_satisfies_it() -> None:
    """The worker reads whichever name the web app already has configured, so
    demanding one specific spelling would invent a fault that is not there."""
    base = {"EMAIL_DELIVERY": "send", "AUTH_EMAIL_FROM": "a@b.test"}

    assert preflight.delivery_problems({**base, "AUTH_RESEND_KEY": "re_x"}) == []
    assert preflight.delivery_problems({**base, "RESEND_API_KEY": "re_x"}) == []


def test_two_broken_channels_are_both_reported() -> None:
    problems = preflight.delivery_problems(
        {"EMAIL_DELIVERY": "send", "WHATSAPP_DELIVERY": "send"}
    )

    assert len(problems) == 2
    assert any("WhatsApp" in p and "EVOLUTION_INSTANCE" in p for p in problems)
    assert any("e-mail" in p for p in problems)


def test_a_blank_value_counts_as_unset() -> None:
    """An env block copied with an empty value is the likeliest way to arrive
    here, and `""` would otherwise read as configured."""
    problems = preflight.delivery_problems(
        {"EMAIL_DELIVERY": "send", "AUTH_EMAIL_FROM": "   ", "AUTH_RESEND_KEY": "re_x"}
    )

    assert len(problems) == 1
    assert "AUTH_EMAIL_FROM" in problems[0]


def test_anything_but_the_word_send_leaves_the_channel_off() -> None:
    """The switch fails safe in every direction (`resend.py`'s own reasoning):
    a typo, `1`, `true` and unset all mean dry run, so none of them should
    demand credentials either."""
    for value in ("1", "true", "SEND", "sendd", ""):
        assert preflight.delivery_problems({"EMAIL_DELIVERY": value}) == [], value
