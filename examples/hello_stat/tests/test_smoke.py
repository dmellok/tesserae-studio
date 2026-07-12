"""hello_stat smoke: renders at every declared size with no network call."""

from __future__ import annotations

import pytest
from flask.testing import FlaskClient


@pytest.mark.parametrize("size", ["xs", "sm", "md", "lg"])
def test_hello_stat_renders(client: FlaskClient, size: str) -> None:
    resp = client.get(f"/_test/render?plugin=hello_stat&size={size}")
    assert resp.status_code == 200
